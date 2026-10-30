/**
 * sentry trace logs
 *
 * View logs associated with a distributed trace.
 */

import type { SentryContext } from "../../context.js";
import { type LogSortDirection, listTraceLogs } from "../../lib/api-client.js";
import {
  buildProjectQuery,
  parseLogSort,
  validateLimit,
} from "../../lib/arg-parsing.js";
import { openInBrowser } from "../../lib/browser.js";
import { buildCommand } from "../../lib/command.js";
import { toSearchQueryError } from "../../lib/errors.js";
import { filterFields } from "../../lib/formatters/json.js";
import { formatLogTable } from "../../lib/formatters/log.js";
import { CommandOutput, formatFooter } from "../../lib/formatters/output.js";
import {
  applyFreshFlag,
  FRESH_ALIASES,
  FRESH_FLAG,
  LIST_MAX_LIMIT,
} from "../../lib/list-command.js";
import { withProgress } from "../../lib/polling.js";
import {
  type BoundArguments,
  boundArguments,
} from "../../lib/positional-parse.js";
import { sanitizeQuery } from "../../lib/search-query.js";
import { buildTraceUrl } from "../../lib/sentry-web-urls.js";
import {
  formatTimeRangeFlag,
  PERIOD_BRIEF,
  parsePeriod,
  type TimeRange,
  timeRangeToApiParams,
} from "../../lib/time-range.js";
import {
  applyTraceTargetInput,
  parseTraceTargetInput,
  type ResolvedTraceOrg,
  resolveTraceOrg,
  type TraceTargetInput,
  warnIfNormalized,
} from "../../lib/trace-target.js";

type LogsFlags = {
  readonly json: boolean;
  readonly web: boolean;
  readonly period: TimeRange;
  readonly limit: number;
  readonly query?: string;
  readonly sort: LogSortDirection;
  readonly fresh: boolean;
  readonly fields?: string[];
};

/** Minimal log shape shared with the formatters. */
type LogLike = {
  timestamp: string;
  severity?: string | null;
  message?: string | null;
  trace?: string | null;
};

/** Data yielded by the trace logs command. */
type TraceLogsData = {
  logs: LogLike[];
  traceId: string;
  hasMore: boolean;
  /** Message shown when no logs found */
  emptyMessage?: string;
};

/** Format trace log results as human-readable table output. */
function formatTraceLogsHuman(data: TraceLogsData): string {
  if (data.logs.length === 0) {
    return data.emptyMessage ?? "No logs found.";
  }
  const parts = [formatLogTable(data.logs, false)];
  const countText = `Showing ${data.logs.length} log${data.logs.length === 1 ? "" : "s"} for trace ${data.traceId}.`;
  const tip = data.hasMore ? " Use --limit to show more." : "";
  parts.push(formatFooter(`${countText}${tip}`));
  return parts.join("").trimEnd();
}

/**
 * Default time period for the trace-logs API.
 * The API requires statsPeriod — without it the response may be empty even
 * when logs exist for the trace.
 */
const DEFAULT_PERIOD = "14d";

/** Usage hint shown in error messages */
const USAGE_HINT = "sentry trace logs [<org>/[<project>/]]<trace-id>";

/**
 * Parse --limit flag, delegating range validation to shared utility.
 */
function parseLimit(value: string): number {
  return validateLimit(value, 1, LIST_MAX_LIMIT);
}

/** `trace logs` arguments, resolved. */
type TraceLogsTarget = ResolvedTraceOrg & {
  /** Project the user named, to filter the trace's logs by */
  readonly projectFilter?: string;
};

/** The arguments of `trace logs`. */
type TraceLogsArguments = BoundArguments<TraceTargetInput, TraceLogsTarget>;

/** Parse `trace logs` arguments, without side effects. */
function parseTraceLogsInput(args: readonly string[]): TraceTargetInput {
  return parseTraceTargetInput(args, USAGE_HINT);
}

/**
 * Resolve `trace logs` arguments to the trace's org; a project the user
 * named becomes a filter.
 */
async function resolveTraceLogsTarget(
  input: TraceTargetInput,
  context: SentryContext,
): Promise<TraceLogsTarget> {
  const parsed = applyTraceTargetInput(input);
  warnIfNormalized(parsed, "trace.logs");
  const { traceId, org } = await resolveTraceOrg(
    parsed,
    context.cwd,
    USAGE_HINT,
  );
  return {
    traceId,
    org,
    projectFilter: parsed.type === "explicit" ? parsed.project : undefined,
  };
}

