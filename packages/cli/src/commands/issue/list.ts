/**
 * sentry issue list
 *
 * List issues from Sentry projects.
 * Supports monorepos with multiple detected projects.
 */

import type { SentryContext } from "../../context.js";
import { buildProjectAliasMap } from "../../lib/alias.js";
import {
  API_MAX_PER_PAGE,
  buildIssueListCollapse,
  type IssueCollapseField,
  type IssuesPage,
  listIssuesAllPages,
  listIssuesPaginated,
} from "../../lib/api-client.js";
import { extractRequiredScopes } from "../../lib/api-scope.js";
import {
  looksLikeIssueShortId,
  parseOrgProjectArg,
  rejectIssueCommandTokenListTarget,
} from "../../lib/arg-parsing.js";

import { getActiveEnvVarName, isEnvTokenActive } from "../../lib/db/auth.js";
import {
  advancePaginationState,
  buildMultiTargetContextKey,
  buildPaginationContextKey,
  CURSOR_SEP,
  decodeCompoundCursor,
  decodeTargetCursors,
  encodeCompoundCursor,
  hasPreviousPage,
  resolveCursor,
} from "../../lib/db/pagination.js";
import {
  clearProjectAliases,
  setProjectAliases,
} from "../../lib/db/project-aliases.js";
import { createDsnFingerprint } from "../../lib/dsn/index.js";
import {
  ApiError,
  ContextError,
  toSearchQueryError,
  ValidationError,
  withAuthGuard,
} from "../../lib/errors.js";
import {
  type IssueTableRow,
  shouldAutoCompact,
  writeIssueTable,
} from "../../lib/formatters/index.js";
import {
  CommandOutput,
  type OutputConfig,
} from "../../lib/formatters/output.js";
import {
  buildListCommand,
  buildListLimitFlag,
  LIST_BASE_ALIASES,
  LIST_MAX_LIMIT,
  LIST_TARGET_POSITIONAL,
  paginationHint,
  parseCursorFlag,
  targetPatternExplanation,
} from "../../lib/list-command.js";
import { logger } from "../../lib/logger.js";
import {
  dispatchOrgScopedList,
  distributeFetchBudget,
  type FetchResult as FetchResultOf,
  jsonTransformListResult,
  type ListCommandMeta,
  type ListResult,
  type ModeHandler,
  trimWithGroupGuarantee,
} from "../../lib/org-list.js";
import { withProgress } from "../../lib/polling.js";
import {
  type ProjectSearchTargetResolution,
  type ResolvedTarget,
  resolveProjectBoundTargets,
} from "../../lib/resolve-target.js";
import {
  SEARCH_SYNTAX_REFERENCE,
  sanitizeQuery,
} from "../../lib/search-query.js";
import { isSaaS } from "../../lib/sentry-web-urls.js";
import {
  appendPeriodHint,
  formatTimeRangeFlag,
  PERIOD_BRIEF,
  parsePeriod,
  serializeTimeRange,
  type TimeRange,
  timeRangeToApiParams,
} from "../../lib/time-range.js";
import {
  type SentryIssue,
  SentryIssueSchema,
  type Writer,
} from "../../types/index.js";
import { resolveIssue } from "./utils.js";

/** Command key for pagination cursor storage */
export const PAGINATION_KEY = "issue-list";

type ListFlags = {
  readonly query?: string;
  readonly limit: number;
  readonly sort: "date" | "new" | "freq" | "user" | "recommended";
  readonly period: TimeRange;
  readonly json: boolean;
  readonly cursor?: string;
  readonly fresh: boolean;
  readonly compact?: boolean;
  readonly fields?: string[];
};

/**
 * Raw flags as received by `func()` before the host-dependent sort default is
 * applied. `sort` is optional here because the Stricli flag carries no static
 * default — {@link defaultIssueSort} resolves it. All downstream code uses the
 * resolved {@link ListFlags} where `sort` is concrete.
 */
type ListFlagsInput = Omit<ListFlags, "sort"> & { readonly sort?: SortValue };

/**
 * Extended result type for issue list with display context.
 *
 * Extends {@link ListResult} with rendering metadata needed by the human
 * formatter (pre-built display rows, table options) and by the JSON
 * transform (raw issue data for serialization).
 *
 * Handlers return this type; the `OutputConfig` decides how to render it.
 */
export type IssueListResult = ListResult<SentryIssue> & {
  /** Pre-formatted display rows for the human issue table */
  displayRows?: IssueTableRow[];
  /** Title shown above the table in human output (e.g. "Issues in sentry/cli") */
  title?: string;
  /** Footer mode controlling which usage tip to show after the table */
  footerMode?: "single" | "multi" | "none";
  /** Whether to use compact (single-line) table rendering */
  compact?: boolean;
  /** "More issues available" hint with actionable flags */
  moreHint?: string;
  /** DSN detection or multi-project summary footer */
  footer?: string;
};

/** @internal */ export type SortValue =
  | "date"
  | "new"
  | "freq"
  | "user"
  | "recommended";

const VALID_SORT_VALUES: SortValue[] = [
  "recommended",
  "date",
  "new",
  "freq",
  "user",
];

/**
 * Resolve the effective default sort based on the active Sentry host.
 *
 * `recommended` is a server-computed relevance sort that only exists on recent
 * Sentry versions and is rejected with HTTP 400 by instances that lack it.
 * Sentry SaaS always supports it, so it is the default there; self-hosted
 * instances default to the universally-supported `date` sort. Users can still
 * explicitly request any sort via `--sort`.
 *
 * @returns `"recommended"` on Sentry SaaS, otherwise `"date"`
 */
function defaultIssueSort(): SortValue {
  return isSaaS() ? "recommended" : "date";
}

/** Usage hint for ContextError messages */
const USAGE_HINT = "sentry issue list <org>/<project>";

/** Options returned by {@link buildListApiOptions}. */
type ListApiOptions = {
  /** Fields to collapse (omit) from the API response for performance. */
  collapse: IssueCollapseField[];
  /** Stats period resolution — undefined when stats are collapsed. */
  groupStatsPeriod: "" | "14d" | "24h" | "auto" | undefined;
};

/**
 * Fields stripped by `collapse=lifetime` on the list endpoint. See #969.
 */
const LIFETIME_FIELDS = new Set([
  "count",
  "userCount",
  "firstSeen",
  "lastSeen",
]);

/**
 * Fields populated by Snuba seen-stats queries on the list endpoint.
 *
 * On the Sentry API, `collapse=stats` skips `_get_seen_stats()` entirely,
 * stripping top-level count/timestamp fields and the sparkline `stats` object
 * — not just the TREND column data. See #1219.
 */
const SEEN_STATS_FIELDS = new Set([...LIFETIME_FIELDS, "stats"]);

