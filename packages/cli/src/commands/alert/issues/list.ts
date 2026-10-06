/**
 * sentry alert issues list
 *
 * List issue alert rules for one or more Sentry projects.
 *
 * Issue alerts are project-scoped. Supports all four target modes:
 * - auto-detect  → DSN detection / config defaults (may resolve multiple projects)
 * - explicit     → single org/project
 * - org-all      → all projects in an org (all their alert rules combined)
 * - project-search → find project by slug across all orgs
 */

import type { SentryContext } from "../../../context.js";
import { buildProjectAliasMap } from "../../../lib/alias.js";
import type { IssueAlertRule } from "../../../lib/api/alerts.js";
import { MAX_PAGINATION_PAGES } from "../../../lib/api/infrastructure.js";
import {
  API_MAX_PER_PAGE,
  listIssueAlertsPaginated,
} from "../../../lib/api-client.js";
import { parseOrgProjectArg } from "../../../lib/arg-parsing.js";
import { openInBrowser } from "../../../lib/browser.js";
import {
  advancePaginationState,
  buildMultiTargetContextKey,
  decodeTargetCursors,
  encodeCompoundCursor,
  hasPreviousPage,
  resolveCursor,
} from "../../../lib/db/pagination.js";
import {
  clearProjectAliases,
  setProjectAliases,
} from "../../../lib/db/project-aliases.js";
import { createDsnFingerprint } from "../../../lib/dsn/index.js";
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
  LIST_TARGET_POSITIONAL,
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
import { buildIssueAlertsUrl } from "../../../lib/sentry-web-urls.js";
import type { ProjectAliasEntry, Writer } from "../../../types/index.js";
import {
  assertAlertListLimit,
  buildAlertListFailureErrors,
  fetchAlertRulesWithBudget,
  throwAlertListFetchFailure,
} from "../list-utils.js";

/** Command key for pagination cursor storage */
export const PAGINATION_KEY = "alert-issues-list";

const USAGE_HINT = "sentry alert issues list <org>/<project>";

type ListFlags = {
  readonly web: boolean;
  readonly fresh: boolean;
  readonly limit: number;
  readonly cursor?: string;
  readonly json: boolean;
  readonly fields?: string[];
  readonly query?: string;
};

/** Per-target fetch result */
type AlertRuleListFetchResult = {
  target: ResolvedTarget;
  rules: IssueAlertRule[];
  hasMore?: boolean;
  nextCursor?: string;
};

/** Success/failure wrapper for per-target fetches */
type FetchResult = FetchResultOf<AlertRuleListFetchResult>;

/** Display row carrying per-rule project context for the human formatter. */
type AlertRuleRow = { rule: IssueAlertRule; target: ResolvedTarget };

/**
 * Extended result type: raw rules in `items` (for JSON), display rows in
 * `displayRows` (for human output).
 */
type IssueAlertListResult = ListResult<IssueAlertRule> & {
  displayRows?: AlertRuleRow[];
  title?: string;
  moreHint?: string;
  footer?: string;
};

const issueAlertListMeta: ListCommandMeta = {
  paginationKey: PAGINATION_KEY,
  entityPlural: "issue alert rules",
  commandPrefix: "sentry alert issues list",
};

// Fetch helpers

/**
 * Fetch issue alert rules for a single target project with auth guard.
 * Paginates locally up to the given limit.
 */
