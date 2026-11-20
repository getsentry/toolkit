/**
 * sentry log tail
 *
 * Stream new logs from a Sentry project or trace as they arrive, like
 * `tail -f`. `sentry log list` fetches one batch; this command keeps polling
 * until Ctrl+C.
 */

import type { SentryContext } from "../../context.js";
import { listLogs, listTraceLogs } from "../../lib/api-client.js";
import { buildProjectQuery, validateLimit } from "../../lib/arg-parsing.js";
import { buildCommand } from "../../lib/command.js";
import { textParser } from "../../lib/completion-target.js";
import {
  AuthError,
  stringifyUnknown,
  toSearchQueryError,
  ValidationError,
} from "../../lib/errors.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  LIST_MAX_LIMIT,
  LIST_MIN_LIMIT,
  TARGET_PATTERN_NOTE,
} from "../../lib/list-command.js";
import { logger } from "../../lib/logger.js";
import { abortableSleep, parsePollInterval } from "../../lib/polling.js";
import { resolveLogProjectId } from "../../lib/resolve-target.js";
import { sanitizeQuery } from "../../lib/search-query.js";
import { getUpdateNotification } from "../../lib/version-check.js";
import { SentryLogSchema } from "../../generated/output-schemas/log.js";
import { reportCliError } from "../../lib/error-reporting.js";
import {
  createLogRenderer,
  jsonTransformLogOutput,
  type LogLike,
  type LogListArguments,
  type LogListResult,
  type LogOutput,
  logTargetArguments,
} from "./shared.js";

type TailFlags = {
  readonly limit: number;
  readonly query?: string;
  readonly interval: number;
  readonly json: boolean;
  readonly fields?: string[];
};

/** Default poll interval in seconds */
const DEFAULT_POLL_INTERVAL = 2;

/**
 * Window of the first fetch: the logs of the last minute, so the stream
 * opens with recent context instead of a blank screen.
 */
const BACKFILL_PERIOD = "1m";

/**
 * Window of each poll. `afterTimestamp` already filters to logs newer than
 * the last one shown, so this only bounds the scan. It is wider than any poll
 * interval so logs that arrive late from ingestion still show up.
 */
const POLL_PERIOD = "10m";

/** Parse --limit, delegating range validation to the shared utility. */
function parseLimit(value: string): number {
  return validateLimit(value, LIST_MIN_LIMIT, LIST_MAX_LIMIT);
}

/** Parse --interval: whole seconds, at least 1. */
function parseInterval(value: string): number {
  return parsePollInterval(value, { flag: "--interval" });
}

/**
 * Configuration for the polling async generator.
 *
 * Parameterized over the log type to handle both project-scoped
 * (`SentryLog`) and trace-scoped (`TraceLog`) streaming.
 *
 * Unlike the old callback-based approach, this does NOT include
 * stdout/stderr. All stdout output flows through yielded chunks;
 * diagnostics are reported via the `onDiagnostic` callback.
 */
