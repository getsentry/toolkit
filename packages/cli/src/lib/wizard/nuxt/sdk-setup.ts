/**
 * Set up `@sentry/nuxt` in a Nuxt project: the Sentry Nuxt module in the
 * Nuxt config, the client and server SDK configs, and the `ofetch` override
 * that Nuxt before 3.14 needs.
 */

import { existsSync, promises, unlinkSync } from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { generateCode, loadFile, type ProxifiedModule } from "magicast";
import { addNuxtModule, getDefaultExportOptions } from "magicast/helpers";
import { lt, type SemVer } from "semver";
import { Sentry, traceStep } from "../telemetry.js";
import {
  abort,
  abortIfCancelled,
  askShouldAddPackageOverride,
  featureSelectionPrompt,
  isUsingTypeScript,
} from "../utils/clack/index.js";
import { clack } from "../utils/clack/prompts.js";
import type { PackageManager } from "../utils/package-manager.js";
import {
  getConfigBody,
  getDataCollectionBlock,
  getDefaultNuxtConfig,
  getNuxtModuleFallbackTemplate,
  getSentryConfigContents,
} from "./templates.js";

const possibleNuxtConfig = [
  "nuxt.config.js",
  "nuxt.config.mjs",
  "nuxt.config.cjs",
  "nuxt.config.ts",
  "nuxt.config.mts",
  "nuxt.config.cts",
];

/**
 * The path of the Nuxt config file, after creating `nuxt.config.ts` when
 * there is none.
 */
export async function getNuxtConfig(): Promise<string> {
  let configFile = possibleNuxtConfig.find((fileName) =>
    existsSync(path.join(process.cwd(), fileName)),
  );

  if (!configFile) {
    clack.log.info("No Nuxt config file found, creating a new one.");
    Sentry.setTag("nuxt-config-strategy", "create");
    // nuxt recommends its config to be .ts by default
    configFile = "nuxt.config.ts";

    await promises.writeFile(
      path.join(process.cwd(), configFile),
      getDefaultNuxtConfig(),
      { encoding: "utf-8", flag: "w" },
    );

    clack.log.success(`Created ${chalk.cyan("nuxt.config.ts")}.`);
  }

  return path.join(process.cwd(), configFile);
}

/** Add `@sentry/nuxt/module` and its options to the Nuxt config. */
export async function addSDKModule(
  config: string,
  options: { org: string; project: string; url: string; selfHosted: boolean },
): Promise<void> {
  const failureTagKey = "modify-nuxt-config-error";

  let module: ProxifiedModule;

  try {
    module = await loadFile(config);
  } catch (e) {
    if (e instanceof Error) {
      if (e instanceof SyntaxError || e.message.includes("Unexpected token")) {
        Sentry.setTag(failureTagKey, "loadFile-failed-syntax-error");
      } else if (
        e.message.includes("ENOENT") ||
        e.message.includes("no such file")
      ) {
        Sentry.setTag(failureTagKey, "loadFile-failed-file-not-found");
      }
    } else {
      Sentry.setTag(failureTagKey, "loadFile-failed");
    }

    clack.log.error(
      `Error while loading Nuxt config file: ${
        e instanceof Error ? e.message : "Unknown"
      }`,
    );

    showFallbackInstructions(config, options);
    return await abort();
  }

  try {
    addNuxtModule(module, "@sentry/nuxt/module", "sentry", {
      org: options.org,
      project: options.project,
      ...(options.selfHosted && { sentryUrl: options.url }),
    });
  } catch (e) {
    Sentry.setTag(failureTagKey, "adding-sentry-options-failed");

    clack.log.error(
      `Error while modifying 'sentry' in Nuxt config: ${
        e instanceof Error ? e.message : "Unknown"
      }`,
    );

    showFallbackInstructions(config, options);
    return await abort();
  }

  try {
    const nuxtConfig = getDefaultExportOptions(module);
    // `sourcemap: true` turns on server and client maps, but a boolean has no
    // `client` key to hide, so spell it out before merging.
    if (nuxtConfig["sourcemap"] === true) {
      nuxtConfig["sourcemap"] = { server: true, client: true };
    }
    addNuxtModule(module, "@sentry/nuxt/module", "sourcemap", {
      client: "hidden",
    });
  } catch (e) {
    Sentry.setTag(failureTagKey, "adding-sourcemap-options-failed");

    clack.log.error(
      `Error while modifying 'sourcemap' in Nuxt config: ${
        e instanceof Error ? e.message : "Unknown"
      }`,
    );

    showFallbackInstructions(config, options);
    return await abort();
  }

  let code: string;

  try {
    ({ code } = generateCode(module));
  } catch (e) {
    Sentry.setTag(failureTagKey, "generateCode-failed");

    clack.log.error(
      `Error while generating module code: ${
        e instanceof Error ? e.message : "Unknown"
      }`,
    );

    showFallbackInstructions(config, options);
    return await abort();
  }

  try {
    await promises.writeFile(config, code, { encoding: "utf-8", flag: "w" });

    clack.log.success(
      `Added Sentry Nuxt Module to ${chalk.cyan(path.basename(config))}.`,
    );
  } catch (e: unknown) {
    Sentry.setTag(failureTagKey, "writeFile-failed");

    clack.log.error(
      `Error while writing Nuxt config: ${
        e instanceof Error ? e.message : "Unknown"
      }`,
    );

    showFallbackInstructions(config, options);
    return await abort();
  }
}

