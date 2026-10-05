/**
 * Structured logging for Sentry CLI.
 *
 * Built on {@link https://github.com/unjs/consola | consola} — a lightweight CLI logger
 * with log levels, tag scoping, and fancy TTY output. Two reporters are wired up:
 *
 * 1. **FancyReporter** (built-in) — writes to stderr with colors/icons for TTY,
 *    falls back to BasicReporter in CI/non-TTY environments. Its `formatDate` is
 *    overridden (see {@link patchReporterDates}) so the `[tag HH:MM:SS]` prefix
 *    renders in corrected local time — consola's default renders UTC in the SEA
 *    binaries this CLI ships.
 * 2. **Sentry.createConsolaReporter()** — auto-forwards all log messages to Sentry
 *    structured logs via `_INTERNAL_captureLog`. Requires `enableLogs: true` in
 *    `Sentry.init()` (already enabled in telemetry.ts).
 *
 * ## Log levels
 *
 * | Level | consola | Shows |
 * |-------|---------|-------|
 * | error | 0       | fatal, error |
 * | warn  | 1       | + warn |
 * | log   | 2       | + log |
 * | info  | 3       | + info, success, start, ready, fail (default) |
 * | debug | 4       | + debug |
 * | trace | 5       | + trace, verbose |
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
 * - `NO_COLOR` — Disables color output (respected by consola natively)
 * - `FORCE_COLOR` — Forces color output even in non-TTY
 *
 * ## withTag level propagation
 *
 * Consola's `withTag()` creates an independent instance that snapshots the
 * parent's level at creation time. Scoped loggers created at module load
 * time (e.g. `const log = logger.withTag("upgrade")`) would miss later
 * `setLogLevel()` calls. To fix this, the logger's `withTag` method is
 * wrapped to register all children in a registry, and `setLogLevel()`
 * propagates the level to every registered child.
 *
 * @module
 */

import { createRequire } from "node:module";
import type { ConsolaInstance } from "consola";
import { createConsola } from "consola";

const _require = createRequire(import.meta.url);

import { getEnv } from "./env.js";
import { formatLogTime } from "./timezone.js";

/**
 * Environment variable name for controlling CLI log verbosity.
 *
 * Using `SENTRY_LOG_LEVEL` (not `CONSOLA_LEVEL`) to be consistent with
 * other Sentry CLI env vars (`SENTRY_URL`, `SENTRY_AUTH_TOKEN`, etc.).
 */
export const LOG_LEVEL_ENV_VAR = "SENTRY_LOG_LEVEL";

/**
 * Valid log level names accepted by `SENTRY_LOG_LEVEL` and `--log-level`.
 *
 * Array index IS the consola numeric level:
 * - 0 = error (includes fatal)
 * - 1 = warn
 * - 2 = log
 * - 3 = info (default — also shows success, start, ready, fail)
 * - 4 = debug
 * - 5 = trace (includes verbose)
 */
export const LOG_LEVEL_NAMES = [
  "error",
  "warn",
  "log",
  "info",
  "debug",
  "trace",
] as const;

/** A valid log level name string */
export type LogLevelName = (typeof LOG_LEVEL_NAMES)[number];

/**
 * Default log level when nothing is configured.
 * Level 3 shows info, success, start, ready, log, fail — standard user-facing output.
 */
const DEFAULT_LOG_LEVEL = 3;

/**
 * Parse a log level name string into a consola numeric level.
 *
 * Returns the default level (info = 3) for unrecognized values so that
 * a typo in `SENTRY_LOG_LEVEL` doesn't break the CLI.
 *
 * @param name - Level name from env var or CLI flag
 * @returns consola numeric level
 */
export function parseLogLevel(name: string): number {
  const idx = LOG_LEVEL_NAMES.indexOf(
    name.toLowerCase().trim() as LogLevelName
  );
  return idx === -1 ? DEFAULT_LOG_LEVEL : idx;
}

/**
 * Read the log level from `SENTRY_LOG_LEVEL`, called lazily by {@link setLogLevel}.
 *
 * Following the same pattern as `getSentryUrl()` in oauth.ts — env vars are read
 * at call time (not module load time) so tests can set them after import.
 *
 * @returns consola numeric level, or null if not set
 */
export function getEnvLogLevel(): number | null {
  const envLevel = getEnv()[LOG_LEVEL_ENV_VAR];
  if (envLevel) {
    return parseLogLevel(envLevel);
  }
  return null;
}

/**
 * Registry of all scoped loggers created via `logger.withTag()` at any depth.
 *
 * When `setLogLevel()` is called, every registered descendant is updated so that
 * module-level scoped loggers (created at import time, before the CLI parses
 * `--log-level` or `SENTRY_LOG_LEVEL`) see the new level. Grandchildren and
 * deeper descendants are tracked via recursive `patchWithTag()`.
 */
const scopedLoggers: ConsolaInstance[] = [];

