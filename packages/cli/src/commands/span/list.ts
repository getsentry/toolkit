/**
 * sentry span list
 *
 * List spans from a Sentry project, or within a specific trace.
 *
 * Dual-mode command (like `log list`):
 * - **Project mode** (no trace ID): lists spans across the entire project
 * - **Trace mode** (trace ID provided): lists spans within a specific trace
 *
 * Disambiguation uses {@link isTraceId} to detect 32-char hex trace IDs.
 */

import type { SentryContext } from "../../context.js";
import type { SpanSortValue } from "../../lib/api/traces.js";
import { listSpans } from "../../lib/api-client.js";
import { validateLimit } from "../../lib/arg-parsing.js";
import {
  advancePaginationState,
  buildPaginationContextKey,
  hasPreviousPage,
  resolveCursor,
} from "../../lib/db/pagination.js";
import { toSearchQueryError } from "../../lib/errors.js";
import {
  type FlatSpan,
  formatSpanTable,
  spanListItemToFlatSpan,
  translateSpanQuery,
} from "../../lib/formatters/index.js";
import { filterFields } from "../../lib/formatters/json.js";
import { renderMarkdown } from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  buildListCommand,
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  LIST_PERIOD_FLAG,
  PERIOD_ALIASES,
  paginationHint,
  TARGET_PATTERN_NOTE,
} from "../../lib/list-command.js";
import { withProgress } from "../../lib/polling.js";
import {
  resolveLogProjectId,
  resolveProjectBoundFromArg,
} from "../../lib/resolve-target.js";
import { sanitizeQuery } from "../../lib/search-query.js";
import {
  appendPeriodHint,
  serializeTimeRange,
  type TimeRange,
  timeRangeToApiParams,
} from "../../lib/time-range.js";
import {
  type ParsedTraceTarget,
  parseDualModeArgs,
  resolveTraceOrgProject,
  warnIfNormalized,
} from "../../lib/trace-target.js";
import { SpanListItemSchema } from "../../types/index.js";

type ListFlags = {
  readonly limit: number;
  readonly query?: string;
  readonly sort: SpanSortValue;
  readonly period: TimeRange;
  readonly cursor?: string;
  readonly json: boolean;
  readonly fresh: boolean;
  readonly fields?: string[];
};

/**
 * All field names already covered by the default SPAN_FIELDS request —
 * both the raw API names (e.g., `id`, `span.op`) and their output-side
 * aliases (e.g., `span_id`, `op`) produced by `spanListItemToFlatSpan`.
 * Any `--fields` value NOT in this set is treated as a custom attribute
 * and forwarded to the API as an extra `field` parameter.
 */
const KNOWN_SPAN_FIELDS = new Set([
  // API names (in SPAN_FIELDS)
  "id",
  "parent_span",
  "span.op",
  "description",
  "span.duration",
  "timestamp",
  "project",
  "transaction",
  "trace",
  // Output aliases (from spanListItemToFlatSpan)
  "span_id",
  "parent_span_id",
  "op",
  "duration_ms",
  "start_timestamp",
  "project_slug",
]);

/** Field group aliases that expand to curated field sets */
const FIELD_GROUP_ALIASES: Record<string, string[]> = {
  gen_ai: [
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.output_tokens",
    "gen_ai.request.model",
    "gen_ai.system",
  ],
};

/**
 * Extract field names from --fields that need additional API requests.
 *
 * Expands group aliases (e.g., `gen_ai` → four OTEL attribute fields) and
 * filters out names already covered by the default SPAN_FIELDS request.
 *
 * @param fields - Raw --fields values from the CLI
 * @returns Deduplicated extra API field names, or undefined if none are needed
 */
function extractExtraApiFields(
  fields: string[] | undefined
): string[] | undefined {
  if (!fields?.length) {
    return;
  }

  const expanded = new Set<string>();
  for (const f of fields) {
    const alias = FIELD_GROUP_ALIASES[f];
    if (alias) {
      for (const a of alias) {
        expanded.add(a);
      }
    } else {
      expanded.add(f);
    }
  }

  // Remove anything already requested by SPAN_FIELDS or its output aliases
  for (const known of KNOWN_SPAN_FIELDS) {
    expanded.delete(known);
  }

  return expanded.size > 0 ? Array.from(expanded) : undefined;
}