/**
 * Whether collapse is safe for a `--fields` subset — true when explicit fields
 * were requested and none depend on the given API data.
 */
function shouldCollapseForFields(
  fields: string[] | undefined,
  dependentFields: ReadonlySet<string>
): boolean {
  return (
    fields !== undefined &&
    fields.length > 0 &&
    !fields.some((f) => dependentFields.has(f))
  );
}

/**
 * Determine whether stats data should be collapsed (skipped) in the API request.
 *
 * Collapsing stats saves ~200–500ms per Snuba query but also removes basic issue
 * metadata. Human output never collapses stats; JSON only opts out via `--fields`.
 */
function shouldCollapseStats(json: boolean, fields?: string[]): boolean {
  return json && shouldCollapseForFields(fields, SEEN_STATS_FIELDS);
}

/**
 * Build the collapse and groupStatsPeriod options for issue list API calls.
 *
 * When stats are collapsed, groupStatsPeriod is omitted (undefined) since
 * the server won't compute stats anyway. This avoids wasted server-side
 * processing and makes the request intent explicit.
 *
 * Stats and lifetime are only collapsed in JSON mode with explicit `--fields`
 * that omit the corresponding dependent fields. Human output always requests
 * seen-stats data for the EVENTS, USERS, SEEN, and AGE columns.
 */
function buildListApiOptions(json: boolean, fields?: string[]): ListApiOptions {
  const collapseStats = shouldCollapseStats(json, fields);
  const collapseLifetime =
    json && shouldCollapseForFields(fields, LIFETIME_FIELDS);
  return {
    collapse: buildIssueListCollapse({
      shouldCollapseStats: collapseStats,
      shouldCollapseLifetime: collapseLifetime,
    }),
    groupStatsPeriod: collapseStats ? undefined : "auto",
  };
}

/**
 * Resolve the effective compact mode from the flag tri-state and issue count.
 *
 * - `true` / `false` — explicit user override, returned as-is
 * - `undefined` — auto-detect based on terminal height vs estimated table height
 */
function resolveCompact(flag: boolean | undefined, rowCount: number): boolean {
  if (flag !== undefined) {
    return flag;
  }
  return shouldAutoCompact(rowCount);
}

function parseSort(value: string): SortValue {
  if (!VALID_SORT_VALUES.includes(value as SortValue)) {
    throw new Error(
      `Invalid sort value. Must be one of: ${VALID_SORT_VALUES.join(", ")}`
    );
  }
  return value as SortValue;
}

// Query sanitization (AND/OR handling) is in src/lib/search-query.ts

/**
 * Format the issue list header with column titles.
 *
 * @param title - Section title
 */
function formatListHeader(title: string): string {
  return `${title}:\n\n`;
}

/**
 * Format footer with usage tip.
 *
 * @param mode - Display mode: 'single' (one project), 'multi' (multiple projects), or 'none'
 */
function formatListFooter(mode: "single" | "multi" | "none"): string {
  switch (mode) {
    case "single":
      return "\nTip: Use 'sentry issue view <ID>' to view details (bold part works as shorthand).";
    case "multi":
      return "\nTip: Use 'sentry issue view <ALIAS>' to view details (see ALIAS column).";
    default:
      return "\nTip: Use 'sentry issue view <SHORT_ID>' to view issue details.";
  }
}

/** Issue list with target context */
/** @internal */ export type IssueListFetchResult = {
  target: ResolvedTarget;
  issues: SentryIssue[];
  /** Whether the project has more issues beyond what was fetched. */
  hasMore?: boolean;
  /** Cursor to resume fetching from this project (for Phase 2 / next page). */
  nextCursor?: string;
};

/**
 * Attach formatting options to each issue based on alias map.
 *
 * @param results - Issue list results with targets
 * @param aliasMap - Map from "org:project" to alias
 * @param isMultiProject - Whether in multi-project mode (shows ALIAS column)
 */
function attachFormatOptions(
  results: IssueListFetchResult[],
  aliasMap: Map<string, string>,
  isMultiProject: boolean
): IssueTableRow[] {
  return results.flatMap((result) =>
    result.issues.map((issue) => {
      const key = `${result.target.org}/${result.target.project}`;
      const alias = aliasMap.get(key);
      return {
        issue,
        orgSlug: result.target.org,
        formatOptions: {
          projectSlug: result.target.project,
          projectAlias: alias,
          isMultiProject,
        },
      };
    })
  );
}

/**
 * Compare two optional date strings (most recent first).
 */
function compareDates(a: string | undefined, b: string | undefined): number {
  const dateA = a ? new Date(a).getTime() : 0;
  const dateB = b ? new Date(b).getTime() : 0;
  return dateB - dateA;
}

/**
 * Get comparator function for the specified sort option.
 *
 * @param sort - Sort option from CLI flags
 * @returns Comparator function for Array.sort()
 */
function getComparator(
  sort: SortValue
): (a: SentryIssue, b: SentryIssue) => number {
  switch (sort) {
    case "date":
      return (a, b) =>
        compareDates(a.lastSeen ?? undefined, b.lastSeen ?? undefined);
    case "new":
      return (a, b) =>
        compareDates(a.firstSeen ?? undefined, b.firstSeen ?? undefined);
    case "freq":
      return (a, b) =>
        Number.parseInt(b.count ?? "0", 10) -
        Number.parseInt(a.count ?? "0", 10);
    case "user":
      return (a, b) => (b.userCount ?? 0) - (a.userCount ?? 0);
    case "recommended":
      // The recommended relevance score is computed server-side and is not
      // present in the issue payload, so it cannot be reproduced client-side.
      // When merging results across projects, fall back to recency (lastSeen);
      // single-project results are already server-sorted by recommended.
      return (a, b) =>
        compareDates(a.lastSeen ?? undefined, b.lastSeen ?? undefined);
    default:
      return (a, b) =>
        compareDates(a.lastSeen ?? undefined, b.lastSeen ?? undefined);
  }
}

type FetchResult = FetchResultOf<IssueListFetchResult>;

/**
 * Fetch issues for a single target project.
 *
 * @param target - Resolved org/project target
 * @param options - Query options (query, limit, sort, optional resume cursor)
 * @returns Success with issues + pagination state, or failure with error preserved
 * @throws {AuthError} When user is not authenticated
 */
