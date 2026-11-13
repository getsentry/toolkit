/**
 * A finished command should let the process exit on its own: everything it
 * opened is closed, unref'd, or bounded by a deadline. When something still
 * holds the event loop, the process hangs after its output (#1237, #1956).
 *
 * Instead of forcing an exit, which drops pending telemetry, name the
 * culprit: at debug level, if the loop is still alive after `delayMs`, list
 * the resources keeping it open so a hang report says what leaked.
 *
 * The unref'd timer never keeps the process alive itself. The message goes
 * straight to stderr rather than through the logger, whose Sentry reporter
 * would queue a new log record after the exit flush.
 */
import { LOG_LEVEL_NAMES, logger } from "./logger.js";

const DEBUG_LEVEL = LOG_LEVEL_NAMES.indexOf("debug");

/** Grace period for the in-flight telemetry flush before reporting. */
const DEFAULT_DELAY_MS = 1000;

export function reportLingeringHandles(delayMs = DEFAULT_DELAY_MS): void {
  if (logger.level < DEBUG_LEVEL) {
    return;
  }
  setTimeout(() => {
    const resources = process.getActiveResourcesInfo();
    process.stderr.write(
      `[debug] Still running ${delayMs}ms after the command finished. ` +
        `Active resources: ${resources.join(", ") || "none"}\n`,
    );
  }, delayMs).unref();
}