/** Accepted values for the --sort flag (matches trace list) */
const VALID_SORT_VALUES: SpanSortValue[] = ["date", "duration"];

/** Default sort order for span results */
const DEFAULT_SORT: SpanSortValue = "date";

/** Default time period for span queries */
const DEFAULT_PERIOD = "7d";

/** Pagination storage key for trace-scoped span listing */
export const PAGINATION_KEY = "span-list";

/** Pagination storage key for project-scoped span listing */
export const PROJECT_PAGINATION_KEY = "span-search";

/** Command name used in resolver error messages (project mode) */
const COMMAND_NAME = "span list";

/** Usage hint for trace-mode ContextError messages */
const TRACE_USAGE_HINT = "sentry span list [<org>/<project>/]<trace-id>";

/**
 * Parse --limit flag, delegating range validation to shared utility.
 */
function parseLimit(value: string): number {
  return validateLimit(value, 1, LIST_MAX_LIMIT);
}

/**
 * Parse and validate sort flag value.
 *
 * @throws Error if value is not "date" or "duration"
 */
export function parseSort(value: string): SpanSortValue {
  if (!VALID_SORT_VALUES.includes(value as SpanSortValue)) {
    throw new Error(
      `Invalid sort value. Must be one of: ${VALID_SORT_VALUES.join(", ")}`
    );
  }
  return value as SpanSortValue;
}

/**
 * Disambiguate span list positional arguments.
 *
 * Thin wrapper around {@link parseDualModeArgs} that binds the
 * trace-mode usage hint for span list.
 */
export function parseSpanListArgs(
  args: string[]
): ReturnType<typeof parseDualModeArgs> {
  return parseDualModeArgs(args, TRACE_USAGE_HINT);
}

// ---------------------------------------------------------------------------
// Next-page hints
// ---------------------------------------------------------------------------

/** Append active non-default flags to a base next-page command. */
function appendFlagHints(
  base: string,
  flags: Pick<ListFlags, "sort" | "query" | "period">
): string {
  const parts: string[] = [];
  if (flags.sort !== DEFAULT_SORT) {
    parts.push(`--sort ${flags.sort}`);
  }
  if (flags.query) {
    parts.push(`-q "${flags.query}"`);
  }
  appendPeriodHint(parts, flags.period, DEFAULT_PERIOD);
  return parts.length > 0 ? `${base} ${parts.join(" ")}` : base;
}

/** Build the CLI hint for fetching the next page in trace mode. */
function traceNextPageHint(
  org: string,
  project: string,
  traceId: string,
  flags: Pick<ListFlags, "sort" | "query" | "period">
): string {
  return appendFlagHints(
    `sentry span list ${org}/${project}/${traceId} -c next`,
    flags
  );
}

/** Build the CLI hint for fetching the previous page in trace mode. */
function tracePrevPageHint(
  org: string,
  project: string,
  traceId: string,
  flags: Pick<ListFlags, "sort" | "query" | "period">
): string {
  return appendFlagHints(
    `sentry span list ${org}/${project}/${traceId} -c prev`,
    flags
  );
}

/** Build the CLI hint for fetching the next page in project mode. */
function projectNextPageHint(
  org: string,
  project: string,
  flags: Pick<ListFlags, "sort" | "query" | "period">
): string {
  return appendFlagHints(`sentry span list ${org}/${project} -c next`, flags);
}

/** Build the CLI hint for fetching the previous page in project mode. */
function projectPrevPageHint(
  org: string,
  project: string,
  flags: Pick<ListFlags, "sort" | "query" | "period">
): string {
  return appendFlagHints(`sentry span list ${org}/${project} -c prev`, flags);
}

// ---------------------------------------------------------------------------
// Output config types and formatters
// ---------------------------------------------------------------------------