async function fetchRulesForTarget(
  target: ResolvedTarget,
  options: { limit: number; startCursor?: string },
): Promise<FetchResult> {
  const result = await withAuthGuard(async () => {
    const rules: IssueAlertRule[] = [];
    let serverCursor = options.startCursor;

    for (let page = 0; page < MAX_PAGINATION_PAGES; page++) {
      const { data, nextCursor } = await listIssueAlertsPaginated(
        target.org,
        target.project,
        {
          perPage: Math.min(options.limit - rules.length, API_MAX_PER_PAGE),
          cursor: serverCursor,
        },
      );

      for (const rule of data) {
        rules.push(rule);
        if (rules.length >= options.limit) {
          return {
            target,
            rules,
            hasMore: !!nextCursor,
            nextCursor: nextCursor ?? undefined,
          };
        }
      }

      if (!nextCursor) {
        return { target, rules, hasMore: false };
      }
      serverCursor = nextCursor;
    }

    return {
      target,
      rules,
      hasMore: !!serverCursor,
      nextCursor: serverCursor ?? undefined,
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

async function resolveWebUrl(
  parsed: ReturnType<typeof parseOrgProjectArg>,
  cwd: string,
): Promise<string> {
  if (parsed.type === "explicit") {
    return buildIssueAlertsUrl(parsed.org, parsed.project);
  }
  if (parsed.type === "org-all") {
    return buildIssueAlertsUrl(parsed.org);
  }

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
      return buildIssueAlertsUrl(resolution.org);
    }
    projectSearchResolution = resolution;
  }

  const { targets } = await resolveProjectBoundTargets(parsed, {
    cwd,
    usageHint: USAGE_HINT,
    projectSearchResolution,
  });
  if (targets.length === 0) {
    throw new ContextError("Organization and project", USAGE_HINT);
  }

  const orgs = [...new Set(targets.map((t) => t.org))];
  if (orgs.length !== 1) {
    throw new ValidationError(
      "--web resolved alert rules in multiple organizations. Specify an explicit <org>/ or <org>/<project> target.",
      "target",
    );
  }

  const projects = [...new Set(targets.map((t) => t.project))];
  return buildIssueAlertsUrl(
    // oxlint-disable-next-line typescript/no-non-null-assertion -- orgs length is checked above
    orgs[0]!,
    projects.length === 1 ? projects[0] : undefined,
  );
}

// Mode handler

type ResolvedTargetsOptions = {
  parsed: ReturnType<typeof parseOrgProjectArg>;
  flags: ListFlags;
  cwd: string;
  projectSearchResolution?: ProjectSearchTargetResolution;
};

// inherent multi-target resolution, compound cursor, error handling, and display logic
async function handleResolvedTargets(
  options: ResolvedTargetsOptions,
): Promise<IssueAlertListResult> {
  const { parsed, flags, cwd, projectSearchResolution } = options;

  const { targets, footer, detectedDsns } = await resolveProjectBoundTargets(
    parsed,
    { cwd, usageHint: USAGE_HINT, projectSearchResolution },
  );

  if (targets.length === 0) {
    throw new ContextError("Organization and project", USAGE_HINT);
  }

  const contextKey = buildMultiTargetContextKey(targets, {
    query: flags.query,
  });

  const sortedTargetKeys = targets.map((t) => `${t.org}/${t.project}`).sort();
  const { cursor: rawCursor, direction } = resolveCursor(
    flags.cursor,
    PAGINATION_KEY,
    contextKey,
  );
  const { startCursors, exhausted: exhaustedTargets } = decodeTargetCursors(
    rawCursor,
    sortedTargetKeys,
  );

  const activeTargets =
    exhaustedTargets.size > 0
      ? targets.filter((t) => !exhaustedTargets.has(`${t.org}/${t.project}`))
      : targets;

  const targetCount = activeTargets.length;
  const baseMessage =
    targetCount > 1
      ? `Fetching issue alert rules from ${targetCount} projects`
      : "Fetching issue alert rules";

  const { results, hasMore } = await withProgress(
    { message: `${baseMessage} (up to ${flags.limit})...`, json: flags.json },
    (setMessage) =>
      fetchAlertRulesWithBudget(activeTargets, {
        limit: flags.limit,
        startCursors,
        getGroupKey: (target) => `${target.org}/${target.project}`,
        fetchGroup: fetchRulesForTarget,
        onProgress: (fetched) => {
          setMessage(
            `${baseMessage}, ${fetched} and counting (up to ${flags.limit})...`,
          );
        },
      }),
  );

  const validResults: AlertRuleListFetchResult[] = [];
  const failures: { target: ResolvedTarget; error: Error }[] = [];

  for (let i = 0; i < results.length; i++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- index within bounds
    const result = results[i]!;
    if (result.success) {
      validResults.push(result.data);
    } else {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- index within bounds
      failures.push({ target: activeTargets[i]!, error: result.error });
    }
  }

  if (validResults.length === 0 && failures.length > 0) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- guarded by failures.length > 0
    const { error: first } = failures[0]!;
    throwAlertListFetchFailure(
      `Failed to fetch alert rules from ${targets.length} project(s)`,
      first,
    );
  }

  if (failures.length > 0) {
    const failedNames = failures
      .map(({ target: t }) => `${t.org}/${t.project}`)
      .join(", ");
    logger.warn(
      `Failed to fetch alert rules from ${failedNames}. Showing results from ${validResults.length} project(s).`,
    );
  }

  const isMultiProject = validResults.length > 1;
  const isSingleProject = validResults.length === 1;
  const firstTarget = validResults[0]?.target;

  const { entries } = isMultiProject
    ? buildProjectAliasMap(validResults)
    : { entries: {} as Record<string, ProjectAliasEntry> };

  if (isMultiProject) {
    const fingerprint = createDsnFingerprint(detectedDsns ?? []);
    setProjectAliases(entries, fingerprint);
  } else {
    clearProjectAliases();
  }

  // Apply client-side name filter
  const allRows: AlertRuleRow[] = validResults.flatMap((r) =>
    r.rules.map((rule) => ({ rule, target: r.target })),
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
    (row) => `${row.target.org}/${row.target.project}`,
  );
  const trimmed = displayRows.length < filteredRows.length;
  const cursorValues: (string | null)[] = sortedTargetKeys.map((key) => {
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
      return result.data.nextCursor ?? null;
    }
    // Preserve the previous cursor so the target is retried on the next page.
    // First-page failures (no prior cursor) return null to mark the target
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
    "project",
    ({ target: t }) => `${t.org}/${t.project}`,
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
    const parts = ["No issue alert rules found."];
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
    isSingleProject && firstTarget
      ? `Issue alert rules in ${firstTarget.orgDisplay}/${firstTarget.projectDisplay}`
      : `Issue alert rules from ${validResults.length} projects`;

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

function formatIssueAlertListHuman(result: IssueAlertListResult): string {
  if (result.items.length === 0) {
    return result.hint ?? "No issue alert rules found.";
  }

  const rows = result.displayRows ?? [];
  const uniqueProjects = new Set(
    rows.map((r) => `${r.target.org}/${r.target.project}`),
  );
  const isMultiProject = uniqueProjects.size > 1;

  type Row = {
    id: string;
    name: string;
    project?: string;
    conditions: string;
    actions: string;
    environment: string;
    status: string;
  };

  const tableRows: Row[] = rows.map(({ rule: r, target }) => ({
    id: r.id,
    name: escapeMarkdownCell(r.name ?? "(untitled)"),
    ...(isMultiProject && {
      project: `${target.org}/${target.project}`,
    }),
    conditions: String(r.conditions?.length ?? 0),
    actions: String(r.actions?.length ?? 0),
    environment: r.environment ?? "all",
    status:
      r.status === "active"
        ? colorTag("green", "active")
        : colorTag("muted", r.status),
  }));

  const columns: Column<Row>[] = [
    { header: "ID", value: (r) => r.id },
    { header: "NAME", value: (r) => r.name },
    ...(isMultiProject
      ? [{ header: "PROJECT", value: (r: Row) => r.project ?? "" }]
      : []),
    { header: "CONDITIONS", value: (r) => r.conditions },
    { header: "ACTIONS", value: (r) => r.actions },
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

const jsonTransformIssueAlertList = jsonTransformListResult;

// Command

export const listCommand = buildListCommand("alert issues", {
  docs: {
    brief: "List issue alert rules",
    fullDescription:
      "List issue alert rules for one or more Sentry projects.\n\n" +
      "Issue alerts trigger notifications when error events match conditions.\n\n" +
      "Target patterns:\n" +
      "  sentry alert issues list                     # auto-detect from DSN or config\n" +
      "  sentry alert issues list <org>/<project>     # explicit org and project\n" +
      "  sentry alert issues list <org>/              # all projects in org\n" +
      "  sentry alert issues list <project>           # find project across all orgs\n\n" +
      `${targetPatternExplanation()}\n\n` +
      "In monorepos with multiple Sentry projects, shows alert rules from all detected projects.\n\n" +
      "Use --cursor / -c next / -c prev to paginate through larger result sets.",
  },
  output: {
    human: formatIssueAlertListHuman,
    jsonTransform: jsonTransformIssueAlertList,
  },
  parameters: {
    positional: LIST_TARGET_POSITIONAL,
    flags: {
      web: {
        kind: "boolean",
        brief: "Open in browser",
        default: false,
      },
      limit: buildListLimitFlag("issue alert rules"),
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
        "issue alert rules",
      );
      return;
    }

    // oxlint-disable-next-line typescript/no-explicit-any -- shared handler accepts any mode variant
    const resolveAndHandle: ModeHandler<any> = (ctx) =>
      handleResolvedTargets({ ...ctx, flags });

    const result = (await dispatchOrgScopedList({
      config: issueAlertListMeta,
      cwd,
      flags,
      parsed,
      // All modes use per-project fetching with compound cursor support
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
    })) as IssueAlertListResult;

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
