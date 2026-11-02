/** Log level names and parsing. */

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

/** A valid log level name. */
export type LogLevelName = (typeof LOG_LEVEL_NAMES)[number];

/** Level 3 shows info, success, start, log, fail — standard user-facing output. */
export const DEFAULT_LOG_LEVEL = 3;

/**
 * Parse a log level name into a numeric level.
 *
 * Returns the default level (info, 3) for unrecognized values so that a typo
 * in an env var or flag doesn't break the program.
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
