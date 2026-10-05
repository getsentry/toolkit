/**
 * sentry trace list
 *
 * List recent traces from Sentry projects.
 */

import type { SentryContext } from "../../context.js";
import { listTransactions } from "../../lib/api-client.js";
import { validateLimit } from "../../lib/arg-parsing.js";
import {
  advancePaginationState,
  buildPaginationContextKey,
  hasPreviousPage,
  resolveCursor,
} from "../../lib/db/pagination.js";
import { toSearchQueryError } from "../../lib/errors.js";
import { formatTraceTable } from "../../lib/formatters/index.js";
import { filterFields } from "../../lib/formatters/json.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  buildListCommand,
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  LIST_MIN_LIMIT,
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
  type TransactionListItem,
  TransactionListItemSchema,
} from "../../types/index.js";

type ListFlags = {
  readonly limit: number;
  readonly query?: string;
  readonly sort: "date" | "duration";
  readonly period: TimeRange;
  readonly json: boolean;
  readonly cursor?: string;
  readonly fresh: boolean;
  readonly fields?: string[];
};

type SortValue = "date" | "duration";

/**
 * Result data for the trace list command.
 *
 * Contains the traces array plus pagination metadata and context
 * needed by both the human formatter and JSON transform.
 */
type TraceListResult = {
  /** The list of transactions returned by the API */
  traces: TransactionListItem[];
  /** Whether more pages are available */
  hasMore: boolean;
  /** Whether a previous page exists (for bidirectional hints) */
  hasPrev?: boolean;
  /** Opaque cursor for fetching the next page (null/undefined when no more) */
  nextCursor?: string | null;
  /** Org slug (used by human formatter for display and next-page hint) */
  org: string;
  /** Project slug (used by human formatter for display and next-page hint) */
  project: string;
};

/** Accepted values for the --sort flag */
const VALID_SORT_VALUES: SortValue[] = ["date", "duration"];

/** Command name used in resolver error messages */
const COMMAND_NAME = "trace list";

/** Command key for pagination cursor storage */
export const PAGINATION_KEY = "trace-list";

/** Default time period for trace queries */
const DEFAULT_PERIOD = "7d";

/** Append active non-default flags to a base command string. */
function appendTraceFlags(
  base: string,
  flags: Pick<ListFlags, "sort" | "query" | "period">
): string {
  const parts: string[] = [];
  if (flags.sort !== "date") {
    parts.push(`--sort ${flags.sort}`);
  }
  if (flags.query) {
    parts.push(`-q "${flags.query}"`);
  }
  appendPeriodHint(parts, flags.period, DEFAULT_PERIOD);
  return parts.length > 0 ? `${base} ${parts.join(" ")}` : base;
}

/** Build the CLI hint for fetching the next page, preserving active flags. */
function nextPageHint(
  org: string,
  project: string,
  flags: Pick<ListFlags, "sort" | "query" | "period">
): string {
  return appendTraceFlags(`sentry trace list ${org}/${project} -c next`, flags);
}

/** Build the CLI hint for fetching the previous page, preserving active flags. */
function prevPageHint(
  org: string,
  project: string,
  flags: Pick<ListFlags, "sort" | "query" | "period">
): string {
  return appendTraceFlags(`sentry trace list ${org}/${project} -c prev`, flags);
}

/**
 * Parse --limit flag, delegating range validation to shared utility.
 */
function parseLimit(value: string): number {
  return validateLimit(value, LIST_MIN_LIMIT, LIST_MAX_LIMIT);
}

/**
 * Parse and validate sort flag value.
 *
 * @throws Error if value is not "date" or "duration"
 * @internal Exported for testing
 */
export function parseSort(value: string): SortValue {
  if (!VALID_SORT_VALUES.includes(value as SortValue)) {
    throw new Error(
      `Invalid sort value. Must be one of: ${VALID_SORT_VALUES.join(", ")}`
    );
  }
  return value as SortValue;
}

/**
 * Format trace list data for human-readable terminal output.
 *
 * Handles three display states:
 * - Empty list with more pages → "No traces on this page."
 * - Empty list, no more pages → "No traces found."
 * - Non-empty → header line + formatted table
 */
function formatTraceListHuman(result: TraceListResult): string {
  const { traces, hasMore, org, project } = result;

  if (traces.length === 0) {
    return hasMore ? "No traces on this page." : "No traces found.";
  }

  return `Recent traces in ${org}/${project}:\n\n${formatTraceTable(traces)}`;
}

/**
 * Transform trace list data into the JSON list envelope.
 *
 * Produces the standard `{ data, hasMore, nextCursor? }` envelope.
 * Field filtering is applied per-element inside `data` (not to the
 * wrapper), matching the behaviour of `writeJsonList`.
 */
