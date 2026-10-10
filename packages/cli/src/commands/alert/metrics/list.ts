/**
 * sentry alert metrics list
 *
 * List metric alert rules for one or more Sentry organizations.
 *
 * Metric alerts are org-scoped. Supports all four target modes:
 * - auto-detect  → DSN detection / config defaults (may resolve multiple orgs)
 * - explicit     → single org/project (project part ignored, metric alerts are org-scoped)
 * - org-all      → all metric alert rules for the specified org (cursor-paginated)
 * - project-search → find project across orgs, use its org
 */

import type { SentryContext } from "../../../context.js";
import type { MetricAlertRule } from "../../../lib/api/alerts.js";
import { MAX_PAGINATION_PAGES } from "../../../lib/api/infrastructure.js";
import {
  API_MAX_PER_PAGE,
  listMetricAlertsPaginated,
} from "../../../lib/api-client.js";
import { parseOrgProjectArg } from "../../../lib/arg-parsing.js";
import { openInBrowser } from "../../../lib/browser.js";
import {
  advancePaginationState,
  buildMultiOrgContextKey,
  decodeTargetCursors,
  encodeCompoundCursor,
  hasPreviousPage,
  resolveCursor,
} from "../../../lib/db/pagination.js";
import {
  ContextError,
  ValidationError,
  withAuthGuard,
} from "../../../lib/errors.js";
import {
  colorTag,
  escapeMarkdownCell,
} from "../../../lib/formatters/markdown.js";
import { CommandOutput } from "../../../lib/formatters/output.js";
import { type Column, writeTable } from "../../../lib/formatters/table.js";
import {
  buildListCommand,
  buildListLimitFlag,
  LIST_BASE_ALIASES,
  LIST_MAX_LIMIT,
  paginationHint,
  parseCursorFlag,
  targetPatternExplanation,
} from "../../../lib/list-command.js";
import { logger } from "../../../lib/logger.js";
import {
  dispatchOrgScopedList,
  type FetchResult as FetchResultOf,
  jsonTransformListResult,
  type ListCommandMeta,
  type ListResult,
  type ModeHandler,
  trimWithGroupGuarantee,
} from "../../../lib/org-list.js";
import { withProgress } from "../../../lib/polling.js";
import {
  classifyProjectSearchTarget,
  type ProjectSearchTargetResolution,
  type ResolvedTarget,
  resolveProjectBoundTargets,
} from "../../../lib/resolve-target.js";
import { buildMetricAlertsUrl } from "../../../lib/sentry-web-urls.js";
import type { Writer } from "../../../types/index.js";
import {
  assertAlertListLimit,
  buildAlertListFailureErrors,
  fetchAlertRulesWithBudget,
  throwAlertListFetchFailure,
} from "../list-utils.js";
import { metricAlertStatusLabel } from "./status.js";

/** Command key for pagination cursor storage */
export const PAGINATION_KEY = "alert-metrics-list";

const USAGE_HINT = "sentry alert metrics list <org>/";

const METRIC_ALERT_TARGET_POSITIONAL = {
  kind: "tuple" as const,
  parameters: [
    {
      placeholder: "target",
      brief: "<org>/, <org>/<project> (project ignored), or <project> (search)",
      parse: String,
      optional: true as const,
    },
  ],
};

type ListFlags = {
  readonly web: boolean;
  readonly fresh: boolean;
  readonly limit: number;
  readonly cursor?: string;
  readonly json: boolean;
  readonly fields?: string[];
  readonly query?: string;
};

/** Per-org fetch result */
type MetricRuleFetchResult = {
  orgSlug: string;
  rules: MetricAlertRule[];
  hasMore?: boolean;
  nextCursor?: string;
};

/** Success/failure wrapper for per-org fetches */
type FetchResult = FetchResultOf<MetricRuleFetchResult>;

/** Display row carrying per-rule org context for the human formatter. */
type MetricAlertRow = { rule: MetricAlertRule; orgSlug: string };

/**
 * Extended result type: raw rules in `items` (for JSON), display rows in
 * `displayRows` (for human output).
 */
type MetricAlertListResult = ListResult<MetricAlertRule> & {
  displayRows?: MetricAlertRow[];
  title?: string;
  moreHint?: string;
  footer?: string;
};

const metricAlertListMeta: ListCommandMeta = {
  paginationKey: PAGINATION_KEY,
  entityPlural: "metric alert rules",
  commandPrefix: "sentry alert metrics list",
};

// Fetch helpers

/**
 * Fetch metric alert rules for one org with auth guard.
 * Paginates locally up to the given limit.
 */
