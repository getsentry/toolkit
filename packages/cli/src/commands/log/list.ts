/**
 * sentry log list
 *
 * List and stream logs from Sentry projects.
 * Supports real-time streaming with --follow flag.
 * Supports trace ID as a positional argument to filter logs by trace.
 */

// biome-ignore lint/performance/noNamespaceImport: Sentry SDK recommends namespace import
import * as Sentry from "@sentry/node-core/light";
import type { SentryContext } from "../../context.js";
import {
  type LogSortDirection,
  listLogs,
  listTraceLogs,
} from "../../lib/api-client.js";
import {
  buildProjectQuery,
  parseLogSort,
  validateLimit,
} from "../../lib/arg-parsing.js";
import {
  AuthError,
  stringifyUnknown,
  toSearchQueryError,
  ValidationError,
} from "../../lib/errors.js";
import {
  type LogLike as BaseLogLike,
  buildLogRowCells,
  createLogStreamingTable,
  formatLogRow,
  formatLogsHeader,
  isPlainOutput,
} from "../../lib/formatters/index.js";
import { filterFields } from "../../lib/formatters/json.js";
import { renderInlineMarkdown } from "../../lib/formatters/markdown.js";
import {
  CommandOutput,
  formatFooter,
  type HumanRenderer,
} from "../../lib/formatters/output.js";
import type { StreamingTable } from "../../lib/formatters/text-table.js";
import {
  buildListCommand,
  LIST_MAX_LIMIT,
  LIST_MIN_LIMIT,
  TARGET_PATTERN_NOTE,
} from "../../lib/list-command.js";
import { logger } from "../../lib/logger.js";
import { withProgress } from "../../lib/polling.js";
import {
  resolveLogProjectId,
  resolveProjectBoundFromArg,
} from "../../lib/resolve-target.js";
import { sanitizeQuery } from "../../lib/search-query.js";
import {
  PERIOD_BRIEF,
  parsePeriod,
  TIME_RANGE_14D,
  TIME_RANGE_30D,
  type TimeRange,
  timeRangeToApiParams,
} from "../../lib/time-range.js";
import {
  parseDualModeArgs,
  resolveTraceOrg,
  warnIfNormalized,
} from "../../lib/trace-target.js";
import { getUpdateNotification } from "../../lib/version-check.js";
import { SentryLogSchema } from "../../types/index.js";

type ListFlags = {
  readonly limit: number;
  readonly query?: string;
  readonly follow?: number;
  readonly period?: TimeRange;
  readonly sort: LogSortDirection;
  readonly json: boolean;
  readonly fresh: boolean;
  readonly fields?: string[];
};

/**
 * Result yielded by the log list command in single-fetch mode.
 *
 * Contains the full array of logs and optional trace context.
 * Follow mode yields bare {@link LogLike} items instead — see
 * {@link LogOutput} for the union type.
 */
type LogListResult = {
  logs: LogLike[];
  /** Trace ID, present for trace-filtered queries */
  traceId?: string;
  /** Whether more results are available beyond the limit */
  hasMore: boolean;
  /** Extra field names requested via `--fields`, used to render additional columns in human mode. */
  extraFields?: string[];
};

/** Output yielded by log list: either a batch (single-fetch) or an individual item (follow). */
type LogOutput = LogLike | LogListResult;

/** Default poll interval in seconds for --follow mode */
const DEFAULT_POLL_INTERVAL = 2;

/** Command name used in resolver error messages */
const COMMAND_NAME = "log list";

/** Usage hint for trace mode error messages */
const TRACE_USAGE_HINT = "sentry log list [<org>/[<project>/]]<trace-id>";

/**
 * Parse --limit flag, delegating range validation to shared utility.
 */
function parseLimit(value: string): number {
  return validateLimit(value, LIST_MIN_LIMIT, LIST_MAX_LIMIT);
}

/**
 * Parse --follow flag value.
 * Supports: -f (empty string → default interval), -f 10 (explicit interval)
 *
 * @throws Error if value is not a positive integer
 */
function parseFollow(value: string): number {
  if (value === "") {
    return DEFAULT_POLL_INTERVAL;
  }
  const num = Number.parseInt(value, 10);
  if (Number.isNaN(num) || num < 1) {
    throw new Error("--follow interval must be a positive integer");
  }
  return num;
}

