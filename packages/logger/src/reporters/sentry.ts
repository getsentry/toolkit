/**
 * Forwards log calls to Sentry structured logs without depending on a Sentry
 * package: pass the SDK's `logger` (`Sentry.logger` from `@sentry/node`,
 * `@sentry/bun`, `@sentry/browser`, ...), and this reporter calls it.
 */

import { formatMessage } from "../message.js";
import type { LogAttributeValue, LogType, Reporter } from "../types.js";

/** Sentry severities the reporter uses. */
type SentrySeverity = "trace" | "debug" | "info" | "warn" | "error";

/** The part of the Sentry SDK's `logger` that the reporter calls. */
export type SentryLogger = Record<
  SentrySeverity,
  (message: string, attributes?: Record<string, LogAttributeValue>) => void
>;

/** Sentry severity for each log type. */
const SEVERITIES: Record<LogType, SentrySeverity> = {
  error: "error",
  fail: "error",
  warn: "warn",
  log: "info",
  info: "info",
  success: "info",
  start: "info",
  debug: "debug",
  trace: "trace",
};

/** `sentry.origin` of every forwarded log, for filtering in Sentry. */
const ORIGIN = "auto.log.sentry_logger";

/**
 * A reporter that sends each log call to Sentry structured logs, at the
 * severity matching its type.
 *
 * The message is the formatted arguments; errors contribute their message
 * and causes, not their stacks. The record's attributes are sent as log
 * attributes, with `logger.tag` (when set), `logger.type`, and
 * `sentry.origin`.
 *
 * ```ts
 * import * as Sentry from "@sentry/node";
 *
 * logger.addReporter(sentryReporter(Sentry.logger));
 * ```
 */
export function sentryReporter(sentryLogger: SentryLogger): Reporter {
  return {
    log(record) {
      sentryLogger[SEVERITIES[record.type]](
        formatMessage(record.args, { stack: false }),
        {
          ...record.attributes,
          ...(record.tag && { "logger.tag": record.tag }),
          "logger.type": record.type,
          "sentry.origin": ORIGIN,
        },
      );
    },
  };
}