async function fetchRulesForOrg(
  orgSlug: string,
  options: { limit: number; startCursor?: string },
): Promise<FetchResult> {
  const result = await withAuthGuard(async () => {
    const rules: MetricAlertRule[] = [];
    let serverCursor = options.startCursor;

    for (let page = 0; page < MAX_PAGINATION_PAGES; page++) {
      const { data, nextCursor } = await listMetricAlertsPaginated(orgSlug, {
        perPage: Math.min(options.limit - rules.length, API_MAX_PER_PAGE),
        cursor: serverCursor,
      });

      for (const rule of data) {
        rules.push(rule);
        if (rules.length >= options.limit) {
          return {
            orgSlug,
            rules,
            hasMore: !!nextCursor,
            nextCursor: nextCursor ?? undefined,
          };
        }
      }

      if (!nextCursor) {
        return { orgSlug, rules, hasMore: false };
      }
      serverCursor = nextCursor;
    }

    return {
      orgSlug,
      rules,
      hasMore: !!serverCursor,
      nextCursor: serverCursor,
    };
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

// Mode handlers

type ResolvedOrgsOptions = {
  parsed: ReturnType<typeof parseOrgProjectArg>;
  flags: ListFlags;
  cwd: string;
  projectSearchResolution?: ProjectSearchTargetResolution;
};

/**
 * Resolve the org slug(s) for a metric alert listing.
 *
 * Metric alerts are org-scoped — no project enumeration is needed.
 * `explicit` and `org-all` give us the org directly from the parsed arg.
 * `auto-detect` and `project-search` need full target resolution (DSN
 * detection / cross-org project search) to discover the org(s).
 */
async function resolveOrgs(
  parsed: ReturnType<typeof parseOrgProjectArg>,
  cwd: string,
  projectSearchResolution?: ProjectSearchTargetResolution,
): Promise<{ orgs: string[]; footer?: string }> {
  if (parsed.type === "explicit" || parsed.type === "org-all") {
    return { orgs: [parsed.org] };
  }
  const { targets, footer } = await resolveProjectBoundTargets(parsed, {
    cwd,
    usageHint: USAGE_HINT,
    projectSearchResolution,
  });
  return {
    orgs: [...new Set(targets.map((t: ResolvedTarget) => t.org))],
    footer,
  };
}

async function resolveWebUrl(
  parsed: ReturnType<typeof parseOrgProjectArg>,
  cwd: string,
): Promise<string> {
  let projectSearchResolution: ProjectSearchTargetResolution | undefined;
  if (
    parsed.type === "project-search" &&
    parsed.org === undefined &&
    parsed.originalSlug === undefined
  ) {
    const resolution = await classifyProjectSearchTarget(parsed);
    if (resolution.kind === "organization") {
      logger.warn(
        `'${parsed.projectSlug}' is an organization, not a project. Opening organization '${resolution.org}'.`,
      );
      return buildMetricAlertsUrl(resolution.org);
    }
    projectSearchResolution = resolution;
  }

  const { orgs } = await resolveOrgs(parsed, cwd, projectSearchResolution);
  const uniqueOrgs = [...new Set(orgs)];
  if (uniqueOrgs.length === 0) {
    throw new ContextError("Organization", USAGE_HINT);
  }
  if (uniqueOrgs.length !== 1) {
    throw new ValidationError(
      "--web resolved metric alert rules in multiple organizations. Specify an explicit <org>/ target.",
      "target",
    );
  }
  // oxlint-disable-next-line typescript/no-non-null-assertion -- length checked above
  return buildMetricAlertsUrl(uniqueOrgs[0]!);
}

/**
 * Handle all four modes: resolve orgs → fetch within budget → compound cursor
 * per org → display.
 */
// inherent multi-org resolution, compound cursor, error handling, and display logic
async function handleResolvedOrgs(
  options: ResolvedOrgsOptions,
): Promise<MetricAlertListResult> {
  const { parsed, flags, cwd, projectSearchResolution } = options;

  const { orgs: resolved, footer } = await resolveOrgs(
    parsed,
    cwd,
    projectSearchResolution,
  );

  if (resolved.length === 0) {
    throw new ContextError("Organization", USAGE_HINT);
  }

  const uniqueOrgs = [...new Set(resolved)];

  const contextKey = buildMultiOrgContextKey(uniqueOrgs, flags.query);
  const sortedOrgKeys = [...uniqueOrgs].sort();

  const { cursor: rawCursor, direction } = resolveCursor(
    flags.cursor,
    PAGINATION_KEY,
    contextKey,
  );
  const { startCursors, exhausted: exhaustedOrgs } = decodeTargetCursors(
    rawCursor,
    sortedOrgKeys,
  );

  const activeOrgs =
    exhaustedOrgs.size > 0
      ? uniqueOrgs.filter((org) => !exhaustedOrgs.has(org))
      : uniqueOrgs;

  const orgCount = activeOrgs.length;
  const baseMessage =
    orgCount > 1
      ? `Fetching metric alert rules from ${orgCount} organizations`
      : "Fetching metric alert rules";

  const { results, hasMore } = await withProgress(
    { message: `${baseMessage} (up to ${flags.limit})...`, json: flags.json },
    (setMessage) =>
      fetchAlertRulesWithBudget(activeOrgs, {
        limit: flags.limit,
        startCursors,
        getGroupKey: (org) => org,
        fetchGroup: fetchRulesForOrg,
        onProgress: (fetched) => {
          setMessage(
            `${baseMessage}, ${fetched} and counting (up to ${flags.limit})...`,
          );
        },
      }),
  );

  const validResults: MetricRuleFetchResult[] = [];
  const failures: { orgSlug: string; error: Error }[] = [];

  for (let i = 0; i < results.length; i++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- index within bounds
    const result = results[i]!;
    if (result.success) {
      validResults.push(result.data);
    } else {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- index within bounds
      failures.push({ orgSlug: activeOrgs[i]!, error: result.error });
    }
  }

  if (validResults.length === 0 && failures.length > 0) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- guarded by failures.length > 0
    const { error: first } = failures[0]!;
    throwAlertListFetchFailure(
      `Failed to fetch metric alert rules from ${uniqueOrgs.length} organization(s)`,
      first,
    );
  }

  if (failures.length > 0) {
    const failedNames = failures.map(({ orgSlug }) => orgSlug).join(", ");
    logger.warn(
      `Failed to fetch metric alert rules from ${failedNames}. Showing results from ${validResults.length} organization(s).`,
    );
  }

  const isSingleOrg = validResults.length === 1;
  const firstOrg = validResults[0]?.orgSlug;

  // Apply client-side name filter
  const allRows: MetricAlertRow[] = validResults.flatMap((r) =>
    r.rules.map((rule) => ({ rule, orgSlug: r.orgSlug })),
  );
  const filteredRows = flags.query
    ? allRows.filter((row) =>
        (row.rule.name ?? "")
          .toLowerCase()
          .includes(flags.query?.toLowerCase() ?? ""),
      )
    : allRows;

  const displayRows = trimWithGroupGuarantee(
    filteredRows,
    flags.limit,
    (row) => row.orgSlug,
  );
  const trimmed = displayRows.length < filteredRows.length;
  const cursorValues: (string | null)[] = sortedOrgKeys.map((key) => {
    if (exhaustedOrgs.has(key)) {
      return null;
    }
    const result = results.find((r) => r.success && r.data.orgSlug === key);
    if (result?.success) {
      return result.data.nextCursor ?? null;
    }
    // Preserve the previous cursor so the org is retried on the next page.
    // First-page failures (no prior cursor) return null to mark the org
    // as exhausted — retrying with a sentinel would loop infinitely.
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
    compoundNextCursor,
  );
  const hasPrev = hasPreviousPage(PAGINATION_KEY, contextKey);

  const allRules = displayRows.map((r) => r.rule);
  const errors = buildAlertListFailureErrors(
    failures,
    "org",
    ({ orgSlug }) => orgSlug,
    ({ error }) => error,
  );

  const nav = paginationHint({
    hasPrev,
    hasMore: hasMoreToShow && canPaginate,
    prevHint: "-c prev",
    nextHint: "-c next",
  });
  const higherLimit = Math.min(flags.limit * 2, LIST_MAX_LIMIT);
  const limitHint =
    hasMoreToShow && higherLimit > flags.limit
      ? `Use -n ${higherLimit} for more.`
      : undefined;
  const moreHint = [nav, limitHint].filter(Boolean).join("\n") || undefined;

  if (displayRows.length === 0) {
    const parts = ["No metric alert rules found."];
    if (moreHint) {
      parts.push(moreHint);
    }
    if (footer) {
      parts.push(footer);
    }
    return {
      items: [],
      hint: parts.join("\n\n"),
      hasMore: hasMoreToShow,
      hasPrev,
      errors,
    };
  }

  const title =
    isSingleOrg && firstOrg
      ? `Metric alert rules in ${firstOrg}`
      : `Metric alert rules from ${validResults.length} organizations`;

  return {
    items: allRules,
    hasMore: hasMoreToShow,
    hasPrev,
    displayRows,
    title,
    moreHint,
    footer,
    errors,
  };
}

// Human output

function formatMetricStatus(status: unknown): string {
  const label = metricAlertStatusLabel(status);
  return label === "active"
    ? colorTag("green", label)
    : colorTag("muted", label);
}

function formatMetricAlertListHuman(result: MetricAlertListResult): string {
  if (result.items.length === 0) {
    return result.hint ?? "No metric alert rules found.";
  }

  const rows = result.displayRows ?? [];
  const uniqueOrgs = new Set(rows.map((r) => r.orgSlug));
  const isMultiOrg = uniqueOrgs.size > 1;

  type Row = {
    id: string;
    name: string;
    org?: string;
    aggregate: string;
    dataset: string;
    timeWindow: string;
    environment: string;
    status: string;
  };

  const tableRows: Row[] = rows.map(({ rule: r, orgSlug }) => ({
    id: r.id,
    name: escapeMarkdownCell(r.name ?? "(untitled)"),
    ...(isMultiOrg && { org: orgSlug }),
    aggregate: r.aggregate,
    dataset: r.dataset,
    timeWindow: `${r.timeWindow}m`,
    environment: r.environment ?? "all",
    status: formatMetricStatus(r.status),
  }));

  const columns: Column<Row>[] = [
    { header: "ID", value: (r) => r.id },
    { header: "NAME", value: (r) => r.name },
    ...(isMultiOrg ? [{ header: "ORG", value: (r: Row) => r.org ?? "" }] : []),
    { header: "AGGREGATE", value: (r) => r.aggregate },
    { header: "DATASET", value: (r) => r.dataset },
    { header: "WINDOW", value: (r) => r.timeWindow },
    { header: "ENVIRONMENT", value: (r) => r.environment },
    { header: "STATUS", value: (r) => r.status },
  ];

  const parts: string[] = [];
  const buffer: Writer = { write: (s: string) => parts.push(s) };

  if (result.title) {
    parts.push(`${result.title}:\n\n`);
  }

  writeTable(buffer, tableRows, columns);

  return parts.join("").trimEnd();
}

const jsonTransformMetricAlertList = jsonTransformListResult;

// Command

export const listCommand = buildListCommand("alert metrics", {
  docs: {
    brief: "List metric alert rules",
    fullDescription:
      "List metric alert rules for one or more Sentry organizations.\n\n" +
      "Metric alerts trigger notifications when a metric query crosses a threshold.\n\n" +
      "Target patterns:\n" +
      "  sentry alert metrics list                     # auto-detect from DSN or config\n" +
      "  sentry alert metrics list <org>/              # explicit org (paginated)\n" +
      "  sentry alert metrics list <org>/<project>     # explicit org (project ignored)\n" +
      "  sentry alert metrics list <project>           # find project across all orgs\n\n" +
      `${targetPatternExplanation()}\n\n` +
      "Metric alert rules are org-scoped; the project part is ignored when provided.\n\n" +
      "Use --cursor / -c next / -c prev to paginate through larger result sets.",
  },
  output: {
    human: formatMetricAlertListHuman,
    jsonTransform: jsonTransformMetricAlertList,
  },
  parameters: {
    positional: METRIC_ALERT_TARGET_POSITIONAL,
    flags: {
      web: {
        kind: "boolean",
        brief: "Open in browser",
        default: false,
      },
      limit: buildListLimitFlag("metric alert rules"),
      query: {
        kind: "parsed",
        parse: String,
        brief: "Filter rules by name",
        optional: true,
      },
      cursor: {
        kind: "parsed",
        parse: parseCursorFlag,
        brief:
          'Pagination cursor (use "next" for next page, "prev" for previous)',
        optional: true,
      },
    },
    aliases: { ...LIST_BASE_ALIASES, w: "web", q: "query" },
  },
  async *func(this: SentryContext, flags: ListFlags, target?: string) {
    const { cwd } = this;
    const parsed = parseOrgProjectArg(target);
    assertAlertListLimit(flags.limit);

    if (flags.web) {
      await openInBrowser(
        await resolveWebUrl(parsed, cwd),
        "metric alert rules",
      );
      return;
    }

    // oxlint-disable-next-line typescript/no-explicit-any -- shared handler accepts any mode variant
    const resolveAndHandle: ModeHandler<any> = (ctx) =>
      handleResolvedOrgs({ ...ctx, flags });

    const result = (await dispatchOrgScopedList({
      config: metricAlertListMeta,
      cwd,
      flags,
      parsed,
      // All modes use per-org fetching with compound cursor support
      allowCursorInModes: [
        "auto-detect",
        "explicit",
        "project-search",
        "org-all",
      ],
      overrides: {
        "auto-detect": resolveAndHandle,
        explicit: resolveAndHandle,
        "project-search": resolveAndHandle,
        "org-all": resolveAndHandle,
      },
    })) as MetricAlertListResult;

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