/**
 * Extends the base {@link BaseLogLike} from formatters with the
 * `timestamp_precise` field needed for follow-mode dedup tracking.
 */
type LogLike = BaseLogLike & {
  /** Nanosecond-precision timestamp used for dedup in follow mode.
   * Optional because TraceLog may omit it when the API response doesn't include it. */
  timestamp_precise?: number;
};

/** Result from a single fetch: logs to yield + hint for the footer. */
type FetchResult = {
  result: LogListResult;
  hint: string;
};

// ---------------------------------------------------------------------------
// Positional argument disambiguation
// ---------------------------------------------------------------------------

/**
 * Disambiguate log list positional arguments.
 *
 * Thin wrapper around {@link parseDualModeArgs} that binds the
 * trace-mode usage hint for log list.
 */
function parseLogListArgs(
  args: string[]
): ReturnType<typeof parseDualModeArgs> {
  return parseDualModeArgs(args, TRACE_USAGE_HINT);
}

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
  options: { timeRange: TimeRange; projectId?: number }
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
  const tip = hasMore ? " Use --limit to show more, or -f to follow." : "";

  return {
    result: { logs, hasMore, extraFields },
    hint: `${countText}${tip}`,
  };
}

// ---------------------------------------------------------------------------
// Streaming follow-mode infrastructure
// ---------------------------------------------------------------------------

/**
 * Sleep that resolves early when an AbortSignal fires.
 * Resolves (not rejects) on abort for clean generator shutdown.
 */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Configuration for the follow-mode async generator.
 *
 * Parameterized over the log type to handle both project-scoped
 * (`SentryLog`) and trace-scoped (`TraceLog`) streaming.
 *
 * Unlike the old callback-based approach, this does NOT include
 * stdout/stderr. All stdout output flows through yielded chunks;
 * diagnostics are reported via the `onDiagnostic` callback.
 */
type FollowGeneratorConfig<T extends LogLike> = {
  flags: ListFlags;
  /** Report diagnostic/error messages (caller logs via logger) */
  onDiagnostic: (message: string) => void;
  /**
   * Fetch logs with the given time window.
   * @param statsPeriod - Time window (e.g., "1m" for initial, "10m" for polls)
   * @param afterTimestamp - Only return logs newer than this (nanoseconds).
   *   Standard mode passes this for server-side dedup; trace mode ignores it.
   */
  fetch: (statsPeriod: string, afterTimestamp?: number) => Promise<T[]>;
  /** Extract only the genuinely new entries from a poll response */
  extractNew: (logs: T[], lastTimestamp: number) => T[];
  /**
   * Called with the initial batch of logs before polling begins.
   * Use this to seed dedup state (e.g., tracking seen log IDs).
   */
  onInitialLogs?: (logs: T[]) => void;
  /**
   * External abort signal (library mode). When aborted, the follow
   * generator stops on the next poll cycle. Complements SIGINT handling.
   */
  abortSignal?: AbortSignal;
};

/** Find the highest timestamp_precise in a batch, or undefined if none have it. */
function maxTimestamp(logs: LogLike[]): number | undefined {
  let max: number | undefined;
  for (const l of logs) {
    if (l.timestamp_precise !== undefined) {
      max =
        max === undefined
          ? l.timestamp_precise
          : Math.max(max, l.timestamp_precise);
    }
  }
  return max;
}

/**
 * Render a batch of log rows as a human-readable string.
 *
 * When a StreamingTable is provided (TTY mode), renders rows through the
 * bordered table. Otherwise falls back to plain markdown rows.
 *
 * @param logs - Log entries to render
 * @param includeTrace - Whether to append trace-ID suffix to messages
 * @param table - Optional streaming table for TTY mode
 * @param extraFields - Additional field names to render as extra columns
 */
function renderLogRows(
  logs: LogLike[],
  includeTrace: boolean,
  table?: StreamingTable,
  extraFields?: string[]
): string {
  let text = "";
  for (const log of logs) {
    if (table) {
      text += table.row(
        buildLogRowCells(log, true, includeTrace, extraFields).map(
          renderInlineMarkdown
        )
      );
    } else {
      text += formatLogRow(log, includeTrace, extraFields);
    }
  }
  return text;
}