function jsonTransformTraceList(
  result: TraceListResult,
  fields?: string[]
): unknown {
  const items =
    fields && fields.length > 0
      ? result.traces.map((t) => filterFields(t, fields))
      : result.traces;

  const envelope: Record<string, unknown> = {
    data: items,
    hasMore: result.hasMore,
    hasPrev: !!result.hasPrev,
  };
  if (
    result.nextCursor !== null &&
    result.nextCursor !== undefined &&
    result.nextCursor !== ""
  ) {
    envelope.nextCursor = result.nextCursor;
  }
  return envelope;
}

export const listCommand = buildListCommand("trace", {
  docs: {
    brief: "List recent traces in a project",
    fullDescription:
      "List recent traces from Sentry projects.\n\n" +
      "Target patterns:\n" +
      "  sentry trace list               # auto-detect from DSN or config\n" +
      "  sentry trace list <org>/<proj>  # explicit org and project\n" +
      "  sentry trace list <project>     # find project across all orgs\n\n" +
      `${TARGET_PATTERN_NOTE}\n\n` +
      "Examples:\n" +
      "  sentry trace list                     # List last 10 traces\n" +
      "  sentry trace list --limit 50          # Show more traces\n" +
      "  sentry trace list --sort duration     # Sort by slowest first\n" +
      "  sentry trace list --period 24h        # Last 24 hours only\n" +
      '  sentry trace list -q "transaction:GET /api/users"  # Filter by transaction\n\n' +
      "Alias: `sentry traces` → `sentry trace list`",
  },
  output: {
    human: formatTraceListHuman,
    jsonTransform: jsonTransformTraceList,
    schema: TransactionListItemSchema,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "org/project",
          brief: "<org>/<project> or <project> (search)",
          parse: String,
          optional: true,
        },
      ],
    },
    flags: {
      limit: {
        kind: "parsed",
        parse: parseLimit,
        brief: `Number of traces (${LIST_MIN_LIMIT}-${LIST_MAX_LIMIT})`,
        default: String(LIST_DEFAULT_LIMIT),
      },
      query: {
        kind: "parsed",
        parse: sanitizeQuery,
        brief: "Search query (Sentry search syntax)",
        optional: true,
      },
      sort: {
        kind: "parsed",
        parse: parseSort,
        brief: "Sort by: date, duration",
        default: "date" as const,
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
  async *func(this: SentryContext, flags: ListFlags, target?: string) {
    const { cwd } = this;
    const timeRange = flags.period;
    const { query } = flags;

    // Resolve org/project from positional arg, config, or DSN auto-detection
    const { org, project } = await resolveProjectBoundFromArg(
      target,
      cwd,
      COMMAND_NAME
    );
    // Resolve slug → numeric ID so the Events query scopes via the `project`
    // param. `project:<slug>` only matches actively-selected projects and can
    // otherwise 400 with "not actively selected" (#1317).
    const projectId = await resolveLogProjectId(org, project);
    // Build context key and resolve cursor for pagination
    const contextKey = buildPaginationContextKey("trace", `${org}/${project}`, {
      sort: flags.sort,
      q: query,
      period: serializeTimeRange(timeRange),
    });
    const { cursor, direction } = resolveCursor(
      flags.cursor,
      PAGINATION_KEY,
      contextKey
    );

    const { data: traces, nextCursor } = await withProgress(
      {
        message: `Fetching traces (up to ${flags.limit})...`,
        json: flags.json,
      },
      () =>
        listTransactions(org, project, {
          query,
          limit: flags.limit,
          sort: flags.sort,
          cursor,
          projectId,
          ...timeRangeToApiParams(timeRange),
        }).catch((error: unknown): never => {
          // An unparseable user --query is a user input mistake, not a CLI bug.
          throw toSearchQueryError(error, flags.query);
        })
    );

    // Update pagination state (handles both advance and truncation)
    advancePaginationState(PAGINATION_KEY, contextKey, direction, nextCursor);
    const hasPrev = hasPreviousPage(PAGINATION_KEY, contextKey);

    const hasMore = !!nextCursor;

    // Build footer hint based on result state
    const nav = paginationHint({
      hasMore,
      hasPrev,
      prevHint: prevPageHint(org, project, flags),
      nextHint: nextPageHint(org, project, flags),
    });
    let hint: string | undefined;
    if (traces.length === 0 && nav) {
      hint = `No traces on this page. ${nav}`;
    } else if (traces.length > 0) {
      const countText = `Showing ${traces.length} trace${traces.length === 1 ? "" : "s"}.`;
      hint = nav
        ? `${countText} ${nav}`
        : `${countText} Use 'sentry trace view <TRACE_ID>' to view the full span tree.`;
    }

    yield new CommandOutput({
      traces,
      hasMore,
      hasPrev,
      nextCursor,
      org,
      project,
    });
    return { hint };
  },
});