async function fetchIssuesForTarget(
  target: ResolvedTarget,
  options: {
    query?: string;
    limit: number;
    sort: SortValue;
    statsPeriod?: string;
    /** Absolute start datetime (ISO-8601). Mutually exclusive with statsPeriod. */
    start?: string;
    /** Absolute end datetime (ISO-8601). Mutually exclusive with statsPeriod. */
    end?: string;
    /** Resume from this cursor (Phase 2 redistribution or next-page resume). */
    startCursor?: string;
    onPage?: (fetched: number, limit: number) => void;
    /** Pre-computed API performance options. @see {@link buildListApiOptions} */
    collapse?: IssueCollapseField[];
    /** Stats period resolution — undefined when stats are collapsed. */
    groupStatsPeriod?: "" | "14d" | "24h" | "auto";
  }
): Promise<FetchResult> {
  const result = await withAuthGuard(async () => {
    const { issues, nextCursor } = await listIssuesAllPages(
      target.org,
      target.project,
      {
        ...options,
        projectId: target.projectId,
        groupStatsPeriod: options.groupStatsPeriod,
        start: options.start,
        end: options.end,
      }
    );
    return { target, issues, hasMore: !!nextCursor, nextCursor };
  });

  if (!result.ok) {
    const error =
      result.error instanceof Error
        ? result.error
        : new Error(String(result.error));
    return { success: false, error };
  }
  return { success: true, data: result.value };
}

/**
 * Execute Phase 2 of the budget fetch: redistribute surplus to expandable targets
 * and merge the additional results back into `phase1` in place.
 */
async function runPhase2(
  targets: ResolvedTarget[],
  phase1: FetchResult[],
  expandableIndices: number[],
  context: {
    surplus: number;
    options: Omit<BudgetFetchOptions, "limit" | "startCursors">;
  }
): Promise<void> {
  const { surplus, options } = context;
  const extraQuotas = distributeFetchBudget(surplus, expandableIndices.length);
  const requests = expandableIndices
    .map((targetIndex, allocationIndex) => ({
      targetIndex,
      limit: extraQuotas[allocationIndex] ?? 0,
    }))
    .filter((request) => request.limit > 0);

  if (requests.length === 0) {
    return;
  }

  const phase2 = await Promise.all(
    requests.map(({ targetIndex, limit }) => {
      // expandableIndices only contains indices where r.success && r.data.nextCursor
      // biome-ignore lint/style/noNonNullAssertion: guaranteed by expandableIndices filter
      const target = targets[targetIndex]!;
      const r = phase1[targetIndex] as {
        success: true;
        data: IssueListFetchResult;
      };
      // biome-ignore lint/style/noNonNullAssertion: same guarantee
      const cursor = r.data.nextCursor!;
      return fetchIssuesForTarget(target, {
        ...options,
        limit,
        startCursor: cursor,
      });
    })
  );

  for (let j = 0; j < requests.length; j++) {
    // biome-ignore lint/style/noNonNullAssertion: j is within requests bounds
    const i = requests[j]!.targetIndex;
    const p2 = phase2[j];
    const p1 = phase1[i];
    if (p1?.success && p2?.success) {
      p1.data.issues.push(...p2.data.issues);
      p1.data.hasMore = p2.data.hasMore;
      p1.data.nextCursor = p2.data.nextCursor;
    }
  }
}

/**
 * Options for {@link fetchWithBudget}.
 */
type BudgetFetchOptions = {
  query?: string;
  limit: number;
  sort: SortValue;
  statsPeriod?: string;
  /** Absolute start datetime (ISO-8601). Mutually exclusive with statsPeriod. */
  start?: string;
  /** Absolute end datetime (ISO-8601). Mutually exclusive with statsPeriod. */
  end?: string;
  /** Per-target cursors from a previous page (compound cursor resume). */
  startCursors?: Map<string, string>;
  /** Pre-computed collapse fields for API performance. @see {@link buildListApiOptions} */
  collapse?: IssueCollapseField[];
  /** Stats period resolution — undefined when stats are collapsed. */
  groupStatsPeriod?: "" | "14d" | "24h" | "auto";
};

/**
 * Fetch issues from multiple targets within a global limit budget.
 *
 * Uses a two-phase strategy:
 * 1. Phase 1: distribute the global limit across targets and fetch in parallel.
 * 2. Phase 2: if total fetched < limit and some targets have more, redistribute
 *    the surplus among those expandable targets and fetch one more page each.
 *
 * Targets with a `startCursor` in `options.startCursors` resume from that cursor
 * instead of starting fresh — used for compound cursor pagination (−c next / −c prev).
 *
 * @param targets - Resolved org/project targets to fetch from
 * @param options - Query + budget options
 * @param onProgress - Called after Phase 1 and Phase 2 with total fetched so far
 * @returns Merged fetch results and whether any target has further pages
 */
async function fetchWithBudget(
  targets: ResolvedTarget[],
  options: BudgetFetchOptions,
  onProgress: (fetched: number) => void
): Promise<{ results: FetchResult[]; hasMore: boolean }> {
  const { limit, startCursors } = options;
  const quotas = distributeFetchBudget(limit, targets.length, {
    minimumPerGroup: true,
  });

  // Phase 1: fetch quota from each target in parallel
  const phase1 = await Promise.all(
    targets.map((t, i) =>
      fetchIssuesForTarget(t, {
        ...options,
        limit: quotas[i] ?? 1,
        startCursor: startCursors?.get(`${t.org}/${t.project}`),
      })
    )
  );

  let totalFetched = 0;
  for (const r of phase1) {
    if (r.success) {
      totalFetched += r.data.issues.length;
    }
  }
  onProgress(totalFetched);

  const surplus = limit - totalFetched;
  if (surplus <= 0) {
    return {
      results: phase1,
      hasMore: phase1.some((r) => r.success && r.data.hasMore),
    };
  }

  // Identify targets that hit their quota and have a cursor to continue
  const expandableIndices: number[] = [];
  for (let i = 0; i < phase1.length; i++) {
    const r = phase1[i];
    if (
      r?.success &&
      r.data.issues.length >= (quotas[i] ?? 1) &&
      r.data.nextCursor
    ) {
      expandableIndices.push(i);
    }
  }

  if (expandableIndices.length === 0) {
    return {
      results: phase1,
      hasMore: phase1.some((r) => r.success && r.data.hasMore),
    };
  }

  await runPhase2(targets, phase1, expandableIndices, { surplus, options });

  totalFetched = 0;
  for (const r of phase1) {
    if (r.success) {
      totalFetched += r.data.issues.length;
    }
  }
  onProgress(totalFetched);

  return {
    results: phase1,
    hasMore: phase1.some((r) => r.success && r.data.hasMore),
  };
}

/**
 * Trim issues to the global limit while guaranteeing at least one issue per
 * project. Thin wrapper around {@link trimWithGroupGuarantee} for `IssueTableRow`.
 */
function trimWithProjectGuarantee(
  issues: IssueTableRow[],
  limit: number
): IssueTableRow[] {
  return trimWithGroupGuarantee(
    issues,
    limit,
    (r) => `${r.orgSlug}/${r.formatOptions.projectSlug ?? ""}`
  );
}