/**
 * Execute a single poll iteration in follow mode.
 *
 * Returns the new logs, or `undefined` if a transient error occurred
 * (reported via `onDiagnostic`). Re-throws {@link AuthError} and
 * {@link ValidationError} (a converted bad-`--query` 400).
 */
async function fetchPoll<T extends LogLike>(
  config: FollowGeneratorConfig<T>,
  lastTimestamp: number
): Promise<T[] | undefined> {
  try {
    const rawLogs = await config.fetch("10m", lastTimestamp);
    return config.extractNew(rawLogs, lastTimestamp);
  } catch (error) {
    if (error instanceof AuthError) {
      throw error;
    }
    // A ValidationError here is a converted search-query 400 (bad user
    // --query). It is a user input mistake, not a transient fetch failure, so
    // surface it and stop the stream rather than capturing it as a CLI bug.
    if (error instanceof ValidationError) {
      throw error;
    }
    Sentry.captureException(error);
    const message = stringifyUnknown(error);
    config.onDiagnostic(`Error fetching logs: ${message}\n`);
    return;
  }
}

/**
 * Async generator that streams log entries via follow-mode polling.
 *
 * Yields batches of log entries (chronological order). The command
 * unwraps each batch into individual {@link CommandOutput} yields so
 * the OutputConfig formatters can handle incremental rendering and JSONL.
 *
 * The generator handles SIGINT via AbortController for clean shutdown.
 * It never touches stdout — all data output flows through yielded batches
 * and diagnostics use the `onDiagnostic` callback.
 *
 * @throws {AuthError} if the API returns an authentication error
 */
async function* generateFollowLogs<T extends LogLike>(
  config: FollowGeneratorConfig<T>
): AsyncGenerator<T[], void, undefined> {
  const { flags } = config;
  const pollInterval = flags.follow ?? DEFAULT_POLL_INTERVAL;
  const pollIntervalMs = pollInterval * 1000;

  // timestamp_precise is nanoseconds; Date.now() is milliseconds → convert
  let lastTimestamp = Date.now() * 1_000_000;

  // AbortController for clean SIGINT handling + library mode abort
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);

  // Library mode: honor external abort signal (e.g., consumer break)
  if (config.abortSignal) {
    config.abortSignal.addEventListener("abort", stop, { once: true });
  }

  try {
    // Initial fetch
    const initialLogs = await config.fetch("1m");
    if (initialLogs.length > 0) {
      yield [...initialLogs].reverse();
    }
    lastTimestamp = maxTimestamp(initialLogs) ?? lastTimestamp;
    config.onInitialLogs?.(initialLogs);

    // Poll loop — exits when SIGINT fires
    while (!controller.signal.aborted) {
      await abortableSleep(pollIntervalMs, controller.signal);
      if (controller.signal.aborted) {
        break;
      }

      const newLogs = await fetchPoll(config, lastTimestamp);
      if (newLogs && newLogs.length > 0) {
        yield [...newLogs].reverse();
        lastTimestamp = maxTimestamp(newLogs) ?? lastTimestamp;
      }
    }
  } finally {
    process.removeListener("SIGINT", stop);
  }
}

/**
 * Consume a project-scoped follow-mode generator, yielding items individually.
 *
 * When `extraFields` is provided, the first non-empty batch is yielded as a
 * {@link LogListResult} so the human renderer can discover the extra columns
 * and create a table with the right headers. Subsequent items are yielded
 * bare for proper JSONL streaming.
 */
async function* yieldFollowItems<T extends LogLike>(
  generator: AsyncGenerator<T[], void, undefined>,
  extraFields?: string[]
): AsyncGenerator<CommandOutput<LogOutput>, void, undefined> {
  let contextSent = !extraFields?.length;
  for await (const batch of generator) {
    if (!contextSent && batch.length > 0) {
      yield new CommandOutput<LogOutput>({
        logs: batch,
        hasMore: false,
        extraFields,
      });
      contextSent = true;
    } else {
      for (const item of batch) {
        yield new CommandOutput<LogOutput>(item);
      }
    }
  }
}

/**
 * Consume a trace follow-mode generator, yielding items individually.
 *
 * The first non-empty batch is yielded as a {@link LogListResult} so
 * the human renderer can detect `traceId` and hide the trace column.
 * Subsequent items are yielded bare for proper JSONL streaming.
 */
