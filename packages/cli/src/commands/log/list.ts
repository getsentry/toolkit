/**
 * sentry log list
 *
 * List logs from Sentry projects, or the logs of a trace when the positional
 * is a trace ID. `sentry log tail` streams new logs instead.
 */

import type { SentryContext } from "../../context.js";
import {
  type LogSortDirection,
  listLogs,
  listTraceLogs,
} from "../../lib/api-client.js";
import { sentry } from "../../lib/app-identity.js";
import {
  buildProjectQuery,
  parseLogSort,
  validateLimit,
} from "../../lib/arg-parsing.js";
import { textParser } from "../../lib/completion-target.js";
import { toSearchQueryError, ValidationError } from "../../lib/errors.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  buildListCommand,
  LIST_MAX_LIMIT,
  LIST_MIN_LIMIT,
  TARGET_PATTERN_NOTE,
} from "../../lib/list-command.js";
import { logger } from "../../lib/logger.js";
import { withProgress } from "../../lib/polling.js";
import { resolveLogProjectId } from "../../lib/resolve-target.js";
import { sanitizeQuery } from "../../lib/search-query.js";
import {
  PERIOD_BRIEF,
  parsePeriod,
  TIME_RANGE_14D,
  TIME_RANGE_30D,
  type TimeRange,
  timeRangeToApiParams,
} from "../../lib/time-range.js";
import { SentryLogSchema } from "../../generated/output-schemas/log.js";
import {
  createLogRenderer,
  jsonTransformLogOutput,
  type LogListArguments,
  type LogListResult,
  logTargetArguments,
} from "./shared.js";

type ListFlags = {
  readonly limit: number;
  readonly query?: string;
  /** Removed: streaming moved to `log tail`. Hidden, kept to say so. */
  readonly follow?: string;
  readonly period?: TimeRange;
  readonly sort: LogSortDirection;
  readonly json: boolean;
  readonly fresh: boolean;
  readonly fields?: string[];
};

/**
 * Parse --limit flag, delegating range validation to shared utility.
 */
function parseLimit(value: string): number {
  return validateLimit(value, LIST_MIN_LIMIT, LIST_MAX_LIMIT);
}

/** Result from a single fetch: logs to yield + hint for the footer. */
type FetchResult = {
  result: LogListResult;
  hint: string;
};

/**
 * Execute a single fetch of logs (non-streaming mode).
 *
 * Returns the logs and a hint. The caller yields the result and
 * returns the hint as a footer via `CommandReturn`.
 */
async function executeSingleFetch(
  org: string,
  project: string,
  flags: ListFlags,
  options: { timeRange: TimeRange; projectId?: number | undefined },
): Promise<FetchResult> {
  const { timeRange, projectId } = options;
  const logs = await listLogs(org, project, {
    query: flags.query,
    limit: flags.limit,
    ...timeRangeToApiParams(timeRange),
    sort: flags.sort,
    extraFields: flags.fields,
    projectId,
  }).catch((error: unknown): never => {
    // An unparseable user --query is a user input mistake, not a CLI bug.
    throw toSearchQueryError(error, flags.query);
  });

  const periodLabel =
    timeRange.type === "relative"
      ? `in the last ${timeRange.period}`
      : "in the specified range";

  const extraFields = flags.fields?.length ? flags.fields : undefined;

  if (logs.length === 0) {
    return {
      result: { logs: [], hasMore: false, extraFields },
      hint: `No logs found ${periodLabel}.`,
    };
  }

  const hasMore = logs.length >= flags.limit;
  const countText = `Showing ${logs.length} log${logs.length === 1 ? "" : "s"}.`;
  const tip = hasMore
    ? ` Use --limit to show more, or '${sentry`log tail`}' to stream new logs.`
    : "";

  return {
    result: { logs, hasMore, extraFields },
    hint: `${countText}${tip}`,
  };
}

/** Options for {@link executeTraceSingleFetch}. */
type TraceFetchOptions = {
  flags: ListFlags;
  timeRange: TimeRange;
  /** Project slug for API-level filtering (from org/project/trace-id syntax) */
  projectFilter?: string | undefined;
};

/**
 * Execute a single fetch of trace-filtered logs (non-streaming, trace mode).
 * Uses the dedicated trace-logs endpoint which is org-scoped.
 *
 * When `projectFilter` is provided, `project:{slug}` is prepended to the query
 * for API-level filtering, and the hint includes a copy-pasteable unfiltered command.
 *
 * Returns the fetched logs, trace ID, and a human-readable hint.
 * The caller (via the output config) handles rendering to stdout.
 */