type FollowGeneratorConfig<T extends LogLike> = {
  flags: TailFlags;
  /** Report diagnostic/error messages (caller logs via logger) */
  onDiagnostic: (message: string) => void;
  /**
   * Fetch logs with the given time window.
   * @param statsPeriod - Time window: {@link BACKFILL_PERIOD} for the first
   *   fetch, {@link POLL_PERIOD} for polls
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
   * External abort signal (library mode). When aborted, the
   * generator stops on the next poll cycle. Complements SIGINT handling.
   */
  abortSignal?: AbortSignal | undefined;
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
 * Execute a single poll iteration.
 *
 * Returns the new logs, or `undefined` if a transient error occurred
 * (reported via `onDiagnostic`). Re-throws {@link AuthError} and
 * {@link ValidationError} (a converted bad-`--query` 400).
 */
async function fetchPoll<T extends LogLike>(
  config: FollowGeneratorConfig<T>,
  lastTimestamp: number,
): Promise<T[] | undefined> {
  try {
    const rawLogs = await config.fetch(POLL_PERIOD, lastTimestamp);
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
    reportCliError(error);
    const message = stringifyUnknown(error);
    config.onDiagnostic(`Error fetching logs: ${message}\n`);
    return;
  }
}

/**
 * Async generator that streams log entries by polling.
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
  config: FollowGeneratorConfig<T>,
): AsyncGenerator<T[], void, undefined> {
  const { flags } = config;
  const pollIntervalMs = flags.interval * 1000;

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
    const initialLogs = await config.fetch(BACKFILL_PERIOD);
    if (initialLogs.length > 0) {
      yield [...initialLogs].reverse();
    }
    lastTimestamp = maxTimestamp(initialLogs) ?? lastTimestamp;
    config.onInitialLogs?.(initialLogs);

    // Poll loop — exits when SIGINT fires
    for (;;) {
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
 * Consume a polling generator, yielding log items individually for JSONL
 * streaming.
 *
 * When the renderer needs context, the first non-empty batch is yielded as a
 * {@link LogListResult} instead: `traceId` hides the trace column, and
 * `extraFields` adds the `--fields` columns to the table header.
 */
async function* yieldLogItems<T extends LogLike>(
  generator: AsyncGenerator<T[], void, undefined>,
  context: Pick<LogListResult, "traceId" | "extraFields">,
): AsyncGenerator<CommandOutput<LogOutput>, void, undefined> {
  let contextSent = !(context.traceId || context.extraFields?.length);
  for await (const batch of generator) {
    if (!contextSent && batch.length > 0) {
      yield new CommandOutput({ ...context, logs: batch, hasMore: false });
      contextSent = true;
    } else {
      for (const item of batch) {
        yield new CommandOutput(item);
      }
    }
  }
}

/**
 * Write the streaming banner via logger. Suppressed in JSON mode
 * to avoid stderr noise when agents consume JSONL output.
 */
function writeFollowBanner(
  pollInterval: number,
  bannerText: string,
  json: boolean,
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

export const tailCommand = buildCommand({
  streams: true,
  docs: {
    brief: "Stream new logs from a project or trace",
    fullDescription:
      "Stream new logs as they arrive, like `tail -f`. Polls until Ctrl+C.\n\n" +
      "Prints the logs of the last minute, then every new log on each poll. " +
      "With --json, writes one JSON object per line (JSONL).\n\n" +
      `${TARGET_PATTERN_NOTE}\n\n` +
      "Pass a 32-character trace ID instead of a project to stream a trace's logs.",
    examples: [
      { description: "Stream logs (2-second poll interval)", run: "log tail" },
      {
        description: "Poll every 5 seconds",
        run: "log tail --interval 5",
      },
      {
        description: "Stream error logs from a specific project",
        run: "log tail my-org/backend -q 'severity:error'",
      },
      {
        description: "Stream the logs of a trace",
        run: "log tail abc123def456abc123def456abc12345",
      },
      {
        description: "Stream JSONL for another tool",
        run: "log tail --json | jq 'select(.severity == \"error\")'",
      },
    ],
  },
  output: {
    human: createLogRenderer,
    jsonTransform: jsonTransformLogOutput,
    schema: SentryLogSchema,
  },
  parameters: {
    positional: logTargetArguments("log tail"),
    flags: {
      limit: {
        kind: "parsed",
        parse: textParser(parseLimit),
        brief: `Max log entries per poll (${LIST_MIN_LIMIT}-${LIST_MAX_LIMIT})`,
        default: "100",
      },
      query: {
        kind: "parsed",
        parse: sanitizeQuery,
        brief:
          'Filter query (e.g., "severity:error", "project:backend", "project:[a,b]")',
        optional: true,
      },
      interval: {
        kind: "parsed",
        parse: textParser(parseInterval),
        brief: "Poll interval in seconds",
        default: String(DEFAULT_POLL_INTERVAL),
      },
    },
    aliases: {
      n: "limit",
      q: "query",
      i: "interval",
    },
  },
  async *func(this: SentryContext, flags: TailFlags, target: LogListArguments) {
    const abortSignal = (this.process as { abortSignal?: AbortSignal })
      .abortSignal;
    const resolved = await target.resolved;

    if (resolved.mode === "trace") {
      // Trace mode: use the org-scoped trace-logs endpoint.
      const { traceId, org, projectFilter } = resolved;

      // The trace-logs endpoint has a fixed field set and doesn't support
      // arbitrary extra fields.
      if (flags.fields?.length) {
        logger.warn(
          "--fields is not supported for trace-scoped log queries. Use project-scoped mode instead.",
        );
      }

      // Prepend project filter to the query when user explicitly specified a project
      const traceQuery = buildProjectQuery(flags.query, projectFilter);

      writeFollowBanner(
        flags.interval,
        `Streaming logs for trace ${traceId}...`,
        flags.json,
      );

      // Track IDs of logs seen without timestamp_precise so they are
      // shown once but not duplicated on subsequent polls.
      const seenWithoutTs = new Set<string>();
      const generator = generateFollowLogs({
        flags,
        onDiagnostic: (msg) => logger.warn(msg),
        abortSignal,
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

      yield* yieldLogItems(generator, { traceId });
      return;
    }

    const { org, project } = resolved;
    // Resolve the slug to a numeric project ID so the Events query scopes
    // via the `project` param. The `project:<slug>` filter only matches
    // actively-selected projects and can otherwise return no logs (#1317).
    const projectId = await resolveLogProjectId(org, project);
    writeFollowBanner(flags.interval, "Streaming logs...", flags.json);

    const generator = generateFollowLogs({
      flags,
      onDiagnostic: (msg) => logger.warn(msg),
      abortSignal,
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

    yield* yieldLogItems(generator, { extraFields: flags.fields });
  },
});
