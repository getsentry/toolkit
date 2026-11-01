/** The logger: levels, tags, attributes, and the reporters it fans out to. */

import { DEFAULT_LOG_LEVEL } from "./levels.js";
import { fancyReporter } from "./reporters/fancy.js";
import {
  LOG_TYPE_LEVELS,
  type LogAttributes,
  type LogRecord,
  type LogType,
  type Reporter,
} from "./types.js";

/** Options for {@link createLogger}. */
export type LoggerOptions = {
  /** Initial level. Defaults to 3 (info). */
  level?: number;
  /** Where log calls go. Defaults to one `fancyReporter()` on stderr. */
  reporters?: readonly Reporter[];
};

/** Level and reporters shared by a root logger and its scoped loggers. */
type LoggerState = { level: number; reporters: Reporter[] };

/** A log method: `console.log`-style arguments, with `%s`-style placeholders. */
type LogMethod = (...args: unknown[]) => void;

/**
 * A logger, optionally scoped to a tag and attributes carried by each record.
 * Create a root logger with {@link createLogger}; `withTag()` and
 * `withAttributes()` return scoped loggers.
 */
class Logger {
  /** Tag shown with each message; nested tags join with `:`. */
  readonly tag: string;
  /** Attributes added to each record. */
  readonly attributes: LogAttributes;

  readonly #state: LoggerState;

  // Arrow properties keep the methods bound, so they can be passed around.
  readonly error: LogMethod = (...args) => this.#emit("error", args);
  readonly warn: LogMethod = (...args) => this.#emit("warn", args);
  readonly log: LogMethod = (...args) => this.#emit("log", args);
  readonly info: LogMethod = (...args) => this.#emit("info", args);
  readonly success: LogMethod = (...args) => this.#emit("success", args);
  readonly fail: LogMethod = (...args) => this.#emit("fail", args);
  readonly start: LogMethod = (...args) => this.#emit("start", args);
  readonly debug: LogMethod = (...args) => this.#emit("debug", args);
  readonly trace: LogMethod = (...args) => this.#emit("trace", args);

  constructor(state: LoggerState, tag: string, attributes: LogAttributes) {
    this.#state = state;
    this.tag = tag;
    this.attributes = attributes;
  }

  /** The shared level: calls above it are dropped. */
  get level(): number {
    return this.#state.level;
  }

  set level(level: number) {
    this.#state.level = level;
  }

  /** Return a logger whose records carry `tag`, nested under this logger's tag. */
  withTag(tag: string): Logger {
    return new Logger(
      this.#state,
      this.tag ? `${this.tag}:${tag}` : tag,
      this.attributes,
    );
  }

  /** Return a logger whose records carry `attributes` on top of this logger's. */
  withAttributes(attributes: LogAttributes): Logger {
    return new Logger(this.#state, this.tag, {
      ...this.attributes,
      ...attributes,
    });
  }

  /** Send every later log call, from this logger and its relatives, to `reporter` too. */
  addReporter(reporter: Reporter): void {
    this.#state.reporters.push(reporter);
  }

  #emit(type: LogType, args: unknown[]): void {
    const level = LOG_TYPE_LEVELS[type];
    if (level > this.#state.level) {
      return;
    }
    const record: LogRecord = {
      date: new Date(),
      args,
      type,
      level,
      tag: this.tag,
      attributes: this.attributes,
    };
    for (const reporter of this.#state.reporters) {
      reporter.log(record);
    }
  }
}

/**
 * Create a root logger.
 *
 * ```ts
 * import { createLogger } from "@sentry/logger";
 *
 * const logger = createLogger();
 * logger.info("Checking for updates...");
 * logger.withTag("upgrade").debug("Resolved 0.12.0 → 0.13.0");
 * ```
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  return new Logger(
    {
      level: options.level ?? DEFAULT_LOG_LEVEL,
      reporters: [...(options.reporters ?? [fancyReporter()])],
    },
    "",
    {},
  );
}

export type { Logger };
