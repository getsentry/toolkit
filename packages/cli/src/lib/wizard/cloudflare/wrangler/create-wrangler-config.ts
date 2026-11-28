/**
 * Create a minimal `wrangler.jsonc` for a project that has no Wrangler
 * config yet.
 */

import chalk from "chalk";
import { writeFileSync } from "node:fs";
import path from "node:path";

import { clack } from "../../utils/clack/prompts.js";

/**
 * Creates a basic wrangler.jsonc config file for a Cloudflare Worker
 */
export function createWranglerConfig(): void {
  const configPath = path.join(process.cwd(), "wrangler.jsonc");

  const config = {
    $schema: "node_modules/wrangler/config-schema.json",
    name: "my-worker",
    main: "src/index.ts",
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

  clack.log.success(
    `Created ${chalk.cyan("wrangler.jsonc")} configuration file.`,
  );
  clack.log.info(
    `Please update the ${chalk.cyan("name")} and ${chalk.cyan(
      "main",
    )} fields in ${chalk.cyan(
      "wrangler.jsonc",
    )} to match your worker name and entry point.`,
  );
}