export const logsCommand = buildCommand({
  docs: {
    brief: "View logs associated with a trace",
    fullDescription:
      "View logs associated with a specific distributed trace.\n\n" +
      "When a project is specified, only logs from that project are shown.\n" +
      "Use --query 'project:[a,b]' to filter to multiple projects.\n\n" +
      "The trace ID is the 32-character hexadecimal identifier.",
    examples: [
      {
        description: "View logs for a trace",
        command: "sentry trace logs abc123def456abc123def456abc12345",
      },
      {
        description: "Filter trace logs to one project",
        command:
          "sentry trace logs my-org/cli-server/abc123def456abc123def456abc12345",
      },
      {
        description: "Filter trace logs to several projects",
        command:
          'sentry trace logs abc123def456abc123def456abc12345 -q "project:[cli-server,api]"',
      },
      {
        description: "Search with a longer time window",
        command:
          "sentry trace logs --period 30d abc123def456abc123def456abc12345",
      },
      {
        description: "Only error logs",
        command:
          "sentry trace logs -q 'severity:error' abc123def456abc123def456abc12345",
      },
      {
        description: "Output as JSON",
        command: "sentry trace logs --json abc123def456abc123def456abc12345",
      },
      {
        description: "Logs for a trace in an explicit organization",
        command: "sentry trace logs my-org/abc123def456abc123def456abc12345",
      },
    ],
  },
  output: {
    human: formatTraceLogsHuman,
    jsonTransform: (data: TraceLogsData, fields?: string[]) => {
      const items =
        fields && fields.length > 0
          ? data.logs.map((entry) => filterFields(entry, fields))
          : data.logs;
      return { data: items, hasMore: data.hasMore };
    },
  },
  parameters: {
    positional: boundArguments({
      placeholder: "org/project/trace-id",
      brief:
        "[<org>/[<project>/]]<trace-id> - Optional org/project and required trace ID",
      kind: "org/project",
      parse: parseTraceLogsInput,
      resolve: resolveTraceLogsTarget,
    }),
    flags: {
      web: {
        kind: "boolean",
        brief: "Open trace in browser",
        default: false,
      },
      period: {
        kind: "parsed",
        parse: parsePeriod,
        brief: PERIOD_BRIEF,
        default: DEFAULT_PERIOD,
      },
      limit: {
        kind: "parsed",
        parse: parseLimit,
        brief: `Number of log entries (<=${LIST_MAX_LIMIT})`,
        default: "100", // Logs are high-volume; 25 is too stingy for debugging
      },
      query: {
        kind: "parsed",
        parse: sanitizeQuery,
        brief:
          'Filter query (e.g., "severity:error", "project:backend", "project:[a,b]")',
        optional: true,
      },
      sort: {
        kind: "parsed",
        parse: parseLogSort,
        brief: 'Sort order: "newest" (default) or "oldest"',
        default: "newest",
      },
      fresh: FRESH_FLAG,
    },
    aliases: {
      ...FRESH_ALIASES,
      w: "web",
      t: "period",
      n: "limit",
      q: "query",
      s: "sort",
    },
  },
  async *func(
    this: SentryContext,
    flags: LogsFlags,
    target: TraceLogsArguments,
  ) {
    applyFreshFlag(flags);
    const timeRange = flags.period;
    const { traceId, org, projectFilter } = await target.resolved;

    if (flags.web) {
      await openInBrowser(buildTraceUrl(org, traceId), "trace");
      return;
    }

    // Prepend project filter to the query when user explicitly specified a project
    const query = buildProjectQuery(flags.query, projectFilter);

    const logs = await withProgress(
      {
        message: `Fetching trace logs (up to ${flags.limit})...`,
        json: flags.json,
      },
      () =>
        listTraceLogs(org, traceId, {
          ...timeRangeToApiParams(timeRange),
          limit: flags.limit,
          query,
          sort: flags.sort,
        }).catch((error: unknown): never => {
          // An unparseable user --query is a user input mistake, not a CLI bug.
          throw toSearchQueryError(error, flags.query);
        }),
    );

    const hasMore = logs.length >= flags.limit;

    const emptyMessage =
      `No logs found for trace ${traceId} in the last ${formatTimeRangeFlag(flags.period)}.\n\n` +
      `Try a longer period: sentry trace logs --period 30d ${traceId}`;

    yield new CommandOutput({
      logs,
      traceId,
      hasMore,
      emptyMessage,
    });

    // Build hint with real values for easy copy-paste
    if (projectFilter) {
      return {
        hint: `Filtered to project '${projectFilter}'. Full trace logs: sentry trace logs ${org}/${traceId}`,
      };
    }
    return {
      hint: `Filter by project: sentry trace logs ${org}/<project>/${traceId}`,
    };
  },
});