function showFallbackInstructions(
  config: string,
  options: { org: string; project: string; url: string; selfHosted: boolean },
): void {
  clack.log.warn(
    `Please add the following settings to ${chalk.cyan(
      path.basename(config),
    )}:`,
  );
  // Printed outside clack's gutter so that it can be copied/pasted directly
  clack.rawOutput(`\n\n${getNuxtModuleFallbackTemplate(options)}\n\n`);
}

/** Ask for the features to enable, then write `sentry.{client,server}.config.{ts,js}`. */
export async function createConfigFiles(
  dsn: string,
  reduceDataCollection: boolean,
): Promise<void> {
  const selectedFeatures = await featureSelectionPrompt([
    {
      id: "performance",
      prompt: `Do you want to enable ${chalk.bold(
        "Tracing",
      )} to track the performance of your application?`,
      enabledHint: "recommended",
    },
    {
      id: "replay",
      prompt: `Do you want to enable ${chalk.bold(
        "Session Replay",
      )} to get a video-like reproduction of errors during a user session?`,
      enabledHint: "recommended, but increases bundle size",
    },
  ] as const);

  const typeScriptDetected = isUsingTypeScript();

  const configVariants = ["server", "client"] as const;

  for (const configVariant of configVariants) {
    await traceStep(`create-sentry-${configVariant}-config`, async () => {
      const jsConfig = `sentry.${configVariant}.config.js`;
      const tsConfig = `sentry.${configVariant}.config.ts`;

      const jsConfigExists = existsSync(path.join(process.cwd(), jsConfig));
      const tsConfigExists = existsSync(path.join(process.cwd(), tsConfig));

      let shouldWriteFile = true;

      if (jsConfigExists || tsConfigExists) {
        const existingConfigs: string[] = [];

        if (jsConfigExists) {
          existingConfigs.push(jsConfig);
        }

        if (tsConfigExists) {
          existingConfigs.push(tsConfig);
        }

        const overwriteExistingConfigs = await abortIfCancelled(
          clack.confirm({
            message: `Found existing Sentry ${configVariant} config (${existingConfigs.join(
              ", ",
            )}). Overwrite ${existingConfigs.length > 1 ? "them" : "it"}?`,
          }),
        );
        Sentry.setTag(
          `overwrite-${configVariant}-config`,
          overwriteExistingConfigs,
        );

        shouldWriteFile = overwriteExistingConfigs;

        if (overwriteExistingConfigs) {
          if (jsConfigExists) {
            unlinkSync(path.join(process.cwd(), jsConfig));
            clack.log.warn(`Removed existing ${chalk.cyan(jsConfig)}.`);
          }
          if (tsConfigExists) {
            unlinkSync(path.join(process.cwd(), tsConfig));
            clack.log.warn(`Removed existing ${chalk.cyan(tsConfig)}.`);
          }
        }
      }

      if (shouldWriteFile) {
        await promises.writeFile(
          path.join(process.cwd(), typeScriptDetected ? tsConfig : jsConfig),
          getSentryConfigContents(
            dsn,
            configVariant,
            selectedFeatures,
            reduceDataCollection,
          ),
          { encoding: "utf8", flag: "w" },
        );
        clack.log.success(
          `Created new ${chalk.cyan(
            typeScriptDetected ? tsConfig : jsConfig,
          )}.`,
        );
        Sentry.setTag(`created-${configVariant}-config`, true);
      } else {
        clack.log.info(
          `Okay, here are the changes your ${chalk.cyan(
            typeScriptDetected ? tsConfig : jsConfig,
          )} should contain:`,
        );
        // Printed outside clack's gutter so that it can be copied/pasted directly
        clack.rawOutput(
          `\n\n  ${getConfigBody(dsn, configVariant, selectedFeatures)}\n\n${getDataCollectionBlock(reduceDataCollection)}\n\n`,
        );
      }
    });
  }
}

/**
 * On Nuxt before 3.14, offer to override `ofetch` to `^1.4.0`, which Sentry
 * needs to instrument the app.
 */
export async function addNuxtOverrides(
  packageManager: PackageManager,
  nuxtMinVer: SemVer | undefined,
): Promise<void> {
  if (!nuxtMinVer || !lt(nuxtMinVer, "3.14.0")) {
    return;
  }

  const pkgName = "ofetch";
  const pkgVersion = "^1.4.0";

  clack.log.warn(
    `To ensure Sentry can properly instrument your code it needs to add a version override for ${chalk.cyan(
      pkgName,
    )}.\n\nFor more info see: ${chalk.underline(
      "https://github.com/getsentry/sentry-javascript/issues/14514",
    )}`,
  );

  const shouldAddOverride = await askShouldAddPackageOverride(
    pkgName,
    pkgVersion,
  );

  if (shouldAddOverride) {
    await packageManager.addOverride(pkgName, pkgVersion);
  }
}
