/** Types shared by the logger, its stderr reporter, and the prompt adapter. */

/** Level of each log method: a call prints when it is at most the logger's level. */
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

/** A log method name, such as `info` or `warn`. */
export type LogType = keyof typeof LOG_TYPE_LEVELS;

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

/** Environment variables the logger reads, such as `NO_COLOR` and `CI`. */
export type LoggerEnv = Record<string, string | undefined>;

/** Options for a yes/no prompt. */
export type ConfirmPromptOptions = { type: "confirm"; initial?: boolean };

/** Options for a free-text prompt. */
export type TextPromptOptions = {
  type: "text";
  placeholder?: string;
  initial?: string;
  default?: string;
};

/**
 * Asks the user a question on the terminal.
 *
 * Resolves to the answer, or to a cancel symbol when the user presses Ctrl+C,
 * so callers check for `=== true` or `typeof answer === "string"`.
 */
export type Prompt = {
  (message: string, opts: ConfirmPromptOptions): Promise<boolean | symbol>;
  (message: string, opts: TextPromptOptions): Promise<string | symbol>;
};
