/**
 * The consola-style reporter: icons, colors, `WARN`/`ERROR` badges, and a
 * right-aligned `tag HH:MM:SS`. CI logs and test runs get plain
 * `[type] [tag] message` lines instead.
 */

import { formatMessage } from "../message.js";
import type {
  LogEnv,
  LogRecord,
  LogStream,
  LogType,
  Reporter,
} from "../types.js";

/** Options for {@link fancyReporter}. */
export type FancyReporterOptions = {
  /** Where lines go. Defaults to `process.stderr`. */
  stream?: LogStream;
  /**
   * Returns the environment that picks the layout and colors (`CI`, `TEST`,
   * `NODE_ENV`, `NO_COLOR`, `FORCE_COLOR`, `TERM`, ...). Called on each log
   * call. Defaults to `process.env`.
   */
  env?: () => LogEnv;
  /** Renders the time next to the tag. Defaults to {@link formatLocalTime}. */
  formatTime?: (date: Date) => string;
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
function useFancyLayout(env: LogEnv): boolean {
  return !(isEnabled(env.CI) || env.NODE_ENV === "test" || isEnabled(env.TEST));
}

/** Whether to write ANSI colors: `NO_COLOR`, then `FORCE_COLOR`, then TTY detection. */
function useColor(env: LogEnv, stream: LogStream): boolean {
  if (env.NO_COLOR) {
    return false;
  }
  if (env.FORCE_COLOR) {
    return env.FORCE_COLOR !== "0";
  }
  return Boolean(stream.isTTY) && env.TERM !== "dumb";
}

/** Whether the terminal can draw the Unicode icons. */
function supportsUnicode(env: LogEnv): boolean {
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
 * Approximate visible width of a line: its length without SGR escapes
 * (`ESC [ digits-and-semicolons m`). Wide characters count as one column,
 * which only shifts the right-aligned tag. A loop rather than a regex replace,
 * which was the most expensive step of a colored line.
 */
function visibleWidth(text: string): number {
  if (!text.includes("\x1b")) {
    return text.length;
  }
  let width = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x1b && text.charCodeAt(i + 1) === 0x5b) {
      let end = i + 2;
      let code = text.charCodeAt(end);
      while ((code >= 0x30 && code <= 0x39) || code === 0x3b) {
        code = text.charCodeAt(++end);
      }
      if (code === 0x6d) {
        i = end;
        continue;
      }
    }
    width++;
  }
  return width;
}

/** Wrap `text` in the SGR codes for `style`, when colors are on and there is text. */
function paint(color: boolean, style: AnsiStyle, text: string): string {
  if (!(color && text)) {
    return text;
  }
  const [open, close] = ANSI_CODES[style];
  return `\x1b[${open}m${text}\x1b[${close}m`;
}

/** Render inline `code` and ` _underline_ ` spans. */
function markup(color: boolean, text: string): string {
  let marked = text;
  if (marked.includes("`")) {
    marked = marked.replace(CODE_SPAN_PATTERN, (_, code: string) =>
      paint(color, "cyan", code),
    );
  }
  if (marked.includes("_")) {
    marked = marked.replace(
      UNDERLINE_PATTERN,
      (_, word: string) => ` ${paint(color, "underline", word)} `,
    );
  }
  return marked;
}

/** `a` and `b` joined by a space, leaving out the empty ones. */
function joinWords(a: string, b: string): string {
  return a && b ? `${a} ${b}` : a || b;
}

/** Render `record` as terminal lines, without a trailing newline. */
function formatRecord(
  record: LogRecord,
  env: LogEnv,
  stream: LogStream,
  formatTime: (date: Date) => string,
): string {
  const message = formatMessage(record.args, { stack: true });
  if (!useFancyLayout(env)) {
    return joinWords(
      joinWords(`[${record.type}]`, record.tag && `[${record.tag}]`),
      message,
    );
  }

  const color = useColor(env, stream);
  const newline = message.indexOf("\n");
  const firstLine = newline === -1 ? message : message.slice(0, newline);
  const badge = BADGE_BACKGROUNDS[record.level];
  const type = badge
    ? paint(
        color,
        badge,
        paint(color, "black", ` ${record.type.toUpperCase()} `),
      )
    : paint(
        color,
        TYPE_COLORS[record.type],
        TYPE_ICONS[record.type][supportsUnicode(env) ? 0 : 1],
      );

  const columns = stream.columns || 0;
  const tag = record.tag ? paint(color, "gray", record.tag) : "";
  const date = columns ? paint(color, "gray", formatTime(record.date)) : "";
  const left = joinWords(type, markup(color, firstLine));
  const right = joinWords(tag, date);
  const space =
    columns >= 80 ? columns - visibleWidth(left) - visibleWidth(right) - 2 : 0;

  let line =
    space > 0
      ? left + " ".repeat(space) + right
      : (right ? `${paint(color, "gray", `[${right}]`)} ` : "") + left;
  if (newline !== -1) {
    line += markup(color, message.slice(newline));
  }
  return badge ? `\n${line}\n` : line;
}

/**
 * A reporter for people at a terminal, in consola's "fancy" layout. Each log
 * call is one write.
 */
export function fancyReporter(options: FancyReporterOptions = {}): Reporter {
  const getEnv = options.env ?? (() => process.env);
  const formatTime = options.formatTime ?? formatLocalTime;
  return {
    log(record) {
      const stream = options.stream ?? process.stderr;
      stream.write(`${formatRecord(record, getEnv(), stream, formatTime)}\n`);
    },
  };
}