/** Build the CLI hint for fetching the next page, preserving active flags. */
/** Append active non-default issue list flags to a base command string. */
function appendIssueFlags(base: string, flags: ListFlags): string {
  const parts: string[] = [];
  if (flags.sort !== defaultIssueSort()) {
    parts.push(`--sort ${flags.sort}`);
  }
  if (flags.query) {
    parts.push(`-q "${flags.query}"`);
  }
  appendPeriodHint(parts, flags.period, DEFAULT_PERIOD, "-t");
  return parts.length > 0 ? `${base} ${parts.join(" ")}` : base;
}

function nextPageHint(org: string, flags: ListFlags): string {
  return appendIssueFlags(`sentry issue list ${org}/ -c next`, flags);
}

function prevPageHint(org: string, flags: ListFlags): string {
  return appendIssueFlags(`sentry issue list ${org}/ -c prev`, flags);
}

/**
 * Fetch org-wide issues, auto-paginating from the start or resuming from a cursor.
 *
 * When `cursor` is provided (--cursor resume), fetches a single page to keep the
 * cursor chain intact. Otherwise auto-paginates up to the requested limit.
 */
async function fetchOrgAllIssues(
  org: string,
  flags: Pick<ListFlags, "query" | "limit" | "sort" | "json" | "fields">,
  timeRange: TimeRange,
  options: {
    cursor?: string;
    onPage?: (fetched: number, limit: number) => void;
  }
): Promise<IssuesPage> {
  const apiOpts = buildListApiOptions(flags.json, flags.fields);
  const timeParams = timeRangeToApiParams(timeRange);
  const { cursor, onPage } = options;

  // When resuming with --cursor, fetch a single page so the cursor chain stays intact.
  if (cursor) {
    const perPage = Math.min(flags.limit, API_MAX_PER_PAGE);
    const response = await listIssuesPaginated(org, "", {
      query: flags.query,
      cursor,
      perPage,
      sort: flags.sort,
      ...timeParams,
      groupStatsPeriod: apiOpts.groupStatsPeriod,
      collapse: apiOpts.collapse,
    });
    return { issues: response.data, nextCursor: response.nextCursor };
  }

  // No cursor — auto-paginate from the beginning via the shared helper.
  const { issues, nextCursor } = await listIssuesAllPages(org, "", {
    query: flags.query,
    limit: flags.limit,
    sort: flags.sort,
    ...timeParams,
    groupStatsPeriod: apiOpts.groupStatsPeriod,
    collapse: apiOpts.collapse,
    onPage,
  });
  return { issues, nextCursor };
}

/** Options for {@link handleOrgAllIssues}. */
type OrgAllIssuesOptions = {
  org: string;
  flags: ListFlags;
  timeRange: TimeRange;
};

/**
 * Handle org-all mode for issues: cursor-paginated listing of all issues in an org.
 *
 * Uses a sort+query-aware context key so cursors from different searches are
 * never accidentally reused. Returns an {@link IssueListResult} — the caller
 * is responsible for rendering (JSON or human output).
 */
async function handleOrgAllIssues(
  options: OrgAllIssuesOptions
): Promise<IssueListResult> {
  const { org, flags, timeRange } = options;
  // Encode sort + query in context key so cursors from different searches don't collide.
  const contextKey = buildPaginationContextKey("org", org, {
    sort: flags.sort,
    period: serializeTimeRange(timeRange),
    q: flags.query,
  });
  const { cursor, direction } = resolveCursor(
    flags.cursor,
    PAGINATION_KEY,
    contextKey
  );

  let issuesResult: IssuesPage;
  try {
    issuesResult = await withProgress(
      {
        message: `Fetching issues (up to ${flags.limit})...`,
        json: flags.json,
      },
      (setMessage) =>
        fetchOrgAllIssues(org, flags, timeRange, {
          cursor,
          onPage: (fetched, limit) =>
            setMessage(
              `Fetching issues, ${fetched} and counting (up to ${limit})...`
            ),
        })
    );
  } catch (error) {
    throw enrichIssueListError(error, flags);
  }
  const { issues, nextCursor } = issuesResult;

  advancePaginationState(PAGINATION_KEY, contextKey, direction, nextCursor);

  const hasMore = !!nextCursor;
  const hasPrev = hasPreviousPage(PAGINATION_KEY, contextKey);

  if (issues.length === 0) {
    const nav = paginationHint({
      hasPrev,
      hasMore,
      prevHint: prevPageHint(org, flags),
      nextHint: nextPageHint(org, flags),
    });
    const hint = nav
      ? `No issues on this page. ${nav}`
      : `No issues found in organization '${org}'.`;
    return { items: [], hasMore, hasPrev, nextCursor, hint };
  }

  // isMultiProject=true: org-all shows issues from every project, so the ALIAS
  // column is needed to identify which project each issue belongs to.
  const displayRows: IssueTableRow[] = issues.map((issue) => ({
    issue,
    // org-all: org context comes from the `org` param; issue.organization may be absent
    orgSlug: org,
    formatOptions: {
      projectSlug: issue.project?.slug ?? "",
      isMultiProject: true,
    },
  }));

  const nav = paginationHint({
    hasPrev,
    hasMore,
    prevHint: prevPageHint(org, flags),
    nextHint: nextPageHint(org, flags),
  });
  const hintParts: string[] = [];
  if (hasMore) {
    hintParts.push(`Showing ${issues.length} issues (more available)`);
  } else {
    hintParts.push(`Showing ${issues.length} issues`);
  }
  if (nav) {
    hintParts.push(nav);
  }

  return {
    items: issues,
    hasMore,
    hasPrev,
    nextCursor,
    hint: hintParts.join("\n"),
    displayRows,
    title: `Issues in ${org}`,
    compact: resolveCompact(flags.compact, displayRows.length),
  };
}

/** Options for {@link handleResolvedTargets}. */
type ResolvedTargetsOptions = {
  parsed: ReturnType<typeof parseOrgProjectArg>;
  flags: ListFlags;
  cwd: string;
  timeRange: TimeRange;
  projectSearchResolution?: ProjectSearchTargetResolution;
};

/** Default --period value (used to detect user-implicit vs explicit). */
const DEFAULT_PERIOD = "90d";

/**
 * Matches the Sentry API's unsupported-sort 400 detail
 * ("Sort key '<x>' not supported."). Used to give a sort-specific hint when
 * `--sort recommended` hits an older self-hosted instance.
 */
const UNSUPPORTED_SORT_RE = /sort key/i;

/**
 * Build an enriched error detail for 400 Bad Request responses.
 *
 * Appends actionable suggestions so users know what to try next. This is the
 * most common class of API error in `issue list` (CLI-BM, CLI-7B) — the Sentry
 * API rejects the request due to query syntax or parameter issues, but the raw
 * "400 Bad Request" message alone doesn't guide the user to a fix.
 *
 * @param originalDetail - The API response detail (may be undefined)
 * @param flags - Current command flags for context-aware hints
 * @returns Enhanced detail string with suggestions
 */
