/**
 * Renders log records the way consola's "fancy" reporter did: icons, colors,
 * `WARN`/`ERROR` badges, and a right-aligned `tag HH:MM:SS`. CI logs and test
 * runs get plain `[type] [tag] message` lines instead.
 */

import { sep } from "node:path";
import { formatWithOptions } from "node:util";

import type { LogObject, LoggerEnv, LogType } from "./types.js";

/** How the stderr reporter reads its environment and renders the time. */
export type FormatOptions = {
  env: () => LoggerEnv;
  formatTime: (date: Date) => string;
};

/**
 * Format a `Date` as a 24-hour `HH:MM:SS` clock string in local time.
 *
 * Unlike `date.toLocaleTimeString()`, this does not depend on ICU being able
 * to resolve a zone: it derives the local wall-clock time from the UTC time
 * and `getTimezoneOffset()`, which reflects the OS offset even in runtimes
 * that cache a stale UTC formatter, such as some Node SEA builds.
 *
 * @param date - The log record's timestamp
 * @returns A `HH:MM:SS` string in local time (e.g. `"06:28:59"`)
 */
export function formatLocalTime(date: Date): string {
  // getTimezoneOffset() is minutes behind UTC (positive west of UTC). Shifting
  // the epoch by it and reading UTC getters yields local wall-clock components
  // without relying on the ICU formatter.
  const localMs = date.getTime() - date.getTimezoneOffset() * 60_000;
  const local = new Date(localMs);
  const hh = String(local.getUTCHours()).padStart(2, "0");
  const mm = String(local.getUTCMinutes()).padStart(2, "0");
  const ss = String(local.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

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
function useFancyLayout(env: LoggerEnv): boolean {
  return !(isEnabled(env.CI) || env.NODE_ENV === "test" || isEnabled(env.TEST));
}

/** Whether stderr takes ANSI colors: `NO_COLOR`, then `FORCE_COLOR`, then TTY detection. */
function useColor(env: LoggerEnv): boolean {
  if (env.NO_COLOR) {
    return false;
  }
  if (env.FORCE_COLOR) {
    return env.FORCE_COLOR !== "0";
  }
  return Boolean(process.stderr.isTTY) && env.TERM !== "dumb";
}

/** Whether the terminal can draw the Unicode icons. */
function supportsUnicode(env: LoggerEnv): boolean {
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
const INSPECT_OPTIONS = { colors: false, compact: true } as const;

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
      : formatWithOptions(INSPECT_OPTIONS, error);
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
    cause = `\n\n${"  ".repeat(depth + 1)}[cause]: ${formatWithOptions(INSPECT_OPTIONS, error.cause)}`;
  }
  return `${prefix}${message}\n${frames}${cause}`;
}

/** Render `logObj` as terminal lines, without a trailing newline. */
export function formatLogObj(
  logObj: LogObject,
  { env: getEnv, formatTime }: FormatOptions,
): string {
  const env = getEnv();
  const message = formatWithOptions(
    INSPECT_OPTIONS,
    ...logObj.args.map((arg) => (isErrorLike(arg) ? formatError(arg, 0) : arg)),
  );
  if (!useFancyLayout(env)) {
    return [`[${logObj.type}]`, logObj.tag && `[${logObj.tag}]`, message]
      .filter(Boolean)
      .join(" ");
  }

  const color = useColor(env);
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
        TYPE_ICONS[logObj.type][supportsUnicode(env) ? 0 : 1],
      );

  const columns = process.stderr.columns || 0;
  const tag = logObj.tag ? paint("gray", logObj.tag) : "";
  const date = columns ? paint("gray", formatTime(logObj.date)) : "";
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
