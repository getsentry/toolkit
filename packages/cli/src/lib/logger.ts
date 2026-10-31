/**
 * Structured logging for Sentry CLI.
 *
 * A small in-house logger with log levels, tag scoping, and consola-style
 * terminal output. It replaced `consola`, the largest third-party package that
 * `sentry __complete` loaded on every TAB press. Each log call goes to every
 * registered reporter:
 *
 * 1. **The stderr reporter** (built in) — renders consola's "fancy" layout
 *    (icons, colors, `WARN`/`ERROR` badges, a right-aligned `tag HH:MM:SS`) and
 *    falls back to plain `[type] [tag] message` lines in CI and tests. The time
 *    comes from {@link formatLogTime}, which stays in local time in the SEA
 *    binaries this CLI ships.
 * 2. **Sentry.createConsolaReporter()** — auto-forwards all log messages to Sentry
 *    structured logs via `_INTERNAL_captureLog`. Log records keep consola's
 *    `{ date, args, type, level, tag }` shape so that reporter still reads them.
 *    Library mode drops these logs in `beforeSendLog` (see telemetry.ts).
 *
 * ## Log levels
 *
 * | Level | Value | Shows |
 * |-------|-------|-------|
 * | error | 0     | error |
 * | warn  | 1     | + warn |
 * | log   | 2     | + log |
 * | info  | 3     | + info, success, start, fail (default) |
 * | debug | 4     | + debug |
 * | trace | 5     | + trace |
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
 * Every logger, including the scoped ones `withTag()` returns, shares one level
 * and one reporter list, so a later `setLogLevel()` also reaches the scoped
 * loggers that modules create at import time.
 *
 * @module
 */

import { sep } from "node:path";
import { formatWithOptions } from "node:util";

import { getEnv } from "./env.js";
import { formatLogTime } from "./timezone.js";

/**
 * Environment variable name for controlling CLI log verbosity.
 *
 * Using `SENTRY_LOG_LEVEL` (not a logger-specific name) to be consistent with
 * other Sentry CLI env vars (`SENTRY_URL`, `SENTRY_AUTH_TOKEN`, etc.).
 */
export const LOG_LEVEL_ENV_VAR = "SENTRY_LOG_LEVEL";

/**
 * Valid log level names accepted by `SENTRY_LOG_LEVEL` and `--log-level`.
 *
 * Array index IS the numeric level:
 * - 0 = error
 * - 1 = warn
 * - 2 = log
 * - 3 = info (default — also shows success, start, fail)
 * - 4 = debug
 * - 5 = trace
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
 * Level 3 shows info, success, start, log, fail — standard user-facing output.
 */
const DEFAULT_LOG_LEVEL = 3;

/**
 * Parse a log level name string into a numeric level.
 *
 * Returns the default level (info = 3) for unrecognized values so that
 * a typo in `SENTRY_LOG_LEVEL` doesn't break the CLI.
 *
 * @param name - Level name from env var or CLI flag
 * @returns numeric level
 */
export function parseLogLevel(name: string): number {
  const idx = LOG_LEVEL_NAMES.indexOf(
    name.toLowerCase().trim() as LogLevelName,
  );
  return idx === -1 ? DEFAULT_LOG_LEVEL : idx;
}

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

/** Level of each log method: a call prints when it is at most the logger's level. */
const LOG_TYPE_LEVELS = {
  error: 0,
  warn: 1,
  log: 2,
  info: 3,
  success: 3,
  fail: 3,
  start: 3,
  debug: 4,
  trace: 5,
} as const;

/** A log method name, such as `info` or `warn`. */
type LogType = keyof typeof LOG_TYPE_LEVELS;

/**
 * One log call, in the shape consola reporters read, so the reporter from
 * `Sentry.createConsolaReporter()` can forward it.
 */
export type LogObject = {
  date: Date;
  args: unknown[];
  type: LogType;
  level: number;
  tag: string;
};

/** Receives every log call at or below the current level. */
export type LogReporter = {
  log(logObj: LogObject): void;
};

/** Options for a yes/no prompt. */
type ConfirmPromptOptions = { type: "confirm"; initial?: boolean };

/** Options for a free-text prompt. */
type TextPromptOptions = {
  type: "text";
  placeholder?: string;
  initial?: string;
  default?: string;
};

/**
 * Set to `true` by esbuild in the `dist/complete.cjs` bundle (see
 * `script/bundle.ts`), so the `@clack/prompts` import below stays out of the
 * shell completion bundle. Undefined when running from source.
 */
declare const SENTRY_CLI_COMPLETION_BUILD: boolean | undefined;

