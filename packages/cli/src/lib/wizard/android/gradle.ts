/**
 * Gradle edits of the Android wizard: picks the app module, adds the Sentry
 * Android Gradle plugin and its `sentry {}` block, and reads the namespace.
 */

import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { abortIfCancelled, askForItemSelection } from "../utils/clack/index.js";
import {
  plugin,
  pluginKts,
  pluginsBlock,
  pluginsBlockKts,
  sourceContext,
  sourceContextKts,
} from "./templates.js";
import { execute } from "../utils/bash.js";
import { debug } from "../utils/debug.js";
import { Sentry } from "../telemetry.js";
import { clack } from "../utils/clack/prompts.js";
import chalk from "chalk";
import { fetchSdkVersion } from "../utils/release-registry.js";

/**
 * A Gradle project may contain multiple modules, some of them may be applications, some of them may be libraries.
 * We are only interested in applications. For example:
 *
 * myproject/
 *   app/
 *   lib1/
 *   lib2/
 *   wearApp/
 *
 * In this case^ we are interested in app/ and wearApp/
 *
 * @param buildGradleFiles a list of build.gradle(.kts) paths that contain the com.android.application plugin
 * @returns the selected project for setting up
 */
export async function selectAppFile(
  buildGradleFiles: string[],
): Promise<string> {
  const appFiles: string[] = [];
  for (const file of buildGradleFiles) {
    const text = readFileSync(file, "utf8");
    if (/\(?["']com\.android\.application["']\)?(?!.*\S)/.test(text)) {
      appFiles.push(file);
    }
  }

  if (appFiles.length === 0) {
    Sentry.setTag("custom-build-logic", true);
    const appFile = await abortIfCancelled(
      clack.text({
        message: `Unable to find your app's directory. 
        Please enter the relative path to your app's build.gradle file from the root project`,
        placeholder: "app/build.gradle.kts",
        validate(value) {
          if (!value.includes(".gradle") || !existsSync(value)) {
            return `Not a valid gradle file.`;
          }
          return undefined;
        },
      }),
    );
    return appFile;
  }

  let appFile: string;
  const [onlyAppFile] = appFiles;
  if (appFiles.length === 1 && onlyAppFile) {
    Sentry.setTag("multiple-projects", false);
    appFile = onlyAppFile;
  } else {
    Sentry.setTag("multiple-projects", true);
    appFile = (
      await askForItemSelection(
        appFiles,
        "Which project do you want to add Sentry to?",
      )
    ).value;
  }
  Sentry.setTag("custom-build-logic", false);
  return appFile;
}

/**
 * Patches a build.gradle(.kts) file that contains `com.android.application` plugin.
 * There are multiple cases we have to handle here:
 *   - An existing `plugins {}` block:
 *     - We just have to add our plugin inside the block
 *   - No existing `plugins {}` block
 *     - We have to add the entire block in the beginning of the file, BUT *after imports*
 *
 * For example (2nd case):
 *
 * ```
 * import net.ltgt.gradle.errorprone.errorprone
 *
 * // our plugins block goes here <--
 * plugins {
 *   id("io.sentry.android.gradle") version "3.12.0"
 * }
 *
 * apply(plugin = "com.android.application")
 *
 * android {
 *   ...
 * }
 * ```
 *
 * In the end we run `./gradlew` to verify the config is build-able and not broken.
 *
 * @param appFile the selected Gradle application project
 * @returns true if successfully added Sentry Gradle config, false otherwise
 */
export async function addGradlePlugin(
  appFile: string,
  orgSlug: string,
  projectSlug: string,
): Promise<boolean> {
  const gradleScript = readFileSync(appFile, "utf8");

  if (/\(?["']io\.sentry\.android\.gradle["']\)?/.test(gradleScript)) {
    // sentry gradle plugin is already installed
    clack.log.success(
      chalk.greenBright(
        `${chalk.bold(
          "Sentry Gradle plugin",
        )} is already added to the project.`,
      ),
    );
    maybeAddSourceContextConfig(appFile, gradleScript, orgSlug, projectSlug);
    return true;
  }

  const pluginVersion = await fetchSdkVersion(
    "sentry.java.android.gradle-plugin",
  );
  const pluginsBlockMatch = /plugins\s*{[^{}]*}/.exec(gradleScript);
  let newGradleScript;
  if (!pluginsBlockMatch) {
    // no "plugins {}" block, we can just add our own after imports
    const regex = /import\s+[\w.]+/gm;
    let importsMatch = regex.exec(gradleScript);
    let insertIndex = 0;
    while (importsMatch) {
      insertIndex = importsMatch.index + importsMatch[0].length + 1;
      importsMatch = regex.exec(gradleScript);
    }

    if (appFile.endsWith(".kts")) {
      newGradleScript =
        gradleScript.slice(0, insertIndex) +
        pluginsBlockKts(pluginVersion) +
        gradleScript.slice(insertIndex);
    } else {
      newGradleScript =
        gradleScript.slice(0, insertIndex) +
        pluginsBlock(pluginVersion) +
        gradleScript.slice(insertIndex);
    }
  } else {
    const insertIndex =
      pluginsBlockMatch.index + pluginsBlockMatch[0].length - 1;
    if (appFile.endsWith(".kts")) {
      newGradleScript =
        gradleScript.slice(0, insertIndex) +
        pluginKts(pluginVersion) +
        gradleScript.slice(insertIndex);
    } else {
      newGradleScript =
        gradleScript.slice(0, insertIndex) +
        plugin(pluginVersion) +
        gradleScript.slice(insertIndex);
    }
  }
  writeFileSync(appFile, newGradleScript, "utf8");

  maybeAddSourceContextConfig(appFile, newGradleScript, orgSlug, projectSlug);

  const buildSpinner = clack.spinner();
  // cmd.exe can't run `./gradlew`; the Windows wrapper is gradlew.bat.
  const gradlew = process.platform === "win32" ? "gradlew.bat" : "./gradlew";

  buildSpinner.start(
    `Running ${gradlew} to verify changes (this may take a few minutes)...`,
  );

  try {
    await execute(gradlew);
    buildSpinner.stop(
      chalk.greenBright(
        `${chalk.bold("Sentry Gradle plugin")} added to the project.`,
      ),
    );
  } catch (error) {
    // A failed sync is a problem with the user's build: the caller stops
    // the wizard with a message instead of reporting it.
    debug(error);
    buildSpinner.stop(`${gradlew} failed.`);
    return false;
  }

  return true;
}

/**
 * Looks for the applications packageName (namespace) in the specified build.gradle(.kts) file.
 *
 * ```
 * android {
 *   namespace 'my.package.name' <-- this is what we extract
 *
 *   compileSdkVersion = 31
 *   ...
 * }
 * ```
 * @param appFile
 * @returns the packageName(namespace) of the app if available
 */
export function getNamespace(appFile: string): string | undefined {
  const gradleScript = readFileSync(appFile, "utf8");

  const namespaceMatch = /namespace\s*=?\s*['"]([^'"]+)['"]/i.exec(
    gradleScript,
  );
  if (!namespaceMatch || namespaceMatch.length <= 1) {
    clack.log.warn("Unable to determine application package name.");
    return undefined;
  }

  const namespace = namespaceMatch[1];
  return namespace;
}

/**
 * Adds source context configuration to the gradleScript if `sentry {}` block is not yet configured,
 *
 * @param appFile
 * @param gradleScript
 */
function maybeAddSourceContextConfig(
  appFile: string,
  gradleScript: string,
  orgSlug: string,
  projectSlug: string,
) {
  if (!/sentry\s*\{[^}]*\}/i.test(gradleScript)) {
    // if no sentry {} block is configured, we add our own with source context enabled
    if (appFile.endsWith(".kts")) {
      appendFileSync(appFile, sourceContextKts(orgSlug, projectSlug), "utf8");
    } else {
      appendFileSync(appFile, sourceContext(orgSlug, projectSlug), "utf8");
    }
  }
}