async function* yieldTraceFollowItems<T extends LogLike>(
  generator: AsyncGenerator<T[], void, undefined>,
  traceId: string
): AsyncGenerator<CommandOutput<LogOutput>, void, undefined> {
  let contextSent = false;
  for await (const batch of generator) {
    if (!contextSent && batch.length > 0) {
      // First non-empty batch: yield as LogListResult to set trace context
      yield new CommandOutput<LogOutput>({
        logs: batch,
        traceId,
        hasMore: false,
      });
      contextSent = true;
    } else {
      for (const item of batch) {
        yield new CommandOutput<LogOutput>(item);
      }
    }
  }
}

/** Options for {@link executeTraceSingleFetch}. */
type TraceFetchOptions = {
  flags: ListFlags;
  timeRange: TimeRange;
  /** Project slug for API-level filtering (from org/project/trace-id syntax) */
  projectFilter?: string;
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
  options: TraceFetchOptions
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
        "Try 'sentry trace logs' for more options (e.g., --period 30d).",
    };
  }

  const hasMore = logs.length >= flags.limit;
  const countText = `Showing ${logs.length} log${logs.length === 1 ? "" : "s"} for trace ${traceId}.`;
  const tip = hasMore ? " Use --limit to show more." : "";

  // Build hint with real values for easy copy-paste
  let hint = `${countText}${tip}`;
  if (projectFilter) {
    hint += `\nFiltered to project '${projectFilter}'. Full trace logs: sentry log list ${org}/${traceId}`;
  } else {
    hint += `\nFilter by project: sentry log list ${org}/<project>/${traceId}`;
  }

  return {
    result: { logs, traceId, hasMore },
    hint,
  };
}

/**
 * Write the follow-mode banner via logger. Suppressed in JSON mode
 * to avoid stderr noise when agents consume JSONL output.
 */
