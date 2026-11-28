/**
 * Make sure a Cloudflare Worker project has a Wrangler config.
 */

import chalk from "chalk";

import { clack } from "../../utils/clack/prompts.js";
import { createWranglerConfig } from "./create-wrangler-config.js";
import { findWranglerConfig } from "./find-wrangler-config.js";

/**
 * Ensures a wrangler config exists, creating one if necessary
 */
export function ensureWranglerConfig(): void {
  const existingConfig = findWranglerConfig();

  if (existingConfig) {
    clack.log.info(
      `Found existing Wrangler config: ${chalk.cyan(existingConfig)}`,
    );
    return;
  }

  clack.log.step("No Wrangler configuration file found.");
  createWranglerConfig();
}
