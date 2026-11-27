/**
 * Expo support for the React Native wizard: detect continuous native
 * generation, and add the Sentry config plugin to `app.json`.
 */

import { clack } from "../utils/clack/prompts.js";
import { debug } from "../utils/debug.js";
import { reportCliError } from "../../error-reporting.js";
import chalk from "chalk";
import { existsSync, promises } from "node:fs";
import { EOL } from "node:os";

import { Sentry } from "../telemetry.js";
import {
  makeCodeSnippet,
  showCopyPasteInstructions,
} from "../utils/clack/index.js";
import { type RNCliSetupConfigContent } from "./react-native-wizard.js";
import { traceStep } from "../telemetry.js";
import { isFolderInGitignore } from "./git.js";

export const SENTRY_EXPO_PLUGIN_NAME = "@sentry/react-native/expo";
export const DEPRECATED_SENTRY_EXPO_PLUGIN_NAME = "sentry-expo";

export const SENTRY_PLUGIN_FUNCTION_NAME = "withSentry";

const APP_CONFIG_JSON = `app.json`;

export interface AppConfigJson {
  expo?: {
    plugins?: Array<[string, undefined | Record<string, unknown>]>;
  };
}

export function printSentryExpoMigrationOutro(): void {
  clack.outro(
    `Deprecated ${chalk.cyan(
      "sentry-expo",
    )} package installed in your dependencies. Please follow the migration guide at ${chalk.cyan(
      "https://docs.sentry.io/platforms/react-native/migration/sentry-expo/",
    )}`,
  );
}

/**
 * Finds app.json in the project root and add Sentry Expo `withSentry` plugin.
 */
export async function patchExpoAppConfig(options: RNCliSetupConfigContent) {
  function showInstructions() {
    return showCopyPasteInstructions({
      filename: APP_CONFIG_JSON,
      codeSnippet: getSentryAppConfigJsonCodeSnippet(options),
      hint: "This ensures auto upload of source maps during native app build.",
    });
  }

  const appConfigJsonExists = existsSync(APP_CONFIG_JSON);

  Sentry.setTag(
    "app-config-file-status",
    appConfigJsonExists ? "found" : "not-found",
  );
  if (!appConfigJsonExists) {
    return await showInstructions();
  }

  const patched = await patchAppConfigJson(APP_CONFIG_JSON, options);
  if (!patched) {
    Sentry.setTag("app-config-file-status", "patch-error");
    clack.log.error(`Unable to patch ${chalk.cyan("app.config.json")}.`);
    return await showInstructions();
  }
}

async function patchAppConfigJson(
  path: string,
  options: RNCliSetupConfigContent,
): Promise<boolean> {
  const appConfigContent = (
    await promises.readFile(path, { encoding: "utf-8" })
  ).toString();
  const patchedContent = traceStep("app-config-json-patch", () =>
    addWithSentryToAppConfigJson(appConfigContent, options),
  );
  if (patchedContent === null) {
    return false;
  }

  try {
    await promises.writeFile(path, patchedContent);
  } catch (error) {
    Sentry.setTag("app-config-file-status", "json-write-error");
    clack.log.error(`Unable to write ${chalk.cyan("app.config.json")}.`);
    reportCliError(new Error(`Unable to write 'app.config.json'.`));
    return false;
  }
  Sentry.setTag("app-config-file-status", "json-write-success");
  clack.log.success(
    `Added Sentry Expo plugin to ${chalk.cyan("app.config.json")}.`,
  );
  return true;
}

export function addWithSentryToAppConfigJson(
  appConfigContent: string,
  options: RNCliSetupConfigContent,
): string | null {
  try {
    const parsedAppConfig: AppConfigJson = JSON.parse(appConfigContent);
    const includesWithSentry =
      appConfigContent.includes(SENTRY_EXPO_PLUGIN_NAME) ||
      appConfigContent.includes(DEPRECATED_SENTRY_EXPO_PLUGIN_NAME);

    if (includesWithSentry) {
      Sentry.setTag("app-config-file-status", "already-patched");
      clack.log.warn(
        `Your ${chalk.cyan(
          "app.config.json",
        )} already includes the Sentry Expo plugin.`,
      );
      return null;
    }

    if (
      parsedAppConfig.expo !== undefined &&
      !isPlainObject(parsedAppConfig.expo)
    ) {
      Sentry.setTag("app-config-file-status", "invalid-json");
      clack.log.error(
        `Unable to find expo in your ${chalk.cyan(
          "app.config.json",
        )}. Make sure it has a valid format!`,
      );
      return null;
    }
    if (
      parsedAppConfig.expo?.plugins !== undefined &&
      !Array.isArray(parsedAppConfig.expo.plugins)
    ) {
      Sentry.setTag("app-config-file-status", "invalid-json");
      clack.log.error(
        `Unable to find expo plugins in your ${chalk.cyan(
          "app.config.json",
        )}. Make sure it has a valid format!`,
      );
      return null;
    }

    parsedAppConfig.expo = parsedAppConfig.expo ?? {};
    parsedAppConfig.expo.plugins = parsedAppConfig.expo.plugins ?? [];
    parsedAppConfig.expo.plugins.push([
      SENTRY_EXPO_PLUGIN_NAME,
      {
        url: options.url,
        project: options.project,
        organization: options.org,
      },
    ]);

    return JSON.stringify(parsedAppConfig, null, 2) + EOL;
  } catch (error) {
    Sentry.setTag("app-config-file-status", "invalid-json");
    clack.log.error(
      `Unable to parse your ${chalk.cyan(
        "app.config.json",
      )}. Make sure it has a valid format!`,
    );
    reportCliError(new Error(`Error to parsing 'app.config.json'`));
    return null;
  }
}

export function getSentryAppConfigJsonCodeSnippet({
  url,
  project,
  org,
}: Omit<RNCliSetupConfigContent, "authToken">) {
  return makeCodeSnippet(true, (unchanged, plus, _minus) => {
    return unchanged(`{
  "name": "my app",
  "plugins": [
    ${plus(`[
      "@sentry/react-native/expo",
      {
        "url": "${url}",
        "project": "${project}",
        "organization": "${org}"
      }
    ]`)}
  ],
}`);
  });
}

/**
 * Checks whether the given value is a plain object (as opposed to something like a class instance or a primitive).
 * vendored from @sentry/utils to avoid registering the dependency.
 */
function isPlainObject(what: unknown): boolean {
  return Object.prototype.toString.call(what) === "[object Object]";
}

/**
 * Checks if the project is using Expo's Config Plugins (CNG)
 * It checks by checking if the native folders are in gitignore or not
 * If native folders are in gitignore then we can skip the native properties file step
 */
export const isExpoCNG = async (): Promise<boolean> => {
  const iOSExists = existsSync("ios");
  const androidExists = existsSync("android");

  const anyNativeFolderExists = iOSExists || androidExists;

  if (!anyNativeFolderExists) {
    // Definitely CNG and using prebuild steps
    return true;
  }

  try {
    const [isIosInGitIgnore, isAndroidInGitIgnore] = await Promise.all([
      iOSExists ? isFolderInGitignore("ios") : Promise.resolve(true), // If the folder doesn't exist, we can consider it as ignored
      androidExists ? isFolderInGitignore("android") : Promise.resolve(true),
    ]);

    return isIosInGitIgnore && isAndroidInGitIgnore;
  } catch (error) {
    // Without a readable .gitignore, assume the native folders are committed.
    debug(error);
    return false;
  }
};
