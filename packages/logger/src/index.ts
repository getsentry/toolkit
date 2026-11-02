/**
 * A small, dependency-free structured logger for Node.js and Bun.
 *
 * A logger turns each call into a {@link LogRecord} (level, tag, arguments,
 * and attributes) and hands it to its reporters: `fancyReporter` for people
 * at a terminal, `jsonReporter` and `logfmtReporter` for log collectors, and
 * `sentryReporter` for Sentry structured logs.
 *
 * @module
 */

export {
  DEFAULT_LOG_LEVEL,
  LOG_LEVEL_NAMES,
  type LogLevelName,
  parseLogLevel,
} from "./levels.js";
export { createLogger, type Logger, type LoggerOptions } from "./logger.js";
export {
  type FancyReporterOptions,
  fancyReporter,
  formatLocalTime,
} from "./reporters/fancy.js";
export { jsonReporter, type StreamReporterOptions } from "./reporters/json.js";
export { logfmtReporter } from "./reporters/logfmt.js";
export { type SentryLogger, sentryReporter } from "./reporters/sentry.js";
export type {
  LogAttributePrimitive,
  LogAttributes,
  LogAttributeValue,
  LogEnv,
  LogRecord,
  LogStream,
  LogType,
  Reporter,
} from "./types.js";