/** Structured data returned by the command for both JSON and human output */
type SpanListData = {
  /** Flattened span items for display */
  flatSpans: FlatSpan[];
  /** Whether more results are available beyond the limit */
  hasMore: boolean;
  /** Whether a previous page exists (for bidirectional hints) */
  hasPrev?: boolean;
  /** Opaque cursor for fetching the next page (null/undefined when no more) */
  nextCursor?: string | null;
  /** The trace ID being queried (only in trace mode) */
  traceId?: string;
  /** Org slug for project-mode header */
  org?: string;
  /** Project slug for project-mode header */
  project?: string;
  /** Extra attribute names from --fields for human table columns */
  extraAttributes?: string[];
};

/**
 * Format span list data for human-readable terminal output.
 *
 * Uses `renderMarkdown()` for the header and `formatSpanTable()` for the table,
 * ensuring proper rendering in both TTY and plain output modes.
 * When extra attributes are present (from --fields API expansion), they are
 * appended as additional table columns.
 */
function formatSpanListHuman(data: SpanListData): string {
  if (data.flatSpans.length === 0) {
    return data.hasMore
      ? "No spans on this page."
      : "No spans matched the query.";
  }
  const parts: string[] = [];
  if (data.traceId) {
    parts.push(renderMarkdown(`Spans in trace \`${data.traceId}\`:\n`));
  } else {
    parts.push(`Spans in ${data.org}/${data.project}:\n\n`);
  }
  parts.push(formatSpanTable(data.flatSpans, data.extraAttributes));
  return parts.join("\n");
}

/**
 * Transform span list data for JSON output.
 *
 * Produces a `{ data: [...], hasMore, nextCursor? }` envelope matching the
 * standard paginated list format. Applies `--fields` filtering per element.
 */
function jsonTransformSpanList(data: SpanListData, fields?: string[]): unknown {
  const items =
    fields && fields.length > 0
      ? data.flatSpans.map((item) => filterFields(item, fields))
      : data.flatSpans;
  const envelope: Record<string, unknown> = {
    data: items,
    hasMore: data.hasMore,
    hasPrev: !!data.hasPrev,
  };
  if (
    data.nextCursor !== null &&
    data.nextCursor !== undefined &&
    data.nextCursor !== ""
  ) {
    envelope.nextCursor = data.nextCursor;
  }
  return envelope;
}

// ---------------------------------------------------------------------------
// Mode handlers — extracted from func() to stay under biome complexity limit
// ---------------------------------------------------------------------------

/** Shared context passed to mode handlers from the Stricli command function. */
type ModeContext = {
  cwd: string;
  flags: ListFlags;
  /** Parsed time range from the --period flag */
  timeRange: TimeRange;
  /** Extra API field names derived from --fields (undefined when none needed) */
  extraApiFields?: string[];
};

/**
 * Handle trace mode: list spans within a specific trace.
 *
 * Resolves the trace target, builds a query prefixed with `trace:{id}`,
 * and returns the result with a trace-specific header and hints.
 */