/**
 * Ask the user a question on the terminal.
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
    const clack = await import("@clack/prompts");
    if (opts.type === "confirm") {
      return await clack.confirm({ message, initialValue: opts.initial });
    }
    return await clack.text({
      message,
      placeholder: opts.placeholder,
      initialValue: opts.initial,
      defaultValue: opts.default,
    });
  }
}

/** Level and reporters shared by the root logger and every scoped logger. */
const state: { level: number; reporters: LogReporter[] } = {
  level: DEFAULT_LOG_LEVEL,
  reporters: [{ log: writeLogToStderr }],
};

/** A logger, optionally scoped to a tag shown with each message. */
class Logger {
  /** Tag shown with each message; nested tags join with `:`. */
  readonly tag: string;

  // Arrow properties keep the methods bound, so they can be passed around.
  readonly error = (...args: unknown[]): void => this.emit("error", args);
  readonly warn = (...args: unknown[]): void => this.emit("warn", args);
  readonly log = (...args: unknown[]): void => this.emit("log", args);
  readonly info = (...args: unknown[]): void => this.emit("info", args);
  readonly success = (...args: unknown[]): void => this.emit("success", args);
  readonly fail = (...args: unknown[]): void => this.emit("fail", args);
  readonly start = (...args: unknown[]): void => this.emit("start", args);
  readonly debug = (...args: unknown[]): void => this.emit("debug", args);
  readonly trace = (...args: unknown[]): void => this.emit("trace", args);
  readonly prompt = askUser;

  constructor(tag = "") {
    this.tag = tag;
  }

  /** The shared level: calls above it are dropped. */
  get level(): number {
    return state.level;
  }

  set level(level: number) {
    state.level = level;
  }

  /** Return a logger whose messages carry `tag`, nested under this logger's tag. */
  withTag(tag: string): Logger {
    return new Logger(this.tag ? `${this.tag}:${tag}` : tag);
  }

  /** Send every later log call to `reporter` too. */
  addReporter(reporter: LogReporter): void {
    state.reporters.push(reporter);
  }

