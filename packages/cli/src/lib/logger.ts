/**
 * Structured logging for Sentry CLI.
 *
 * The logger comes from `@sentry/logger` (`packages/logger`): levels, tag
 * scoping, and reporters. This module configures it for the CLI. Each log
 * call goes to every registered reporter:
 *
 * 1. **`fancyReporter`** — renders consola's "fancy" layout on stderr and
 *    falls back to plain `[type] [tag] message` lines in CI and tests. It reads
 *    the environment through {@link getEnv}, so library mode's isolated env
 *    controls colors and layout.
 * 2. **`sentryReporter(Sentry.logger)`** — forwards all log messages to Sentry
 *    structured logs. Library mode drops these logs in `beforeSendLog` (see
 *    telemetry.ts).
 *
 * Prompts live in `prompt.ts`. See `packages/logger/README.md` for the log
 * levels.
 *
 * ## Usage
 *
 * ```ts
 * import { logger } from "./logger.js";
 *
 * // User-facing messages (always visible at default level)
 * logger.info("Checking for updates...");
 * logger.success("Upgrade complete!");
 *
 * // Diagnostic messages (visible with SENTRY_LOG_LEVEL=debug or --verbose)
 * logger.debug("Found chain of 2 patches totalling 96 KB");
 *
 * // Scoped diagnostic messages
 * const log = logger.withTag("delta-upgrade");
 * log.debug("Resolved stable chain: 0.12.0 → 0.13.0");
 * ```
 *
 * ## Environment variables
 *
 * - `SENTRY_LOG_LEVEL` — Sets log level: `error`, `warn`, `info` (default), `debug`, `trace`
 * - `NO_COLOR` — Disables color output
 * - `FORCE_COLOR` — Forces color output even in non-TTY
 *
 * @module
 */

import {
  createLogger,
  fancyReporter,
  parseLogLevel,
  type Reporter,
} from "@sentry/logger";

import { getEnv } from "./env.js";

export { LOG_LEVEL_NAMES, parseLogLevel } from "@sentry/logger";
export type { LogLevelName, LogRecord, Reporter } from "@sentry/logger";

/**
 * Environment variable name for controlling CLI log verbosity.
 *
 * Using `SENTRY_LOG_LEVEL` (not a logger-specific name) to be consistent with
 * other Sentry CLI env vars (`SENTRY_URL`, `SENTRY_AUTH_TOKEN`, etc.).
 */
export const LOG_LEVEL_ENV_VAR = "SENTRY_LOG_LEVEL";

/**
 * Read the log level from `SENTRY_LOG_LEVEL`, called lazily by {@link setLogLevel}.
 *
 * Following the same pattern as `getSentryUrl()` in oauth.ts — env vars are read
 * at call time (not module load time) so tests can set them after import.
 *
 * @returns numeric level, or null if not set
 */
export function getEnvLogLevel(): number | null {
  const envLevel = getEnv()[LOG_LEVEL_ENV_VAR];
  if (envLevel) {
    return parseLogLevel(envLevel);
  }
  return null;
}

/**
 * Global CLI logger instance.
 *
 * Use `logger.info()`, `logger.success()`, `logger.start()` for user-facing messages.
 * Use `logger.debug()`, `logger.trace()` for diagnostic output.
 * Use `logger.withTag('scope')` for domain-specific scoped loggers.
 *
 * All diagnostic/log output goes to stderr — stdout is reserved for command
 * output (data, JSON, tables).
 *
 * The Sentry reporter is added lazily via {@link attachSentryReporter} after
 * Sentry.init() completes, since the reporter needs an active Sentry client.
 *
 * The initial level defaults to info (3). `SENTRY_LOG_LEVEL` is applied lazily
 * by bin.ts calling `setLogLevel(getEnvLogLevel())` — not at module load time —
 * so tests can override the env var after import.
 */
export const logger = createLogger({
  reporters: [fancyReporter({ env: getEnv })],
});

/**
 * Write an already-formatted line to stderr verbatim, bypassing the logger.
 *
 * Event tails (`sentry local`) render their own prefix — an event timestamp,
 * level tag, and source tag — before printing. Routing those lines through
 * `logger.log()` makes the reporter prepend/append a *second* timestamp
 * (the wall-clock print time), so every line carried two different times.
 * Writing directly keeps the single, meaningful event timestamp.
 *
 * Uses the same stream as {@link logger} so ordering with surrounding
 * `logger.info()` status messages is preserved.
 *
 * @param line - Fully formatted line, without a trailing newline
 */
export function printLine(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * Write a machine-readable event record to stdout as one NDJSON line.
 *
 * Local command lifecycle messages continue to use stderr, leaving stdout
 * safe for an agent or another process to consume as a record stream.
 */
export function printJsonLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Whether the Sentry reporter has already been attached */
let sentryReporterAttached = false;

/**
 * Attach the Sentry reporter for automatic log forwarding.
 *
 * Must be called after `Sentry.init()` completes so that the reporter has an
 * active client. Safe to call multiple times — subsequent calls are no-ops.
 * The caller creates the reporter so this module never imports `@sentry/node`:
 * the `__complete` fast path loads the logger through the database modules.
 *
 * The reporter forwards all log messages to Sentry structured logs, mapping
 * log types to Sentry severity levels:
 * - error → error, fail → error, warn → warn
 * - info/log/success/start → info
 * - debug → debug, trace → trace
 *
 * Tags are preserved as `logger.tag` attributes in Sentry.
 */
export function attachSentryReporter(reporter: Reporter): void {
  if (sentryReporterAttached) {
    return;
  }

  logger.addReporter(reporter);
  sentryReporterAttached = true;
}

/**
 * Set the level of the logger and every scoped logger at runtime.
 *
 * Called from:
 * - bin.ts to apply `SENTRY_LOG_LEVEL` env var early
 * - `buildCommand` wrapper when `--log-level` or `--verbose` flags are parsed
 *
 * @param level - numeric level (0-5)
 */
export function setLogLevel(level: number): void {
  logger.level = level;
}
