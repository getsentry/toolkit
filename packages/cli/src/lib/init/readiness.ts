/**
 * Setup Service Readiness Check
 *
 * Checks setup-service availability before entering the remote workflow and
 * warns when it may be slow or unreachable. Authentication is handled before
 * the wizard UI is created.
 */

import { customFetch } from "../custom-ca.js";
import { logger } from "../logger.js";
import { MASTRA_API_URL } from "./constants.js";
import type { WizardUI } from "./ui/types.js";

/** Timeout for the health check fetch (5 seconds). */
const HEALTH_CHECK_TIMEOUT_MS = 5000;

/**
 * Check whether the setup service is reachable before starting the workflow.
 * Authentication is resolved before the wizard UI is created so recoverable
 * OAuth failures can use the CLI's global auto-auth flow.
 */
export async function checkReadiness(ui: WizardUI): Promise<void> {
  const spin = ui.spinner();
  spin.start("Checking prerequisites...");

  const apiOk = await checkMastraApi();

  if (apiOk) {
    spin.stop("");
  } else {
    spin.stop("Warning", 2);
    ui.log.warn(
      "Setup service may be slow or unreachable. The wizard will retry if needed."
    );
  }
}

async function checkMastraApi(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  try {
    const resp = await customFetch(`${MASTRA_API_URL}/health`, {
      signal: controller.signal,
      method: "GET",
    });
    return resp.ok;
  } catch (error) {
    logger.withTag("readiness").debug("Mastra API health check failed", error);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
