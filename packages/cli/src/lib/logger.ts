/**
 * Structured logging for Sentry CLI.
 *
 * The logger comes from `@sentry/cli-logger` (`packages/cli-logger`): levels,
 * tag scoping, consola-style stderr output, and consola-shaped log records.
 * This module configures it for the CLI. Each log call goes to every
 * registered reporter:
 *
 * 1. **The stderr reporter** (built in) — renders consola's "fancy" layout and
 *    falls back to plain `[type] [tag] message` lines in CI and tests. It reads
 *    the environment through {@link getEnv}, so library mode's isolated env
 *    controls colors and layout.
 * 2. **Sentry.createConsolaReporter()** — auto-forwards all log messages to Sentry
 *    structured logs via `_INTERNAL_captureLog`. Library mode drops these logs
 *    in `beforeSendLog` (see telemetry.ts).
 *
 * See `packages/cli-logger/README.md` for the log levels.
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
  type ConfirmPromptOptions,
  createLogger,
  type LogReporter,
  parseLogLevel,
  type TextPromptOptions,
} from "@sentry/cli-logger";

import { getEnv } from "./env.js";

export { LOG_LEVEL_NAMES, parseLogLevel } from "@sentry/cli-logger";
export type { LogLevelName, LogObject, LogReporter } from "@sentry/cli-logger";

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
 * Set to `true` by esbuild in the `dist/complete.cjs` bundle (see
 * `script/bundle.ts`), so the `@clack/prompts` import below stays out of the
 * shell completion bundle. Undefined when running from source.
 */
declare const SENTRY_CLI_COMPLETION_BUILD: boolean | undefined;

/**
 * Ask the user a question on the terminal with `@clack/prompts`.
 *
 * Resolves to the answer, or to clack's cancel symbol when the user presses
 * Ctrl+C, so callers check for `=== true` or `typeof answer === "string"`.
 */
function askUser(
  message: string,
  opts: ConfirmPromptOptions,
): Promise<boolean | symbol>;
function askUser(
  message: string,
  opts: TextPromptOptions,
): Promise<string | symbol>;
async function askUser(
  message: string,
  opts: ConfirmPromptOptions | TextPromptOptions,
): Promise<boolean | string | symbol> {
  if (
    typeof SENTRY_CLI_COMPLETION_BUILD !== "undefined" &&
    SENTRY_CLI_COMPLETION_BUILD
  ) {
    throw new Error("Prompts are not available during shell completion.");
  } else {
    // The `else` lets esbuild drop this import from the completion bundle.
    // Elsewhere `@clack/prompts` loads only when a command asks a question.
    const { clackPrompt } = await import("@sentry/cli-logger/prompt");
    return await clackPrompt(message, opts as ConfirmPromptOptions);
  }
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
export const logger = createLogger({ env: getEnv, prompt: askUser });

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
 * Attach the Sentry consola reporter for automatic log forwarding.
 *
 * Must be called after `Sentry.init()` completes so that `createConsolaReporter()`
 * can find the active client. Safe to call multiple times — subsequent calls are no-ops.
 * The caller creates the reporter so this module never imports `@sentry/node`:
 * the `__complete` fast path loads the logger through the database modules.
 *
 * The reporter auto-forwards all log messages to Sentry structured logs,
 * mapping log types to Sentry severity levels:
 * - error → error, fail → error, warn → warn
 * - info/log/success/start → info
 * - debug → debug, trace → trace
 *
 * Tags are preserved as `consola.tag` attributes in Sentry.
 */
export function attachSentryReporter(reporter: LogReporter): void {
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
