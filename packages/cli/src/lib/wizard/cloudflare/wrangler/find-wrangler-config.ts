/**
 * Find the Wrangler config file of a Cloudflare Worker project.
 */

import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Checks if a wrangler config file exists in the project
 */
export function findWranglerConfig(): string | undefined {
  const possibleConfigs = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"];

  for (const configFile of possibleConfigs) {
    const configPath = path.join(process.cwd(), configFile);
    if (existsSync(configPath)) {
      return configFile;
    }
  }

  return undefined;
}
