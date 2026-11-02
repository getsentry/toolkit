/**
 * Forwards log calls to Sentry structured logs without depending on a Sentry
 * package: pass the SDK's `logger` (`Sentry.logger` from `@sentry/node`,
 * `@sentry/bun`, `@sentry/browser`, ...), and this reporter calls it.
 */

import { flattenAttribute } from "../fields.js";
import { formatMessage } from "../message.js";
import type {
  LogAttributePrimitive,
  LogAttributeValue,
  LogType,
  Reporter,
} from "../types.js";

/** Sentry severities the reporter uses. */
type SentrySeverity = "trace" | "debug" | "info" | "warn" | "error";

/** The part of the Sentry SDK's `logger` that the reporter calls. */
export type SentryLogger = Record<
  SentrySeverity,
  (message: string, attributes?: Record<string, LogAttributePrimitive>) => void
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
 * attributes, objects expanded into dotted keys, with `logger.tag` (when
 * set), `logger.type`, and `sentry.origin`.
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
      const attributes: Record<string, LogAttributePrimitive> = {};
      for (const key of Object.keys(record.attributes)) {
        flattenAttribute(
          attributes,
          key,
          record.attributes[key] as LogAttributeValue,
        );
      }
      if (record.tag) {
        attributes["logger.tag"] = record.tag;
      }
      attributes["logger.type"] = record.type;
      attributes["sentry.origin"] = ORIGIN;
      sentryLogger[SEVERITIES[record.type]](
        formatMessage(record.args, { stack: false }),
        attributes,
      );
    },
  };
}