  private emit(type: LogType, args: unknown[]): void {
    const level = LOG_TYPE_LEVELS[type];
    if (level > state.level) {
      return;
    }
    const logObj: LogObject = {
      date: new Date(),
      args,
      type,
      level,
      tag: this.tag,
    };
    for (const reporter of state.reporters) {
      reporter.log(logObj);
    }
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
export const logger = new Logger();

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
  state.level = level;
}

// stderr rendering

/** SGR open and close codes for the styles the reporter uses. */
const ANSI_CODES = {
  black: [30, 39],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  magenta: [35, 39],
  cyan: [36, 39],
  gray: [90, 39],
  underline: [4, 24],
  bgRed: [41, 49],
  bgYellow: [43, 49],
} as const;

type AnsiStyle = keyof typeof ANSI_CODES;

/** Icon color per log type. The error and warn levels render as badges instead. */
const TYPE_COLORS: Record<LogType, AnsiStyle> = {
  error: "red",
  warn: "yellow",
  log: "gray",
  info: "cyan",
  success: "green",
  fail: "red",
  start: "magenta",
  debug: "gray",
  trace: "gray",
};

/** Badge background for the error (0) and warn (1) levels. */
const BADGE_BACKGROUNDS: Record<number, AnsiStyle> = {
  0: "bgRed",
  1: "bgYellow",
};

/** Unicode icon per log type, and its ASCII fallback. */
const TYPE_ICONS: Record<LogType, readonly [string, string]> = {
  error: ["✖", "×"],
  warn: ["⚠", "‼"],
  log: ["", ""],
  info: ["ℹ", "i"],
  success: ["✔", "√"],
  fail: ["✖", "×"],
  start: ["◐", "o"],
  debug: ["⚙", "D"],
  trace: ["→", "→"],
};

/** Matches SGR escape sequences, to measure the visible width of a line. */
// oxlint-disable-next-line no-control-regex -- matching ANSI escapes requires ESC
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/** Inline `code` spans, rendered in cyan without their backticks. */
const CODE_SPAN_PATTERN = /`([^`]+)`/g;

/** ` _word_ ` spans, rendered underlined. */
const UNDERLINE_PATTERN = /\s+_([^_]+)_\s+/g;

/** Whether an env var is set to something other than `""` or `"false"`. */
function isEnabled(value: string | undefined): boolean {
  return Boolean(value) && value !== "false";
}

/**
 * Whether to render the fancy layout. CI logs and test runs get plain
 * `[type] [tag] message` lines instead, as they did with consola.
 */
function useFancyLayout(): boolean {
  const env = getEnv();
  return !(isEnabled(env.CI) || env.NODE_ENV === "test" || isEnabled(env.TEST));
}

/** Whether stderr takes ANSI colors: `NO_COLOR`, then `FORCE_COLOR`, then TTY detection. */
function useColor(): boolean {
  const env = getEnv();
  if (env.NO_COLOR) {
    return false;
  }
  if (env.FORCE_COLOR) {
    return env.FORCE_COLOR !== "0";
  }
  return Boolean(process.stderr.isTTY) && env.TERM !== "dumb";
}

/** Whether the terminal can draw the Unicode icons. */
function supportsUnicode(): boolean {
  const env = getEnv();
  if (process.platform !== "win32") {
    return env.TERM !== "linux";
  }
  return (
    Boolean(env.WT_SESSION) ||
    env.TERM_PROGRAM === "vscode" ||
    env.TERM === "xterm-256color" ||
    env.TERM === "alacritty" ||
    env.TERMINAL_EMULATOR === "JetBrains-JediTerm"
  );
}

/**
 * Approximate visible width of a line: its length without ANSI escapes. Wide
 * characters count as one column, which only shifts the right-aligned tag.
 */
function visibleWidth(text: string): number {
  return text.replace(ANSI_PATTERN, "").length;
}

/** Options for formatting log arguments, as consola passed them. */
const FORMAT_OPTIONS = { colors: false, compact: true } as const;

/** An `Error`, or anything else carrying a stack. */
type ErrorLike = { message?: unknown; stack: string; cause?: unknown };

function isErrorLike(value: unknown): value is ErrorLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { stack?: unknown }).stack === "string"
  );
}

/**
 * Render an error as its message, its stack frames, and its causes, as consola
 * did. Unlike `util.inspect`, this leaves out the error's other properties,
 * which can hold API response details.
 */
function formatError(error: ErrorLike, depth: number): string {
  const message =
    typeof error.message === "string"
      ? error.message
      : formatWithOptions(FORMAT_OPTIONS, error);
  const indent = "  ".repeat(depth + 1);
  const cwd = process.cwd() + sep;
  const frames = error.stack
    .split("\n")
    .slice(message.split("\n").length)
    .map(
      (frame) => indent + frame.trim().replace("file://", "").replace(cwd, ""),
    )
    .join("\n");
  const prefix = depth > 0 ? `${"  ".repeat(depth)}[cause]: ` : "";
  let cause = "";
  if (isErrorLike(error.cause)) {
    cause = `\n\n${formatError(error.cause, depth + 1)}`;
  } else if (error.cause) {
    cause = `\n\n${"  ".repeat(depth + 1)}[cause]: ${formatWithOptions(FORMAT_OPTIONS, error.cause)}`;
  }
  return `${prefix}${message}\n${frames}${cause}`;
}

/** Render `logObj` as terminal lines, without a trailing newline. */
function formatLogObj(logObj: LogObject): string {
  const message = formatWithOptions(
    FORMAT_OPTIONS,
    ...logObj.args.map((arg) => (isErrorLike(arg) ? formatError(arg, 0) : arg)),
  );
  if (!useFancyLayout()) {
    return [`[${logObj.type}]`, logObj.tag && `[${logObj.tag}]`, message]
      .filter(Boolean)
      .join(" ");
  }

  const color = useColor();
  const paint = (style: AnsiStyle, text: string): string => {
    if (!(color && text)) {
      return text;
    }
    const [open, close] = ANSI_CODES[style];
    return `\x1b[${open}m${text}\x1b[${close}m`;
  };
  const markup = (text: string): string =>
    text
      .replace(CODE_SPAN_PATTERN, (_, code: string) => paint("cyan", code))
      .replace(
        UNDERLINE_PATTERN,
        (_, word: string) => ` ${paint("underline", word)} `,
      );

  const [firstLine = "", ...additional] = message.split("\n");
  const badge = BADGE_BACKGROUNDS[logObj.level];
  const type = badge
    ? paint(badge, paint("black", ` ${logObj.type.toUpperCase()} `))
    : paint(
        TYPE_COLORS[logObj.type],
        TYPE_ICONS[logObj.type][supportsUnicode() ? 0 : 1],
      );

  const columns = process.stderr.columns || 0;
  const tag = logObj.tag ? paint("gray", logObj.tag) : "";
  const date = columns ? paint("gray", formatLogTime(logObj.date)) : "";
  const left = [type, markup(firstLine)].filter(Boolean).join(" ");
  const right = [tag, date].filter(Boolean).join(" ");
  const space = columns - visibleWidth(left) - visibleWidth(right) - 2;

  let line =
    space > 0 && columns >= 80
      ? left + " ".repeat(space) + right
      : (right ? `${paint("gray", `[${right}]`)} ` : "") + left;
  if (additional.length > 0) {
    line += markup(`\n${additional.join("\n")}`);
  }
  return badge ? `\n${line}\n` : line;
}

/** The built-in reporter: render the log call and write it to stderr in one write. */
function writeLogToStderr(logObj: LogObject): void {
  process.stderr.write(`${formatLogObj(logObj)}\n`);
}