/**
 * Global CLI logger instance.
 *
 * Use `logger.info()`, `logger.success()`, `logger.start()` for user-facing messages.
 * Use `logger.debug()`, `logger.trace()` for diagnostic output.
 * Use `logger.withTag('scope')` for domain-specific scoped loggers.
 *
 * The Sentry reporter is added lazily via {@link attachSentryReporter} after
 * Sentry.init() completes, since the reporter needs an active Sentry client.
 *
 * The initial level defaults to info (3). `SENTRY_LOG_LEVEL` is applied lazily
 * by bin.ts calling `setLogLevel(getEnvLogLevel())` — not at module load time —
 * so tests can override the env var after import.
 */
export const logger = createConsola({
  level: DEFAULT_LOG_LEVEL,
  // All diagnostic/log output goes to stderr — stdout is reserved for
  // command output (data, JSON, tables). Both streams must be set because
  // consola's BasicReporter (non-TTY) routes debug/info to stdout by default.
  stdout: process.stderr,
  stderr: process.stderr,
});

/**
 * Write an already-formatted line to stderr verbatim, bypassing consola.
 *
 * Event tails (`sentry local`) render their own prefix — an event timestamp,
 * level tag, and source tag — before printing. Routing those lines through
 * `logger.log()` makes consola's reporter prepend/append a *second* timestamp
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

/**
 * Patch a consola instance's `withTag` so every child (and grandchild)
 * is registered in {@link scopedLoggers} for {@link setLogLevel} propagation.
 */
function patchWithTag(instance: ConsolaInstance): void {
  const original = instance.withTag.bind(instance);
  instance.withTag = (tag: string): ConsolaInstance => {
    const child = original(tag);
    scopedLoggers.push(child);
    patchWithTag(child);
    return child;
  };
}

// Patch the root logger so all descendants are tracked.
// Consola's withTag() creates a completely independent instance that
// snapshots the level at creation time — children never see later
// setLogLevel() calls. By registering them here, setLogLevel() can
// propagate the new level to all descendants.
patchWithTag(logger);

/**
 * A consola reporter exposes a `formatDate(date, opts)` method that produces
 * the time shown in the `[tag HH:MM:SS]` log prefix. Consola does not export
 * its `FancyReporter`/`BasicReporter` classes, so we type just the slice we
 * override.
 */
type DateFormattingReporter = {
  formatDate?: (date: Date, opts: unknown) => string;
};

/**
 * Replace each default reporter's `formatDate` with {@link formatLogTime}.
 *
 * Consola's built-in reporters format the prefix time via
 * `date.toLocaleTimeString()` with no arguments. That call renders in whatever
 * timezone the runtime resolved — which silently falls back to **UTC** in the
 * SEA binaries this CLI ships, so users saw log timestamps hours off from their
 * local clock. Overriding `formatDate` guarantees the prefix uses the corrected
 * local time (see {@link formatLogTime}) regardless of ICU state, and switches
 * to an unambiguous 24-hour format.
 *
 * The instances are reused from `logger.options.reporters` so all of consola's
 * other formatting (icons, colors, alignment, badges) is preserved untouched.
 */
function patchReporterDates(instance: ConsolaInstance): void {
  const reporters = (instance.options?.reporters ??
    []) as DateFormattingReporter[];
  for (const reporter of reporters) {
    if (typeof reporter.formatDate === "function") {
      reporter.formatDate = (date: Date) => formatLogTime(date);
    }
  }
}

patchReporterDates(logger);

/** Whether the Sentry reporter has already been attached */
let sentryReporterAttached = false;

/**
 * Attach the Sentry consola reporter for automatic log forwarding.
 *
 * Must be called after `Sentry.init()` completes so that `createConsolaReporter()`
 * can find the active client. Safe to call multiple times — subsequent calls are no-ops.
 *
 * The reporter auto-forwards all consola log messages to Sentry structured logs,
 * mapping consola types to Sentry severity levels:
 * - fatal → fatal, error → error, warn → warn
 * - info/log/success/ready/start → info
 * - debug/verbose → debug, trace → trace
 *
 * Tags are preserved as `consola.tag` attributes in Sentry.
 */
export function attachSentryReporter(): void {
  if (sentryReporterAttached) {
    return;
  }

  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    // Dynamic import to avoid pulling in Sentry at module load time.
    // The reporter is exported from @sentry/node-core/light (via @sentry/node → @sentry/core).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Sentry = _require("@sentry/node-core/light") as {
      createConsolaReporter: (options?: Record<string, unknown>) => {
        log: (logObj: unknown) => void;
      };
    };

    const sentryReporter = Sentry.createConsolaReporter();
    logger.addReporter(sentryReporter);
    sentryReporterAttached = true;
  } catch {
    // Sentry not available (e.g., telemetry disabled) — continue without reporter
  }
}

/**
 * Set the logger level at runtime and propagate to all scoped children.
 *
 * Called from:
 * - bin.ts to apply `SENTRY_LOG_LEVEL` env var early
 * - `buildCommand` wrapper when `--log-level` or `--verbose` flags are parsed
 *
 * Propagation is necessary because consola's `withTag()` creates independent
 * instances that snapshot the parent's level at creation time. Module-level
 * scoped loggers (e.g. `const log = logger.withTag("upgrade")`) would never
 * see a later level change without this.
 *
 * @param level - consola numeric level (0-5)
 */
export function setLogLevel(level: number): void {
  logger.level = level;
  for (const child of scopedLoggers) {
    child.level = level;
  }
}
