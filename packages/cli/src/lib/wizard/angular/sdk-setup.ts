/**
 * Add Sentry to an Angular app: `Sentry.init()` in `src/main.ts` and the
 * Sentry providers in `src/app/app.config.ts`.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import type { namedTypes as t } from "ast-types";
import chalk from "chalk";
import { loadFile, writeFile } from "magicast";
import type { SemVer } from "semver";
import { Sentry } from "../telemetry.js";
import { hasSentryContent } from "../utils/ast-utils.js";
import { clack } from "../utils/clack/prompts.js";
import { debug } from "../utils/debug.js";
import { updateAppConfigMod } from "./codemods/app-config.js";
import { updateAppEntryMod } from "./codemods/main.js";

/** Import Sentry and call `Sentry.init()` in `src/main.ts`. */
export async function initializeSentryOnApplicationEntry(
  dsn: string,
  selectedFeatures: {
    performance: boolean;
    replay: boolean;
  },
  reduceDataCollection: boolean,
): Promise<void> {
  const appEntryFilename = "main.ts";
  const appEntryPath = path.join(process.cwd(), "src", appEntryFilename);

  const originalAppEntry = await loadFile(appEntryPath);

  if (hasSentryContent(originalAppEntry.$ast as t.Program)) {
    clack.log.warn(
      `File ${chalk.cyan(appEntryFilename)} already contains Sentry.
Skipping adding Sentry functionality to ${chalk.cyan(appEntryFilename)}.`,
    );

    return;
  }

  const updatedAppEntryMod = updateAppEntryMod(
    originalAppEntry,
    dsn,
    selectedFeatures,
    reduceDataCollection,
  );

  try {
    await writeFile(updatedAppEntryMod.$ast, appEntryPath);
  } catch (error: unknown) {
    // Not fatal: the user gets the manual setup steps instead.
    debug(error);
    clack.log.error(
      `Error while adding Sentry to ${chalk.cyan(appEntryFilename)}`,
    );

    clack.log.warn(
      `Please refer to the documentation for manual setup:
${chalk.underline(
  "https://docs.sentry.io/platforms/javascript/guides/angular/#configure",
)}`,
    );

    return;
  }

  clack.log.success(
    `Successfully initialized Sentry in ${chalk.cyan(appEntryFilename)}`,
  );
}

/** Add the Sentry providers to `src/app/app.config.ts`. */
export async function updateAppConfig(
  angularVersion: SemVer,
  isTracingEnabled: boolean,
): Promise<void> {
  const appConfigFilename = "app.config.ts";
  const appConfigPath = path.join(
    process.cwd(),
    "src",
    "app",
    appConfigFilename,
  );

  if (!existsSync(appConfigPath)) {
    Sentry.setTag("angular-app-config-found", false);

    clack.log.warn(
      `File ${chalk.cyan(
        appConfigFilename,
      )} not found. Skipping adding Sentry functionality.`,
    );

    clack.log.warn(`Please refer to the documentation for manual setup:
${chalk.underline(
  "https://docs.sentry.io/platforms/javascript/guides/angular/#configure",
)}`);

    return;
  }

  Sentry.setTag("angular-app-config-found", true);

  const appConfig = await loadFile(appConfigPath);

  if (hasSentryContent(appConfig.$ast as t.Program)) {
    clack.log.warn(
      `File ${chalk.cyan(appConfigFilename)} already contains Sentry.
  Skipping adding Sentry functionality to ${chalk.cyan(appConfigFilename)}.`,
    );

    return;
  }

  try {
    const updatedAppConfigMod = updateAppConfigMod(
      appConfig,
      angularVersion,
      isTracingEnabled,
    );

    await writeFile(updatedAppConfigMod.$ast, appConfigPath);
  } catch (error: unknown) {
    clack.log.error(
      `Error while updating your app config ${chalk.cyan(appConfigFilename)}.`,
    );

    clack.log.info(
      chalk.dim(
        error instanceof Error
          ? error.toString()
          : typeof error === "string"
            ? error
            : "",
      ),
    );

    clack.log.warn(`Please refer to the documentation for manual setup:
${chalk.underline(
  "https://docs.sentry.io/platforms/javascript/guides/angular/#configure",
)}`);

    return;
  }

  clack.log.success(
    `Successfully updated your app config ${chalk.cyan(appConfigFilename)}`,
  );
}