function build400Detail(
  originalDetail: string | undefined,
  flags: Pick<ListFlags, "query" | "period" | "sort">
): string {
  const lines: string[] = [];

  if (originalDetail) {
    lines.push(originalDetail);
  }

  const suggestions: string[] = [];

  // The Sentry API rejects an unknown sort with "Sort key '<x>' not supported."
  // This is the expected failure when `--sort recommended` is used against an
  // older self-hosted instance that predates the recommended sort. A
  // sort-specific hint is far more actionable than the generic
  // query/time-range/access suggestions, so short-circuit on it.
  if (originalDetail && UNSUPPORTED_SORT_RE.test(originalDetail)) {
    suggestions.push(
      `This Sentry instance does not support the '${flags.sort}' sort. Use a widely-supported sort such as --sort date (the 'recommended' sort requires a recent Sentry version).`
    );
    return formatDetailWithSuggestions(lines, suggestions);
  }

  if (flags.query) {
    suggestions.push(
      "Check your --query syntax (Sentry search reference: https://docs.sentry.io/concepts/search/)"
    );
  }

  if (formatTimeRangeFlag(flags.period) === DEFAULT_PERIOD) {
    suggestions.push("Try a shorter time range: --period 14d or --period 24h");
  }

  suggestions.push(
    "Verify you have access to the target project: sentry project list <org>/"
  );

  return formatDetailWithSuggestions(lines, suggestions);
}

/**
 * Join an optional detail line with a bulleted "Suggestions:" block.
 *
 * Adds a blank separator only when a detail line precedes the suggestions.
 * The output is indented with `"\n  "` because {@link ApiError.format}
 * prepends `"\n  "` only before the first detail line; continuation lines
 * must match that indentation to stay aligned.
 */
function formatDetailWithSuggestions(
  detailLines: string[],
  suggestions: string[]
): string {
  const lines = [...detailLines];
  if (lines.length > 0) {
    lines.push("");
  }
  lines.push("Suggestions:");
  for (const s of suggestions) {
    lines.push(`  • ${s}`);
  }
  return lines.join("\n  ");
}

/**
 * Enrich an API error from issue listing with actionable suggestions.
 *
 * Handles both 400 (query/parameter) and 403 (permission) errors.
 * Re-throws non-ApiError and unhandled statuses unchanged.
 */
function enrichIssueListError(
  error: unknown,
  flags: Pick<ListFlags, "query" | "period" | "sort">
): never {
  // A user-supplied --query the server cannot parse is a user input mistake,
  // not a CLI bug: surface it as a ValidationError. A 400 with no user --query
  // (the CLI built a bad query) falls through and stays a reported ApiError.
  const queryError = toSearchQueryError(error, flags.query);
  if (queryError !== error) {
    throw queryError;
  }
  if (error instanceof ApiError) {
    if (error.status === 400) {
      throw new ApiError(
        error.message,
        error.status,
        build400Detail(error.detail, flags),
        error.endpoint
      );
    }
    if (error.status === 403) {
      // Centralized 403 enrichment (infrastructure.ts) already added
      // scope/token hints. Only append the project-membership hint.
      const detail = error.enriched403
        ? appendProjectMembershipHint(error.detail)
        : build403Detail(error.detail);
      throw new ApiError(
        error.message,
        error.status,
        detail,
        error.endpoint,
        true
      );
    }
  }
  throw error;
}

/**
 * Default scopes mentioned when the API response doesn't tell us which
 * scope is missing. These are the minimum the issue-list endpoint needs
 * — surfaced verbatim from the previous hardcoded message so the
 * fallback behavior matches the pre-fix UX.
 */
const DEFAULT_ISSUE_LIST_SCOPES = "org:read, project:read";

/**
 * Build an enriched error detail for 403 Forbidden responses.
 *
 * Only mentions token scopes when using a custom env-var token
 * (SENTRY_AUTH_TOKEN / SENTRY_TOKEN) since the regular `sentry auth login`
 * OAuth flow always grants the required scopes.
 *
 * When the API's detail payload names the required scope(s) explicitly
 * (see {@link extractRequiredScopes}) we surface that list instead of
 * the hardcoded default — this is the fix for getsentry/cli#785 item #9
 * where a token missing `event:read` was told it might be missing
 * `org:read, project:read` (which it actually had).
 *
 * @param originalDetail - The API response detail (may be undefined)
 * @returns Enhanced detail string with suggestions
 */
function build403Detail(originalDetail: unknown): string {
  const lines: string[] = [];

  if (typeof originalDetail === "string" && originalDetail) {
    lines.push(originalDetail, "");
  }

  lines.push("Suggestions:");

  if (isEnvTokenActive()) {
    const scopes = extractRequiredScopes(originalDetail);
    const scopeList =
      scopes.length > 0 ? scopes.join(", ") : DEFAULT_ISSUE_LIST_SCOPES;
    // When the API was explicit about what's missing, frame the hint
    // as a definite statement ("is missing") rather than a hedged
    // "may lack" — this is the user-visible payoff of parsing the
    // response.
    const leader =
      scopes.length > 0
        ? `Your ${getActiveEnvVarName()} token is missing the required scope(s)`
        : `Your ${getActiveEnvVarName()} token may lack the required scopes`;
    lines.push(
      `  • ${leader} (${scopeList})`,
      "  • Check token scopes at: https://sentry.io/settings/account/api/auth-tokens/"
    );
  } else {
    lines.push("  • Re-authenticate with: sentry auth login");
  }

  lines.push("  • Verify project membership: sentry project list <org>/");

  return lines.join("\n  ");
}

/**
 * Append a project membership verification hint to an already-enriched
 * 403 detail string. Used when centralized enrichment (infrastructure.ts)
 * has already added scope/token hints and we only need the issue-list-specific
 * suggestion.
 */
function appendProjectMembershipHint(detail: string | undefined): string {
  const base = detail ?? "You do not have permission to perform this action.";
  return `${base}\n  Verify project membership: sentry project list <org>/`;
}

