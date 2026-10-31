/**
 * A small terminal logger with log levels, tag scoping, and consola-style
 * stderr output. Each log call goes to every registered reporter:
 *
 * 1. **The stderr reporter** (built in) — renders consola's "fancy" layout
 *    (icons, colors, `WARN`/`ERROR` badges, a right-aligned `tag HH:MM:SS`) and
 *    falls back to plain `[type] [tag] message` lines in CI and tests.
 * 2. **Any reporter passed to `addReporter()`**, such as
 *    `Sentry.createConsolaReporter()`. Log records keep consola's
 *    `{ date, args, type, level, tag }` shape so that reporter reads them.
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
 * Every logger, including the scoped ones `withTag()` returns, shares its
 * root's level and reporter list, so a later level change also reaches the
 * scoped loggers that modules create at import time.
 *
 * @module
 */

import { formatLocalTime, formatLogObj } from "./format.js";
import {
  type ConfirmPromptOptions,
  LOG_TYPE_LEVELS,
  type LogObject,
  type LogReporter,
  type LoggerEnv,
  type LogType,
  type Prompt,
  type TextPromptOptions,
} from "./types.js";

export { formatLocalTime } from "./format.js";
export type {
  ConfirmPromptOptions,
  LogObject,
  LogReporter,
  LoggerEnv,
  LogType,
  Prompt,
  TextPromptOptions,
} from "./types.js";

/**
 * Valid log level names. The array index is the numeric level:
 * 0 = error, 1 = warn, 2 = log, 3 = info (default), 4 = debug, 5 = trace.
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

/** Level 3 shows info, success, start, log, fail — standard user-facing output. */
const DEFAULT_LOG_LEVEL = 3;

/**
 * Parse a log level name into a numeric level.
 *
 * Returns {@link DEFAULT_LOG_LEVEL} for unrecognized values so that a typo in
 * an env var or flag doesn't break the program.
 *
 * @param name - Level name, case-insensitive
 * @returns numeric level
 */
export function parseLogLevel(name: string): number {
  const idx = LOG_LEVEL_NAMES.indexOf(
    name.toLowerCase().trim() as LogLevelName,
  );
  return idx === -1 ? DEFAULT_LOG_LEVEL : idx;
}

/** Options for {@link createLogger}. */
export type LoggerOptions = {
  /** Initial level. Defaults to {@link DEFAULT_LOG_LEVEL} (info). */
  level?: number;
  /**
   * Returns the environment the stderr reporter reads (`CI`, `NO_COLOR`,
   * `FORCE_COLOR`, `TERM`, ...). Called on each log call. Defaults to
   * `process.env`.
   */
  env?: () => LoggerEnv;
  /** Renders the time shown next to the tag. Defaults to {@link formatLocalTime}. */
  formatTime?: (date: Date) => string;
  /**
   * Answers `logger.prompt()`. Pass `clackPrompt` from
   * `@sentry/cli-logger/prompt` to ask with `@clack/prompts`. Without one,
   * `logger.prompt()` rejects.
   */
  prompt?: Prompt;
};

/** Level, reporters, and prompt shared by a root logger and its scoped loggers. */
type LoggerState = {
  level: number;
  reporters: LogReporter[];
  prompt: Prompt | undefined;
};

/**
 * A logger, optionally scoped to a tag shown with each message. Create a root
 * logger with {@link createLogger} and a scoped one with `withTag()`.
 */
class Logger {
  /** Tag shown with each message; nested tags join with `:`. */
  readonly tag: string;

  readonly #state: LoggerState;

  // Arrow properties keep the methods bound, so they can be passed around.
  readonly error = (...args: unknown[]): void => this.#emit("error", args);
  readonly warn = (...args: unknown[]): void => this.#emit("warn", args);
  readonly log = (...args: unknown[]): void => this.#emit("log", args);
  readonly info = (...args: unknown[]): void => this.#emit("info", args);
  readonly success = (...args: unknown[]): void => this.#emit("success", args);
  readonly fail = (...args: unknown[]): void => this.#emit("fail", args);
  readonly start = (...args: unknown[]): void => this.#emit("start", args);
  readonly debug = (...args: unknown[]): void => this.#emit("debug", args);
  readonly trace = (...args: unknown[]): void => this.#emit("trace", args);

  /**
   * Ask the user a question with the `prompt` passed to {@link createLogger}.
   * Resolves to the answer, or to a cancel symbol on Ctrl+C.
   */
  readonly prompt: Prompt;

  constructor(state: LoggerState, tag: string) {
    this.#state = state;
    this.tag = tag;
    this.prompt = ((
      message: string,
      opts: ConfirmPromptOptions | TextPromptOptions,
    ) => {
      if (!state.prompt) {
        return Promise.reject(
          new Error(
            "No prompt is configured. Pass `prompt` to createLogger(), such as `clackPrompt` from @sentry/cli-logger/prompt.",
          ),
        );
      }
      return state.prompt(message, opts as ConfirmPromptOptions);
    }) as Prompt;
  }

  /** The shared level: calls above it are dropped. */
  get level(): number {
    return this.#state.level;
  }

  set level(level: number) {
    this.#state.level = level;
  }

  /** Return a logger whose messages carry `tag`, nested under this logger's tag. */
  withTag(tag: string): Logger {
    return new Logger(this.#state, this.tag ? `${this.tag}:${tag}` : tag);
  }

  /** Send every later log call, from this logger and its relatives, to `reporter` too. */
  addReporter(reporter: LogReporter): void {
    this.#state.reporters.push(reporter);
  }

  #emit(type: LogType, args: unknown[]): void {
    const level = LOG_TYPE_LEVELS[type];
    if (level > this.#state.level) {
      return;
    }
    const logObj: LogObject = {
      date: new Date(),
      args,
      type,
      level,
      tag: this.tag,
    };
    for (const reporter of this.#state.reporters) {
      reporter.log(logObj);
    }
  }
}

/**
 * Create a root logger that writes to stderr.
 *
 * ```ts
 * import { createLogger } from "@sentry/cli-logger";
 *
 * const logger = createLogger();
 * logger.info("Checking for updates...");
 * logger.withTag("upgrade").debug("Resolved 0.12.0 → 0.13.0");
 * ```
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const format = {
    env: options.env ?? (() => process.env),
    formatTime: options.formatTime ?? formatLocalTime,
  };
  const stderrReporter: LogReporter = {
    log: (logObj) => {
      process.stderr.write(`${formatLogObj(logObj, format)}\n`);
    },
  };
  return new Logger(
    {
      level: options.level ?? DEFAULT_LOG_LEVEL,
      reporters: [stderrReporter],
      prompt: options.prompt,
    },
    "",
  );
}

export type { Logger };
