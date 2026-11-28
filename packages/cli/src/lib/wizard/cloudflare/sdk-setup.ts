/**
 * Write the Sentry initialization into the worker entry point: wrap the
 * existing handler, or create a starter worker and wrap that.
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
 * Wraps the worker entry point with Sentry initialization. When the entry
 * point the Wrangler config names, or the default one, doesn't exist yet, it
 * creates a starter worker there first, so every path ends with a wrapped
 * worker.
 */
export async function createSentryInitFile(
  dsn: string,
  selectedFeatures: {
    performance: boolean;
  },
  reduceDataCollection: boolean,
): Promise<void> {
  const entryPoint = getEntryPointFromWranglerConfig() ?? defaultEntryPoint;
  const entryPointPath = path.join(process.cwd(), entryPoint);

  if (existsSync(entryPointPath)) {
    clack.log.info(`Found existing entry point: ${chalk.cyan(entryPoint)}`);
  } else {
    clack.log.info(
      `No worker found at ${chalk.cyan(entryPoint)}, creating a new one.`,
    );

    await promises.mkdir(path.dirname(entryPointPath), { recursive: true });
    await promises.writeFile(
      entryPointPath,
      getCloudflareWorkerTemplateWithHandler(/\.[cm]?tsx?$/.test(entryPoint)),
      { encoding: "utf-8", flag: "w" },
    );

    clack.log.success(`Created ${chalk.cyan(entryPoint)}.`);
  }

  try {
    const wrapped = await wrapWorkerWithSentry(
      entryPointPath,
      dsn,
      selectedFeatures,
      reduceDataCollection,
    );
    if (wrapped) {
      clack.log.success(
        `Wrapped ${chalk.cyan(entryPoint)} with Sentry initialization.`,
      );
    }
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