/**
 * Handle auto-detect, explicit, and project-search modes.
 *
 * All three share the same flow: resolve targets → fetch issues within the
 * global limit budget → merge → trim with project guarantee → display.
 * Cursor pagination uses a compound cursor (one cursor per project, encoded
 * as a pipe-separated string) so `-c next` / `-c prev` works across multi-target results.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: inherent multi-target resolution, compound cursor, error handling, and display logic
async function handleResolvedTargets(
  options: ResolvedTargetsOptions
): Promise<IssueListResult> {
  const { parsed, flags, cwd, timeRange, projectSearchResolution } = options;

  const { targets, footer, skippedSelfHosted, detectedDsns } =
    await resolveProjectBoundTargets(parsed, {
      cwd,
      usageHint: USAGE_HINT,
      projectSearchResolution,
      enrichProjectIds: true,
      checkIssueShortId: true,
    });

  if (targets.length === 0) {
    if (skippedSelfHosted) {
      throw new ContextError(
        "Organization and project",
        USAGE_HINT,
        undefined,
        `Found ${skippedSelfHosted} DSN(s) that could not be resolved — you may not have access to these projects`
      );
    }
    throw new ContextError("Organization and project", USAGE_HINT);
  }

  // Build a compound cursor context key that encodes the full target set +
  // search parameters so a cursor from one search is never reused for another.
  const contextKey = buildMultiTargetContextKey(targets, {
    sort: flags.sort,
    query: flags.query,
    period: serializeTimeRange(timeRange),
  });

  // Resolve per-target start cursors from the stored compound cursor (--cursor resume).
  // Sorted target keys must match the order used in buildMultiTargetContextKey.
  const sortedTargetKeys = targets.map((t) => `${t.org}/${t.project}`).sort();
  const { cursor: rawCursor, direction } = resolveCursor(
    flags.cursor,
    PAGINATION_KEY,
    contextKey
  );
  const { startCursors, exhausted: exhaustedTargets } = decodeTargetCursors(
    rawCursor,
    sortedTargetKeys
  );

  const activeTargets =
    exhaustedTargets.size > 0
      ? targets.filter((t) => !exhaustedTargets.has(`${t.org}/${t.project}`))
      : targets;

  const targetCount = activeTargets.length;
  const baseMessage =
    targetCount > 1
      ? `Fetching issues from ${targetCount} projects`
      : "Fetching issues";

  const apiOpts = buildListApiOptions(flags.json, flags.fields);

  const { results, hasMore } = await withProgress(
    { message: `${baseMessage} (up to ${flags.limit})...`, json: flags.json },
    (setMessage) =>
      fetchWithBudget(
        activeTargets,
        {
          query: flags.query,
          limit: flags.limit,
          sort: flags.sort,
          ...timeRangeToApiParams(timeRange),
          startCursors,
          collapse: apiOpts.collapse,
          groupStatsPeriod: apiOpts.groupStatsPeriod,
        },
        (fetched) => {
          setMessage(
            `${baseMessage}, ${fetched} and counting (up to ${flags.limit})...`
          );
        }
      )
  );

  const validResults: IssueListFetchResult[] = [];
  const failures: { target: ResolvedTarget; error: Error }[] = [];

  for (let i = 0; i < results.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: index within bounds
    const result = results[i]!;
    if (result.success) {
      validResults.push(result.data);
    } else {
      // biome-ignore lint/style/noNonNullAssertion: index within bounds
      failures.push({ target: activeTargets[i]!, error: result.error });
    }
  }

  if (validResults.length === 0 && failures.length > 0) {
    // biome-ignore lint/style/noNonNullAssertion: guarded by failures.length > 0
    const { error: first } = failures[0]!;
    const prefix = `Failed to fetch issues from ${targets.length} project(s)`;

    // A user-supplied --query the server cannot parse is a user input mistake,
    // not a CLI bug — surface it as a ValidationError before wrapping as a
    // multi-project ApiError. CLI-authored 400s fall through and stay reported.
    const queryError = toSearchQueryError(first, flags.query);
    if (queryError !== first) {
      throw queryError;
    }

    // Propagate ApiError so telemetry sees the original status code.
    // For 400 errors, append actionable suggestions since the user's query
    // or parameters are likely malformed. Common causes: invalid Sentry
    // search syntax, unsupported period for the org's data retention.
    if (first instanceof ApiError) {
      let detail = first.detail;
      if (first.status === 400) {
        detail = build400Detail(first.detail, flags);
      } else if (first.status === 403) {
        detail = first.enriched403
          ? appendProjectMembershipHint(first.detail)
          : build403Detail(first.detail);
      }
      throw new ApiError(
        `${prefix}: ${first.message}`,
        first.status,
        detail,
        first.endpoint,
        first.enriched403 || first.status === 403
      );
    }

    throw new Error(`${prefix}: ${first.message}`);
  }

  const isMultiProject = validResults.length > 1;
  const isSingleProject = validResults.length === 1;
  const firstTarget = validResults[0]?.target;

  const { aliasMap, entries } = isMultiProject
    ? buildProjectAliasMap(validResults)
    : { aliasMap: new Map<string, string>(), entries: {} };

  if (isMultiProject) {
    const fingerprint = createDsnFingerprint(detectedDsns ?? []);
    setProjectAliases(entries, fingerprint);
  } else {
    clearProjectAliases();
  }

  const allIssuesWithOptions = attachFormatOptions(
    validResults,
    aliasMap,
    isMultiProject
  );

  // Only re-sort when merging results from multiple separately-fetched
  // projects — a client-side comparator is required to interleave them into a
  // single ordered list. Single-project (and org-all) responses are already
  // ordered by the server for the requested sort, so we must preserve that
  // order. This matters for `recommended`, whose relevance score is not in the
  // payload and therefore cannot be reproduced client-side: re-sorting would
  // silently replace the server's ranking with a `lastSeen` fallback.
  if (isMultiProject) {
    allIssuesWithOptions.sort((a, b) =>
      getComparator(flags.sort)(a.issue, b.issue)
    );
  }

  // Trim to the global limit with project representation guarantee
  const issuesWithOptions = trimWithProjectGuarantee(
    allIssuesWithOptions,
    flags.limit
  );
  const trimmed = issuesWithOptions.length < allIssuesWithOptions.length;
  // Store compound cursor only after display trimming is known. If rows were
  // fetched but not displayed, a stored next cursor would skip those rows.
  const cursorValues: (string | null)[] = sortedTargetKeys.map((key) => {
    // Exhausted targets from previous page stay exhausted
    if (exhaustedTargets.has(key)) {
      return null;
    }
    const result = results.find((r) => {
      if (!r.success) {
        return false;
      }
      return `${r.data.target.org}/${r.data.target.project}` === key;
    });
    if (result?.success) {
      // Successful fetch: null = exhausted (no more pages), string = has more
      return result.data.nextCursor ?? null;
    }
    // Target failed this fetch — preserve the cursor it was given so the next
    // `-c next` retries from the same position rather than skipping it entirely.
    // If no start cursor was given (first-page failure), null means not retried
    // via cursor; the user can run without -c next to restart all projects.
    return startCursors.get(key) ?? null;
  });
  const hasAnyCursor = cursorValues.some((c) => c !== null);
  const hasMoreToShow = hasMore || hasAnyCursor || trimmed;
  const canPaginate = hasAnyCursor && !trimmed;
  const compoundNextCursor = canPaginate
    ? encodeCompoundCursor(cursorValues)
    : undefined;
  advancePaginationState(
    PAGINATION_KEY,
    contextKey,
    direction,
    compoundNextCursor
  );
  const hasPrev = hasPreviousPage(PAGINATION_KEY, contextKey);

  const allIssues = issuesWithOptions.map((i) => i.issue);

  const errors =
    failures.length > 0
      ? failures.map(({ target: t, error: e }) =>
          e instanceof ApiError
            ? {
                project: `${t.org}/${t.project}`,
                status: e.status,
                message: e.message,
              }
            : { project: `${t.org}/${t.project}`, message: e.message }
        )
      : undefined;

  // Write partial-failure note to stderr (side effect for progress/warnings)
  if (failures.length > 0) {
    const failedNames = failures
      .map(({ target: t }) => `${t.org}/${t.project}`)
      .join(", ");
    logger.warn(
      `Failed to fetch issues from ${failedNames}. Showing results from ${validResults.length} project(s).`
    );
  }

  if (issuesWithOptions.length === 0) {
    const hint = footer ? `No issues found.\n\n${footer}` : "No issues found.";
    return { items: [], hint, hasMore: false, hasPrev, errors };
  }

  const title =
    isSingleProject && firstTarget
      ? `Issues in ${firstTarget.orgDisplay}/${firstTarget.projectDisplay}`
      : `Issues from ${validResults.length} projects`;

  let footerMode: "single" | "multi" | "none" = "none";
  if (isMultiProject) {
    footerMode = "multi";
  } else if (isSingleProject) {
    footerMode = "single";
  }

  let moreHint: string | undefined;
  if (hasMoreToShow) {
    const higherLimit = Math.min(flags.limit * 2, LIST_MAX_LIMIT);
    const canIncreaseLimit = higherLimit > flags.limit;
    const actionParts: string[] = [];
    if (canIncreaseLimit) {
      actionParts.push(`-n ${higherLimit}`);
    }
    if (canPaginate) {
      actionParts.push("-c next");
    }
    // Only set the hint when there is at least one actionable option
    if (actionParts.length > 0) {
      moreHint = `More issues available — use ${actionParts.join(" or ")} for more.`;
    }
  }
  if (hasPrev) {
    // Multi-target mode: no single org to build a full command hint, so use bare flag
    const prevPart = "Prev: -c prev";
    moreHint = moreHint ? `${moreHint}\n${prevPart}` : prevPart;
  }

  return {
    items: allIssues,
    hasMore: hasMoreToShow,
    hasPrev,
    errors,
    displayRows: issuesWithOptions,
    title,
    footerMode,
    compact: resolveCompact(flags.compact, issuesWithOptions.length),
    moreHint,
    footer,
  };
}

/** Metadata for the shared dispatch infrastructure. */
const issueListMeta: ListCommandMeta = {
  paginationKey: PAGINATION_KEY,
  entityPlural: "issues",
  commandPrefix: "sentry issue list",
};