async function handleTraceMode(
  parsed: ParsedTraceTarget,
  ctx: ModeContext
): Promise<{ output: SpanListData; hint?: string }> {
  const { flags, cwd, extraApiFields, timeRange } = ctx;
  warnIfNormalized(parsed, "span.list");
  const { traceId, org, project } = await resolveTraceOrgProject(
    parsed,
    cwd,
    TRACE_USAGE_HINT
  );
  const queryParts = [`trace:${traceId}`];
  if (flags.query) {
    queryParts.push(translateSpanQuery(flags.query));
  }
  const apiQuery = queryParts.join(" ");

  const contextKey = buildPaginationContextKey(
    "span",
    `${org}/${project}/${traceId}`,
    { sort: flags.sort, q: flags.query, period: serializeTimeRange(timeRange) }
  );
  const { cursor, direction } = resolveCursor(
    flags.cursor,
    PAGINATION_KEY,
    contextKey
  );

  const { data: spanItems, nextCursor } = await withProgress(
    { message: `Fetching spans (up to ${flags.limit})...`, json: flags.json },
    () =>
      listSpans(org, project, {
        query: apiQuery,
        sort: flags.sort,
        limit: flags.limit,
        cursor,
        ...timeRangeToApiParams(timeRange),
        extraFields: extraApiFields,
        allProjects: true,
      }).catch((error: unknown): never => {
        // An unparseable user --query is a user input mistake, not a CLI bug.
        throw toSearchQueryError(error, flags.query);
      })
  );

  // Update pagination state (handles both advance and truncation)
  advancePaginationState(PAGINATION_KEY, contextKey, direction, nextCursor);
  const hasPrev = hasPreviousPage(PAGINATION_KEY, contextKey);

  const flatSpans = spanItems.map((item) =>
    spanListItemToFlatSpan(item, extraApiFields)
  );
  const hasMore = !!nextCursor;

  const nav = paginationHint({
    hasPrev,
    hasMore,
    prevHint: tracePrevPageHint(org, project, traceId, flags),
    nextHint: traceNextPageHint(org, project, traceId, flags),
  });

  let hint: string | undefined;
  if (flatSpans.length === 0 && nav) {
    hint = `No spans on this page. ${nav}`;
  } else if (flatSpans.length > 0) {
    const countText = `Showing ${flatSpans.length} span${flatSpans.length === 1 ? "" : "s"}.`;
    hint = nav
      ? `${countText} ${nav}`
      : `${countText} Use 'sentry span view ${traceId} <span-id>' to view span details.`;
  }

  return {
    output: {
      flatSpans,
      hasMore,
      hasPrev,
      nextCursor,
      traceId,
      extraAttributes: extraApiFields,
    },
    hint,
  };
}

/**
 * Handle project mode: list spans across the entire project.
 *
 * Resolves the org/project target and queries the spans dataset
 * without a trace ID filter.
 */