function writeFollowBanner(
  pollInterval: number,
  bannerText: string,
  json: boolean
): void {
  if (json) {
    return;
  }
  logger.info(`${bannerText} (poll interval: ${pollInterval}s)`);
  logger.info("Press Ctrl+C to stop.");
  const notification = getUpdateNotification();
  if (notification) {
    logger.info(notification);
  }
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

/**
 * Create a stateful human renderer for log list output.
 *
 * The factory is called once per command invocation. The returned renderer
 * tracks streaming table state (header emitted, table instance) and cleans
 * up via `finalize()`.
 *
 * All yields go through `render()` — both single-fetch and follow mode.
 * The renderer emits the table header on the first non-empty batch, rows
 * per batch, and the table footer + hint via `finalize()`.
 *
 * Discriminates between {@link LogListResult} (single-fetch or first trace
 * follow batch) and bare {@link LogLike} items (follow mode).
 */
/** Shared discriminator for log output type. */
function isLogListResult(data: LogOutput): data is LogListResult {
  return "logs" in data && Array.isArray((data as LogListResult).logs);
}

/** Mutable state for the log renderer, extracted to reduce cognitive complexity. */
type LogRendererState = {
  table: StreamingTable | undefined;
  includeTrace: boolean;
  headerEmitted: boolean;
  extraFields: string[] | undefined;
};

/** Initialize table and column settings on the first non-empty render. */
function initFirstRender(
  state: LogRendererState,
  data: LogOutput,
  plain: boolean
): void {
  if (isLogListResult(data)) {
    if (data.traceId) {
      state.includeTrace = false;
    }
    state.extraFields = data.extraFields;
  }
  state.table = plain
    ? undefined
    : createLogStreamingTable({}, state.extraFields);
  state.headerEmitted = true;
}

function createLogRenderer(): HumanRenderer<LogOutput> {
  const plain = isPlainOutput();
  const state: LogRendererState = {
    table: undefined,
    includeTrace: true,
    headerEmitted: false,
    extraFields: undefined,
  };

  return {
    render(data: LogOutput): string {
      const logs: LogLike[] = isLogListResult(data) ? data.logs : [data];
      if (logs.length === 0) {
        return "";
      }

      if (!state.headerEmitted) {
        initFirstRender(state, data, plain);
        let text = state.table
          ? state.table.header()
          : formatLogsHeader(state.extraFields);
        text += renderLogRows(
          logs,
          state.includeTrace,
          state.table,
          state.extraFields
        );
        return text.trimEnd();
      }

      return renderLogRows(
        logs,
        state.includeTrace,
        state.table,
        state.extraFields
      ).trimEnd();
    },

    finalize(hint?: string): string {
      let text = "";

      if (state.headerEmitted && state.table) {
        text += state.table.footer();
      }

      if (hint) {
        if (state.headerEmitted) {
          text += `${text ? "\n" : ""}${formatFooter(hint)}`;
        } else {
          text += `${hint}\n`;
        }
      }

      return text;
    },
  };
}

/**
 * Transform log output into the JSON shape.
 *
 * Discriminates between {@link LogListResult} (single-fetch) and bare
 * {@link LogLike} items (follow mode). Single-fetch yields a JSON envelope
 * with `data` and `hasMore`; follow mode yields one JSON object per line (JSONL).
 */
function jsonTransformLogOutput(data: LogOutput, fields?: string[]): unknown {
  if (isLogListResult(data)) {
    // Batch (single-fetch): return envelope with data + hasMore
    const logList = data;
    const items =
      fields && fields.length > 0
        ? logList.logs.map((log) => filterFields(log, fields))
        : logList.logs;
    return { data: items, hasMore: logList.hasMore };
  }
  // Single item (follow mode): return bare object for JSONL
  return fields && fields.length > 0 ? filterFields(data, fields) : data;
}

/** Validate flag combinations that are invalid regardless of mode. */
function validateFollowFlags(flags: ListFlags): void {
  if (flags.follow && flags.sort === "oldest") {
    throw new ValidationError(
      '--sort "oldest" cannot be used with --follow. Follow mode streams new logs as they arrive.',
      "sort"
    );
  }
}

export const listCommand = buildListCommand(
  "log",
  {
    docs: {
      brief: "List logs from a project",
      fullDescription:
        "List and stream logs from Sentry projects.\n\n" +
        "Target patterns:\n" +
        "  sentry log list               # auto-detect from DSN or config\n" +
        "  sentry log list <org>/<proj>  # explicit org and project\n" +
        "  sentry log list <project>     # find project across all orgs\n\n" +
        `${TARGET_PATTERN_NOTE}\n\n` +
        "Trace filtering:\n" +
        "  sentry log list <trace-id>           # Filter by trace (auto-detect org)\n" +
        "  sentry log list <org>/<trace-id>     # Filter by trace (explicit org)\n\n" +
        "Examples:\n" +
        "  sentry log list                    # List last 100 logs\n" +
        "  sentry log list -f                 # Stream logs (2s poll interval)\n" +
        "  sentry log list -f 5               # Stream logs (5s poll interval)\n" +
        "  sentry log list --limit 50         # Show last 50 logs\n" +
        "  sentry log list -q 'severity:error' # Filter to errors only\n" +
        "  sentry log list abc123def456abc123def456abc123de  # Filter by trace\n\n" +
        "Alias: `sentry logs` → `sentry log list`",
    },
    output: {
      human: createLogRenderer,
      jsonTransform: jsonTransformLogOutput,
      schema: SentryLogSchema,
    },
    parameters: {
      positional: {
        kind: "array",
        parameter: {
          placeholder: "org/project-or-trace-id",
          brief:
            "[<org>/[<project>/]]<trace-id>, <org>/<project>, or <project>",
          parse: String,
        },
      },
      flags: {
        limit: {
          kind: "parsed",
          parse: parseLimit,
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
          parse: parseFollow,
          brief: "Stream logs (optionally specify poll interval in seconds)",
          optional: true,
          inferEmpty: true,
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
        f: "follow",
        t: "period",
        s: "sort",
      },
    },
    async *func(this: SentryContext, flags: ListFlags, ...args: string[]) {
      validateFollowFlags(flags);

      const { cwd } = this;

      const parsed = parseLogListArgs(args);

      // Resolve mode-dependent default period
      const timeRange =
        flags.period ??
        (parsed.mode === "trace" ? TIME_RANGE_14D : TIME_RANGE_30D);

      // Follow mode streams live events via short polling intervals —
      // absolute date ranges are silently ignored, so reject them entirely.
      if (flags.follow && timeRange.type === "absolute") {
        throw new ValidationError(
          "--follow cannot be used with an absolute date range. " +
            "Use a relative duration (e.g., --period 1h) or omit --period.",
          "period"
        );
      }

      if (parsed.mode === "trace") {
        // Trace mode: use the org-scoped trace-logs endpoint.
        warnIfNormalized(parsed.parsed, "log.list");
        const { traceId, org } = await resolveTraceOrg(
          parsed.parsed,
          cwd,
          TRACE_USAGE_HINT
        );

        // Warn if --fields was passed — the trace-logs endpoint has a fixed
        // field set and doesn't support arbitrary extra fields.
        if (flags.fields?.length) {
          logger.warn(
            "--fields is not supported for trace-scoped log queries. Use project-scoped mode instead."
          );
        }

        // Capture explicit project for API-level filtering
        const projectFilter =
          parsed.parsed.type === "explicit" ? parsed.parsed.project : undefined;

        // Prepend project filter to the query when user explicitly specified a project
        const traceQuery = buildProjectQuery(flags.query, projectFilter);

        if (flags.follow) {
          // Banner (suppressed in JSON mode)
          writeFollowBanner(
            flags.follow ?? DEFAULT_POLL_INTERVAL,
            `Streaming logs for trace ${traceId}...`,
            flags.json
          );

          // Track IDs of logs seen without timestamp_precise so they are
          // shown once but not duplicated on subsequent polls.
          const seenWithoutTs = new Set<string>();
          const generator = generateFollowLogs({
            flags,
            onDiagnostic: (msg) => logger.warn(msg),
            abortSignal: (this.process as { abortSignal?: AbortSignal })
              ?.abortSignal,
            fetch: (statsPeriod) =>
              listTraceLogs(org, traceId, {
                query: traceQuery,
                limit: flags.limit,
                statsPeriod,
              }).catch((error: unknown): never => {
                // An unparseable user --query is a user input mistake, not a
                // CLI bug — surface it as an actionable ValidationError.
                throw toSearchQueryError(error, flags.query);
              }),
            extractNew: (logs, lastTs) =>
              logs.filter((l) => {
                if (l.timestamp_precise !== undefined) {
                  return l.timestamp_precise > lastTs;
                }
                // No precise timestamp — deduplicate by id
                if (!l.id) {
                  return true; // Can't dedup without id, include it
                }
                if (seenWithoutTs.has(l.id)) {
                  return false;
                }
                seenWithoutTs.add(l.id);
                return true;
              }),
            onInitialLogs: (logs) => {
              for (const l of logs) {
                if (l.timestamp_precise === undefined && l.id) {
                  seenWithoutTs.add(l.id);
                }
              }
            },
          });

          yield* yieldTraceFollowItems(generator, traceId);
          return;
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
            })
        );
        yield new CommandOutput(result);
        return { hint };
      }

      // Standard project-scoped mode
      {
        const { org, project } = await resolveProjectBoundFromArg(
          parsed.target,
          cwd,
          COMMAND_NAME
        );
        // Resolve the slug to a numeric project ID so the Events query scopes
        // via the `project` param. The `project:<slug>` filter only matches
        // actively-selected projects and can otherwise return no logs (#1317).
        const projectId = await resolveLogProjectId(org, project);
        if (flags.follow) {
          writeFollowBanner(
            flags.follow ?? DEFAULT_POLL_INTERVAL,
            "Streaming logs...",
            flags.json
          );

          const generator = generateFollowLogs({
            flags,
            onDiagnostic: (msg) => logger.warn(msg),
            abortSignal: (this.process as { abortSignal?: AbortSignal })
              ?.abortSignal,
            fetch: (statsPeriod, afterTimestamp) =>
              listLogs(org, project, {
                query: flags.query,
                limit: flags.limit,
                statsPeriod,
                afterTimestamp,
                extraFields: flags.fields,
                projectId,
              }).catch((error: unknown): never => {
                // An unparseable user --query is a user input mistake, not a
                // CLI bug — surface it as an actionable ValidationError.
                throw toSearchQueryError(error, flags.query);
              }),
            extractNew: (logs) => logs,
          });

          yield* yieldFollowItems(generator, flags.fields);
          return;
        }

        const { result, hint } = await withProgress(
          {
            message: `Fetching logs (up to ${flags.limit})...`,
            json: flags.json,
          },
          () =>
            executeSingleFetch(org, project, flags, { timeRange, projectId })
        );
        yield new CommandOutput(result);
        return { hint };
      }
    },
  },
  {
    noCursorFlag: true,
    noFreshAlias: true,
  }
);