/**
 * @internal Exported for testing only. Not part of the public API.
 */
export const __testing = {
  trimWithProjectGuarantee,
  encodeCompoundCursor,
  decodeCompoundCursor,
  buildMultiTargetContextKey,
  buildProjectAliasMap,
  getComparator,
  compareDates,
  parseSort,
  defaultIssueSort,
  appendIssueFlags,
  build400Detail,
  CURSOR_SEP,
  MAX_LIMIT: LIST_MAX_LIMIT,
  VALID_SORT_VALUES,
};

// ---------------------------------------------------------------------------
// Output rendering
// ---------------------------------------------------------------------------

/**
 * Render an issue table to a string by buffering `writeIssueTable` output.
 *
 * This bridges the existing `writeIssueTable` (Writer-based) API to the
 * return-based `OutputConfig` pattern without duplicating the table logic.
 */
function renderIssueTable(rows: IssueTableRow[], compact: boolean): string {
  const parts: string[] = [];
  const buffer: Writer = {
    write: (s: string) => {
      parts.push(s);
    },
  };
  writeIssueTable(buffer, rows, { compact });
  return parts.join("");
}

/**
 * Format an {@link IssueListResult} as human-readable terminal output.
 *
 * Renders the title, issue table (via {@link writeIssueTable}), footer tip,
 * and "more available" hint. Empty results show the hint message only.
 */
function formatIssueListHuman(result: IssueListResult): string {
  const parts: string[] = [];

  if (result.items.length === 0) {
    // Empty result — hint contains "No issues found" or similar
    if (result.hint) {
      parts.push(result.hint);
    }
    return parts.join("\n");
  }

  // Title above the table (e.g. "Issues in sentry/cli:")
  if (result.title) {
    parts.push(formatListHeader(result.title));
  }

  // Render the issue table
  if (result.displayRows && result.displayRows.length > 0) {
    parts.push(renderIssueTable(result.displayRows, result.compact ?? false));
  }

  // Footer tip (e.g. "Tip: Use 'sentry issue view <ID>' ...")
  if (result.footerMode) {
    parts.push(formatListFooter(result.footerMode));
  }

  return parts.join("");
}

// Search syntax reference lives in src/lib/search-query.ts

/**
 * JSON transform for issue list that conditionally injects search syntax.
 *
 * Delegates to shared `jsonTransformListResult` for envelope handling.
 * Adds `_searchSyntax` only when the result set is empty — that's when
 * users/agents most likely need query help (bad query, wrong syntax).
 * Avoids bloating every successful response with static metadata.
 */
function jsonTransformIssueList(
  result: IssueListResult,
  fields?: string[]
): unknown {
  const transformed = jsonTransformListResult(result, fields);
  // Only inject into empty paginated envelopes — helps agents discover
  // query syntax when their search returned nothing.
  if (
    transformed &&
    typeof transformed === "object" &&
    !Array.isArray(transformed)
  ) {
    const envelope = transformed as Record<string, unknown>;
    const data = envelope.data;
    if (Array.isArray(data) && data.length === 0) {
      envelope._searchSyntax = SEARCH_SYNTAX_REFERENCE;
    }
  }
  return transformed;
}

/** Output configuration for the issue list command. */
const issueListOutput: OutputConfig<IssueListResult> = {
  human: formatIssueListHuman,
  jsonTransform: jsonTransformIssueList,
  schema: SentryIssueSchema,
};

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

