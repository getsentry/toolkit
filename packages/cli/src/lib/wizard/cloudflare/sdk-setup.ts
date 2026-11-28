/**
 * Write the Sentry initialization into the worker entry point: wrap an
 * existing handler, or create an entry point when the Wrangler config names
 * none.
 */

import chalk from "chalk";
import { existsSync, promises } from "node:fs";
import path from "node:path";

import { clack } from "../utils/clack/prompts.js";
import { debug } from "../utils/debug.js";
import {
  getCloudflareWorkerTemplate,
  getCloudflareWorkerTemplateWithHandler,
} from "./templates.js";
import {
  defaultEntryPoint,
  getEntryPointFromWranglerConfig,
} from "./wrangler/get-entry-point-from-wrangler-config.js";
import { wrapWorkerWithSentry } from "./wrap-worker.js";

/**
 * Creates or updates the main worker file with Sentry initialization.
 * Currently focused on Cloudflare Workers
 */
export async function createSentryInitFile(
  dsn: string,
  selectedFeatures: {
    performance: boolean;
  },
  reduceDataCollection: boolean,
): Promise<void> {
  const entryPointFromConfig = getEntryPointFromWranglerConfig();

  if (!entryPointFromConfig) {
    clack.log.info(
      "No entry point found in wrangler config, creating a new one.",
    );

    const cloudflareWorkerTemplate = getCloudflareWorkerTemplateWithHandler();

    await promises.mkdir(
      path.join(process.cwd(), path.dirname(defaultEntryPoint)),
      {
        recursive: true,
      },
    );
    await promises.writeFile(
      path.join(process.cwd(), defaultEntryPoint),
      cloudflareWorkerTemplate,
      { encoding: "utf-8", flag: "w" },
    );

    clack.log.success(`Created ${chalk.cyan(defaultEntryPoint)}.`);

    return;
  }

  const entryPointPath = path.join(process.cwd(), entryPointFromConfig);

  if (existsSync(entryPointPath)) {
    clack.log.info(
      `Found existing entry point: ${chalk.cyan(entryPointFromConfig)}`,
    );

    try {
      await wrapWorkerWithSentry(
        entryPointPath,
        dsn,
        selectedFeatures,
        reduceDataCollection,
      );
      clack.log.success(
        `Wrapped ${chalk.cyan(
          entryPointFromConfig,
        )} with Sentry initialization.`,
      );
    } catch (error) {
      debug(error);
      clack.log.warn("Failed to wrap worker automatically.");
      clack.log.step("Please wrap your handler with Sentry initialization:");

      clack.note(
        chalk.cyan(
          getCloudflareWorkerTemplate(
            dsn,
            selectedFeatures,
            reduceDataCollection,
          ),
        ),
      );
    }
  }
}