async function executeTraceSingleFetch(
  org: string,
  traceId: string,
  options: TraceFetchOptions,
): Promise<FetchResult> {
  const { flags, timeRange, projectFilter } = options;
  const query = buildProjectQuery(flags.query, projectFilter);
  const logs = await listTraceLogs(org, traceId, {
    query,
    limit: flags.limit,
    ...timeRangeToApiParams(timeRange),
    sort: flags.sort,
  }).catch((error: unknown): never => {
    // An unparseable user --query is a user input mistake, not a CLI bug.
    throw toSearchQueryError(error, flags.query);
  });

  const periodLabel =
    timeRange.type === "relative"
      ? `in the last ${timeRange.period}`
      : "in the specified range";

  if (logs.length === 0) {
    return {
      result: { logs: [], traceId, hasMore: false },
      hint:
        `No logs found for trace ${traceId} ${periodLabel}.\n\n` +
        `Try '${sentry`trace logs`}' for more options (e.g., --period 30d).`,
    };
  }

  const hasMore = logs.length >= flags.limit;
  const countText = `Showing ${logs.length} log${logs.length === 1 ? "" : "s"} for trace ${traceId}.`;
  const tip = hasMore ? " Use --limit to show more." : "";

  // Build hint with real values for easy copy-paste
  let hint = `${countText}${tip}`;
  if (projectFilter) {
    hint += `\nFiltered to project '${projectFilter}'. Full trace logs: ${sentry`log list ${org}/${traceId}`}`;
  } else {
    hint += `\nFilter by project: ${sentry`log list ${org}/<project>/${traceId}`}`;
  }

  return {
    result: { logs, traceId, hasMore },
    hint,
  };
}

export const listCommand = buildListCommand(
  "log",
  {
    docs: {
      brief: "List logs from a project",
      fullDescription:
        "List logs from Sentry projects. To stream new logs as they arrive, use `sentry log tail`.\n\n" +
        `${TARGET_PATTERN_NOTE}\n\n` +
        "Pass a 32-character trace ID instead of a project to filter by trace.\n\n" +
        "Alias: `sentry logs` → `sentry log list`",
      examples: [
        { description: "List the last 100 logs", run: "log list" },
        {
          description: "Show only error logs",
          run: "log list -q 'severity:error'",
        },
        {
          description: "Filter by message content",
          run: "log list -q 'database'",
        },
        {
          description: "Match a regular expression (key://pattern//)",
          run: "log list -q 'message://^Timeout after \\d+ms//'",
        },
        {
          description: "Show the last 50 logs",
          run: "log list --limit 50",
        },
        {
          description: "List logs for a trace",
          run: "log list abc123def456abc123def456abc12345",
        },
        {
          description: "Filter JSON output with jq",
          run: "log list --json | jq '.data[] | select(.severity == \"error\")'",
        },
        {
          description: "Filter by trace in an explicit organization",
          run: "log list my-org/abc123def456abc123def456abc12345",
        },
      ],
    },
    output: {
      human: createLogRenderer,
      jsonTransform: jsonTransformLogOutput,
      schema: SentryLogSchema,
    },
    parameters: {
      positional: logTargetArguments("log list"),
      flags: {
        limit: {
          kind: "parsed",
          parse: textParser(parseLimit),
          brief: `Number of log entries (${LIST_MIN_LIMIT}-${LIST_MAX_LIMIT})`,
          default: "100", // Logs are high-volume; 25 is too stingy for debugging
        },
        query: {
          kind: "parsed",
          parse: sanitizeQuery,
          brief:
            'Filter query (e.g., "severity:error", "project:backend", "project:[a,b]")',
          optional: true,
        },
        follow: {
          kind: "parsed",
          parse: textParser(String),
          brief: "Removed: use `sentry log tail`",
          optional: true,
          inferEmpty: true,
          hidden: true,
        },
        period: {
          kind: "parsed",
          parse: parsePeriod,
          brief: PERIOD_BRIEF,
          optional: true,
        },
        sort: {
          kind: "parsed",
          parse: parseLogSort,
          brief: 'Sort order: "newest" (default) or "oldest"',
          default: "newest",
        },
      },
      aliases: {
        n: "limit",
        q: "query",
        t: "period",
        s: "sort",
      },
    },
    async *func(
      this: SentryContext,
      flags: ListFlags,
      target: LogListArguments,
    ) {
      if (flags.follow !== undefined) {
        throw new ValidationError(
          `--follow moved to its own command: ${sentry`log tail`}. ` +
            "Pass the same target and --query; set the poll interval with --interval.",
          "follow",
        );
      }

      // Resolve mode-dependent default period
      const timeRange =
        flags.period ??
        (target.parsed.mode === "trace" ? TIME_RANGE_14D : TIME_RANGE_30D);

      const resolved = await target.resolved;
      if (resolved.mode === "trace") {
        // Trace mode: use the org-scoped trace-logs endpoint.
        const { traceId, org, projectFilter } = resolved;

        // Warn if --fields was passed — the trace-logs endpoint has a fixed
        // field set and doesn't support arbitrary extra fields.
        if (flags.fields?.length) {
          logger.warn(
            "--fields is not supported for trace-scoped log queries. Use project-scoped mode instead.",
          );
        }

        const { result, hint } = await withProgress(
          {
            message: `Fetching logs (up to ${flags.limit})...`,
            json: flags.json,
          },
          () =>
            executeTraceSingleFetch(org, traceId, {
              flags,
              timeRange,
              projectFilter,
            }),
        );
        yield new CommandOutput(result);
        return { hint };
      }

      // Standard project-scoped mode
      {
        const { org, project } = resolved;
        // Resolve the slug to a numeric project ID so the Events query scopes
        // via the `project` param. The `project:<slug>` filter only matches
        // actively-selected projects and can otherwise return no logs (#1317).
        const projectId = await resolveLogProjectId(org, project);
        const { result, hint } = await withProgress(
          {
            message: `Fetching logs (up to ${flags.limit})...`,
            json: flags.json,
          },
          () =>
            executeSingleFetch(org, project, flags, { timeRange, projectId }),
        );
        yield new CommandOutput(result);
        return { hint };
      }
    },
  },
  { noCursorFlag: true },
);
