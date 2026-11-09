/** Types shared by the logger and its reporters. */

/**
 * Numeric level of each log method. A call is recorded when its level is at
 * most the logger's level.
 */
export const LOG_TYPE_LEVELS = {
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

/** A log method name, such as `info` or `success`. */
export type LogType = keyof typeof LOG_TYPE_LEVELS;

/** A structured attribute value that is not an object. */
export type LogAttributePrimitive = string | number | boolean;

/**
 * A structured attribute value: a primitive, or an object of them. Reporters
 * that need flat fields (logfmt, Sentry) expand objects into dotted keys.
 */
export type LogAttributeValue =
  | LogAttributePrimitive
  | { readonly [key: string]: LogAttributeValue };

/** Structured attributes attached to log records. */
export type LogAttributes = Readonly<Record<string, LogAttributeValue>>;

/**
 * One log call.
 *
 * `date`, `args`, `type`, `level`, and `tag` keep consola's log object shape,
 * so reporters written for consola can read records.
 */
export type LogRecord = {
  date: Date;
  /** The arguments passed to the log method, formatted like `console.log`. */
  args: readonly unknown[];
  type: LogType;
  level: number;
  /** The logger's tag; nested tags join with `:`. Empty for the root logger. */
  tag: string;
  /** Attributes from `withAttributes()`. */
  attributes: LogAttributes;
};

/** Receives every log call at or below the logger's level. */
export type Reporter = {
  log(record: LogRecord): void;
};

/** Where text reporters write. `process.stdout` and `process.stderr` fit. */
export type LogStream = {
  write(chunk: string): unknown;
  isTTY?: boolean;
  columns?: number;
};

/** Environment variables the fancy reporter reads, such as `NO_COLOR` and `CI`. */
export type LogEnv = Readonly<Record<string, string | undefined>>;