async function handleProjectMode(
  target: string | undefined,
  ctx: ModeContext
): Promise<{ output: SpanListData; hint?: string }> {
  const { flags, cwd, extraApiFields, timeRange } = ctx;
  const { org, project } = await resolveProjectBoundFromArg(
    target,
    cwd,
    COMMAND_NAME
  );
  // Resolve slug → numeric ID so the Events query scopes via the `project`
  // param. `project:<slug>` only matches actively-selected projects (#1317).
  const projectId = await resolveLogProjectId(org, project);
  const apiQuery = flags.query ? translateSpanQuery(flags.query) : undefined;

  const contextKey = buildPaginationContextKey(
    "span-search",
    `${org}/${project}`,
    { sort: flags.sort, q: flags.query, period: serializeTimeRange(timeRange) }
  );
  const { cursor, direction } = resolveCursor(
    flags.cursor,
    PROJECT_PAGINATION_KEY,
    contextKey
  );

  const { data: spanItems, nextCursor } = await withProgress(
    { message: `Fetching spans (up to ${flags.limit})...`, json: flags.json },
    () =>
      listSpans(org, project, {
        query: apiQuery,
        sort: flags.sort,
        limit: flags.limit,
        cursor,
        projectId,
        ...timeRangeToApiParams(timeRange),
        extraFields: extraApiFields,
      }).catch((error: unknown): never => {
        // An unparseable user --query is a user input mistake, not a CLI bug.
        throw toSearchQueryError(error, flags.query);
      })
  );

  // Update pagination state (handles both advance and truncation)
  advancePaginationState(
    PROJECT_PAGINATION_KEY,
    contextKey,
    direction,
    nextCursor
  );
  const hasPrev = hasPreviousPage(PROJECT_PAGINATION_KEY, contextKey);

  const flatSpans = spanItems.map((item) =>
    spanListItemToFlatSpan(item, extraApiFields)
  );
  const hasMore = !!nextCursor;

  const nav = paginationHint({
    hasPrev,
    hasMore,
    prevHint: projectPrevPageHint(org, project, flags),
    nextHint: projectNextPageHint(org, project, flags),
  });

  let hint: string | undefined;
  if (flatSpans.length === 0 && nav) {
    hint = `No spans on this page. ${nav}`;
  } else if (flatSpans.length > 0) {
    const countText = `Showing ${flatSpans.length} span${flatSpans.length === 1 ? "" : "s"}.`;
    hint = nav
      ? `${countText} ${nav}`
      : `${countText} Use 'sentry span view <trace-id> <span-id>' to view span details.`;
  }

  return {
    output: {
      flatSpans,
      hasMore,
      hasPrev,
      nextCursor,
      org,
      project,
      extraAttributes: extraApiFields,
    },
    hint,
  };
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

export const listCommand = buildListCommand("span", {
  docs: {
    brief: "List spans in a project or trace",
    fullDescription:
      "List spans from a Sentry project, or within a specific trace.\n\n" +
      "Project mode (no trace ID):\n" +
      "  sentry span list                        # auto-detect from DSN or config\n" +
      "  sentry span list <org>/<project>        # explicit org and project\n" +
      "  sentry span list <project>              # find project across all orgs\n\n" +
      `${TARGET_PATTERN_NOTE}\n\n` +
      "Trace mode (provide a 32-char trace ID):\n" +
      "  sentry span list <trace-id>                      # auto-detect org/project\n" +
      "  sentry span list <org>/<project>/<trace-id>      # explicit\n" +
      "  sentry span list <project> <trace-id>            # find project + trace\n\n" +
      "Pagination:\n" +
      "  sentry span list -c next                # fetch next page (project mode)\n" +
      "  sentry span list -c prev                # fetch previous page\n" +
      "  sentry span list <trace-id> -c next     # fetch next page (trace mode)\n\n" +
      "Examples:\n" +
      "  sentry span list                        # List recent spans in project\n" +
      '  sentry span list -q "op:db"             # Find all DB spans\n' +
      '  sentry span list -q "duration:>100ms"   # Slow spans\n' +
      "  sentry span list --period 24h           # Last 24 hours only\n" +
      "  sentry span list --sort duration        # Sort by slowest first\n" +
      "  sentry span list <trace-id>             # Spans in a specific trace\n" +
      '  sentry span list <trace-id> -q "op:db"  # DB spans in a trace\n\n' +
      "Alias: `sentry spans` → `sentry span list`",
  },
  output: {
    human: formatSpanListHuman,
    jsonTransform: jsonTransformSpanList,
    schema: SpanListItemSchema,
  },
  parameters: {
    positional: {
      kind: "array",
      parameter: {
        placeholder: "org/project/trace-id",
        brief: "[<org>/<project>] or [<org>/<project>/]<trace-id>",
        parse: String,
      },
    },
    flags: {
      limit: {
        kind: "parsed",
        parse: parseLimit,
        brief: `Number of spans (<=${LIST_MAX_LIMIT})`,
        default: String(LIST_DEFAULT_LIMIT),
      },
      query: {
        kind: "parsed",
        parse: sanitizeQuery,
        brief:
          'Filter spans (e.g., "op:db", "project:backend", "project:[cli,api]")',
        optional: true,
      },
      sort: {
        kind: "parsed",
        parse: parseSort,
        brief: `Sort order: ${VALID_SORT_VALUES.join(", ")}`,
        default: DEFAULT_SORT,
      },
      period: LIST_PERIOD_FLAG,
    },
    aliases: {
      ...PERIOD_ALIASES,
      n: "limit",
      q: "query",
      s: "sort",
    },
  },
  async *func(this: SentryContext, flags: ListFlags, ...args: string[]) {
    const { cwd } = this;
    const timeRange = flags.period;
    const parsed = parseSpanListArgs(args);
    const extraApiFields = extractExtraApiFields(flags.fields);
    const modeCtx: ModeContext = {
      cwd,
      flags,
      timeRange,
      extraApiFields,
    };

    const { output, hint } =
      parsed.mode === "trace"
        ? await handleTraceMode(parsed.parsed, modeCtx)
        : await handleProjectMode(parsed.target, modeCtx);

    yield new CommandOutput(output);
    return { hint };
  },
});