export const listCommand = buildListCommand("issue", {
  docs: {
    brief: "List issues in a project",
    fullDescription:
      "List issues from Sentry projects.\n\n" +
      "Target patterns:\n" +
      "  sentry issue list               # auto-detect from DSN or config\n" +
      "  sentry issue list <org>/<proj>  # explicit org and project\n" +
      "  sentry issue list <org>/        # all projects in org (trailing / required)\n" +
      "  sentry issue list <project>     # find project across all orgs\n\n" +
      `${targetPatternExplanation()}\n\n` +
      "In monorepos with multiple Sentry projects, shows issues from all detected projects.\n\n" +
      "The --limit flag specifies the total number of issues to display (max 1000). " +
      "When multiple projects are detected, the limit is distributed evenly across them. " +
      "Projects with fewer issues than their share give their surplus to others. " +
      "Use --cursor / -c next / -c prev to paginate through larger result sets.\n\n" +
      "By default, only issues with activity in the last 90 days are shown. " +
      "Use --period to adjust (e.g. --period 24h, --period 14d).\n\n" +
      "Query syntax (--query flag):\n" +
      "  Terms are space-separated and implicitly ANDed together.\n" +
      "  AND/OR operators are NOT supported. Use alternatives:\n" +
      "    key:[val1,val2]   # in-list: matches val1 OR val2 for one key\n" +
      "    *term*            # wildcard matching\n" +
      "  Filters:  key:value, !key:value (negation), key:>N, key:<N\n" +
      '  Quoted:   message:"exact phrase with spaces"\n' +
      "  Built-in: is:unresolved, is:resolved, assigned:me, has:user\n" +
      "  Dates:    age:-24h (last 24h), firstSeen:+7d (older than 7d)\n" +
      "  Docs:     https://docs.sentry.io/concepts/search/\n\n" +
      "Alias: `sentry issues` → `sentry issue list`",
  },
  output: issueListOutput,
  parameters: {
    positional: LIST_TARGET_POSITIONAL,
    flags: {
      query: {
        kind: "parsed",
        parse: sanitizeQuery,
        brief: "Search query (Sentry syntax, implicit AND, no OR operator)",
        optional: true,
      },
      limit: buildListLimitFlag("issues"),
      sort: {
        kind: "parsed",
        parse: parseSort,
        brief:
          "Sort by: recommended, date, new, freq, user (default: recommended on sentry.io, else date)",
        optional: true,
      },
      period: {
        kind: "parsed",
        parse: parsePeriod,
        brief: PERIOD_BRIEF,
        default: "90d",
      },
      cursor: {
        kind: "parsed",
        parse: parseCursorFlag,
        brief:
          'Pagination cursor (use "next" for next page, "prev" for previous)',
        optional: true,
      },
      compact: {
        kind: "boolean",
        brief: "Single-line rows for compact output (auto-detects if omitted)",
        optional: true,
      },
    },
    aliases: {
      ...LIST_BASE_ALIASES,
      q: "query",
      s: "sort",
      t: "period",
    },
  },
  async *func(this: SentryContext, rawFlags: ListFlagsInput, target?: string) {
    const { cwd } = this;
    const log = logger.withTag("issue.list");

    // The --sort flag carries no static default so the host-dependent default
    // (recommended on SaaS, date on self-hosted) can be applied at runtime.
    // Resolve it here so all downstream code sees a concrete `flags.sort`.
    const flags: ListFlags = {
      ...rawFlags,
      sort: rawFlags.sort ?? defaultIssueSort(),
    };

    if (target) {
      rejectIssueCommandTokenListTarget(target);
    }

    const parsed = parseOrgProjectArg(target);

    // Auto-recover: user passed an issue short ID (e.g., "ARMAX-3E" or a
    // lowercase/multi-segment variant like "javascript-react-mr-1b") instead
    // of a project slug. Their intent is unambiguous — resolve and show it.
    // Use parsed.projectSlug (not raw target) so leading-slash project-search
    // forms like "/CLI-G" match the same as bare "CLI-G".
    if (
      parsed.type === "project-search" &&
      looksLikeIssueShortId(parsed.projectSlug, { ignoreCase: true })
    ) {
      const shortId = parsed.projectSlug;
      log.warn(
        `'${shortId}' is an issue short ID, not a project slug. Showing the issue.`
      );
      const { org, issue } = await resolveIssue({
        issueArg: shortId,
        cwd,
        command: "view",
      });
      const displayRows: IssueTableRow[] = [
        {
          issue,
          orgSlug: org ?? "",
          formatOptions: {
            projectSlug: issue.project?.slug ?? "",
            isMultiProject: false,
          },
        },
      ];
      yield new CommandOutput({
        items: [issue],
        displayRows,
        title: `Issue ${issue.shortId}`,
        footerMode: "none",
        compact: true,
      } satisfies IssueListResult);
      return {
        hint: `Tip: Use 'sentry issue view ${shortId}' for full details`,
      };
    }

    // Validate --limit range. Auto-pagination handles the API's 100-per-page
    // cap transparently, but we cap the total at MAX_LIMIT for practical CLI
    // response times. Use --cursor for paginating through larger result sets.
    if (flags.limit < 1) {
      throw new ValidationError("--limit must be at least 1.", "limit");
    }
    if (flags.limit > LIST_MAX_LIMIT) {
      throw new ValidationError(
        `--limit cannot exceed ${LIST_MAX_LIMIT}. ` +
          "Use --cursor to paginate through larger result sets.",
        "limit"
      );
    }

    const timeRange = flags.period;

    // biome-ignore lint/suspicious/noExplicitAny: shared handler accepts any mode variant
    const resolveAndHandle: ModeHandler<any> = (ctx) =>
      handleResolvedTargets({
        ...ctx,
        flags,
        timeRange,
      });

    const result = (await dispatchOrgScopedList({
      config: issueListMeta,
      cwd,
      flags,
      parsed,
      // Bare slug: the project wins when one exists. If none does and the
      // slug is an organization, list that org. `<org>/` is the explicit form.
      // Multi-target modes (auto-detect, explicit, project-search) handle
      // compound cursor pagination themselves via handleResolvedTargets.
      allowCursorInModes: ["auto-detect", "explicit", "project-search"],
      overrides: {
        "auto-detect": resolveAndHandle,
        explicit: resolveAndHandle,
        "project-search": resolveAndHandle,
        "org-all": (ctx) =>
          handleOrgAllIssues({
            org: ctx.parsed.org,
            flags,
            timeRange,
          }),
      },
    })) as IssueListResult;

    // Only forward hints to the framework footer when items exist — empty
    // results already render hint text inside formatIssueListHuman.
    let combinedHint: string | undefined;
    if (result.items.length > 0) {
      const hintParts: string[] = [];
      if (result.moreHint) {
        hintParts.push(result.moreHint);
      }
      if (result.footer) {
        hintParts.push(result.footer);
      }
      combinedHint = hintParts.length > 0 ? hintParts.join("\n") : result.hint;
    }

    yield new CommandOutput(result);
    return { hint: combinedHint };
  },
});
