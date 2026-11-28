/**
 * Runs a SvelteKit setup step as a telemetry step and tags why it failed.
 */

import { traceStep } from "../../telemetry.js";
import { Sentry } from "../../telemetry.js";

/**
 * Applies the @param modifyCallback and records Sentry tags if the call failed.
 * In case of a failure, a tag is set with @param reason as a fail reason
 * and the error is rethrown.
 */
export async function modifyAndRecordFail<T>(
  modifyCallback: () => T | Promise<T>,
  reason: string,
  fileType:
    | "server-hooks"
    | "client-hooks"
    | "vite-cfg"
    | "instrumentation-server",
): Promise<void> {
  try {
    await traceStep(`${fileType}-${reason}`, modifyCallback);
  } catch (e) {
    Sentry.setTag(`modified-${fileType}`, "fail");
    Sentry.setTag(`${fileType}-mod-fail-reason`, reason);
    throw e;
  }
}
