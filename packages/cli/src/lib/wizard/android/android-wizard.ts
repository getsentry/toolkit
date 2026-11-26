/**
 * The Android wizard: adds the Sentry Android Gradle plugin, configures the
 * SDK in `AndroidManifest.xml`, patches the main activity with a test error,
 * and writes `sentry.properties` for the plugin's ProGuard mapping upload.
 * Ported from sentry-wizard's `src/android`.
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { reportCliError } from "../../error-reporting.js";
import { Sentry, traceStep, withTelemetry } from "../telemetry.js";
import { abortIfSpotlightNotSupported } from "../utils/abort-if-sportlight-not-supported.js";
import {
  type CliSetupConfig,
  abort,
  abortIfCancelled,
  addSentryCliConfig,
  confirmContinueIfNoOrDirtyGitRepo,
  getOrAskForProjectData,
  printWelcome,
  propertiesCliSetupConfig,
} from "../utils/clack/index.js";
import { offerProjectScopedMcpConfig } from "../utils/clack/mcp-config.js";
import { clack } from "../utils/clack/prompts.js";
import { fixLineEndings } from "../utils/line-endings.js";
import type { WizardOptions } from "../utils/types.js";
import { findActivitySourceFile, patchMainActivity } from "./code-tools.js";
import { addGradlePlugin, getNamespace, selectAppFile } from "./gradle.js";
import { addManifestSnippet, getMainActivity } from "./manifest.js";

const proguardMappingCliSetupConfig: CliSetupConfig = {
  ...propertiesCliSetupConfig,
  name: "proguard mappings",
};

/** Run the Android wizard in its telemetry span. */
export async function runAndroidWizard(options: WizardOptions): Promise<void> {
  return await withTelemetry(
    {
      enabled: options.telemetryEnabled,
      integration: "android",
      wizardOptions: options,
    },
    () => runAndroidWizardWithTelemetry(options),
  );
}

async function runAndroidWizardWithTelemetry(
  options: WizardOptions,
): Promise<void> {
  printWelcome({
    wizardName: "Sentry Android Wizard",
  });

  await confirmContinueIfNoOrDirtyGitRepo({
    ignoreGitChanges: options.ignoreGitChanges,
    cwd: undefined,
  });

  const projectDir = process.cwd();
  const buildGradleFiles = findFilesWithExtensions(projectDir, [
    ".gradle",
    "gradle.kts",
  ]);

  if (buildGradleFiles.length === 0) {
    clack.log.error(
      "No Gradle project found. Please run this command from the root of your project.",
    );
    reportCliError(new Error("No Gradle project found"));
    return await abort();
  }

  const appFile = await traceStep("Select App File", () =>
    selectAppFile(buildGradleFiles),
  );

  const projectData = await getOrAskForProjectData(options, "android");

  if (projectData.spotlight) {
    return await abortIfSpotlightNotSupported("Android");
  }

  const { selectedProject, selfHosted, sentryUrl, authToken } = projectData;

  // Ask if user wants to enable Sentry Logs
  const enableLogs = await abortIfCancelled(
    clack.confirm({
      message:
        "Do you want to enable Logs? (See https://docs.sentry.io/platforms/android/logs/)",
    }),
  );
  Sentry.setTag("enable-logs", enableLogs);

  if (enableLogs) {
    clack.log.info(
      "Logs will be enabled with default settings. You can send logs using the Sentry.logger() APIs or use one of the integrations: https://docs.sentry.io/platforms/android/logs/#integrations.",
    );
  }

  // ======== STEP 1. Add Sentry Gradle Plugin to build.gradle(.kts) ============
  clack.log.step(
    `Adding ${chalk.bold("Sentry Gradle plugin")} to your app's ${chalk.cyan(
      "build.gradle",
    )} file.`,
  );
  const pluginAdded = await traceStep("Add Gradle Plugin", () =>
    addGradlePlugin(
      appFile,
      selectedProject.organization.slug,
      selectedProject.slug,
    ),
  );
  if (!pluginAdded) {
    clack.log.warn(
      "Could not add Sentry Gradle plugin to your app's build.gradle file. You'll have to add it manually.\nPlease follow the instructions at https://docs.sentry.io/platforms/android/#install",
    );
  }
  Sentry.setTag("gradle-plugin-added", pluginAdded);

  // ======== STEP 2. Configure Sentry SDK via AndroidManifest ============
  clack.log.step(
    `Configuring Sentry SDK via ${chalk.cyan("AndroidManifest.xml")}`,
  );
  const appDir = path.dirname(appFile);
  const manifestFile = path.join(appDir, "src", "main", "AndroidManifest.xml");

  const manifestUpdated = traceStep("Update Android Manifest", () =>
    addManifestSnippet(
      manifestFile,
      selectedProject.keys[0].dsn.public,
      enableLogs,
    ),
  );
  if (!manifestUpdated) {
    clack.log.warn(
      "Could not configure the Sentry SDK. You'll have to do it manually.\nPlease follow the instructions at https://docs.sentry.io/platforms/android/#configure",
    );
  }
  Sentry.setTag("android-manifest-updated", manifestUpdated);

  // ======== STEP 3. Patch Main Activity with a test error snippet ============
  clack.log.step(
    `Patching ${chalk.bold("Main Activity")} with a test error snippet.`,
  );
  const mainActivity = traceStep("Find Main Activity", () =>
    getMainActivity(manifestFile),
  );
  let packageName = mainActivity.packageName;
  if (!packageName) {
    // if no package name in AndroidManifest, look into gradle script
    packageName = getNamespace(appFile);
  }
  const activityName = mainActivity.activityName;
  Sentry.setTag("has-activity-name", !!activityName);
  Sentry.setTag("has-package-name", !!packageName);
  if (!activityName || !packageName) {
    clack.log.warn(
      "Could not find Activity with intent action MAIN. You'll have to manually verify the setup.\nPlease follow the instructions at https://docs.sentry.io/platforms/android/#verify",
    );
    reportCliError(new Error("Could not find Main Activity"));
  } else {
    const packageNameStable = packageName;
    const activityFile = traceStep("Find Main Activity Source File", () =>
      findActivitySourceFile(appDir, packageNameStable, activityName),
    );

    const activityPatched = traceStep("Patch Main Activity", () =>
      patchMainActivity(activityFile),
    );
    if (!activityPatched) {
      clack.log.warn(
        "Could not patch main activity. You'll have to manually verify the setup.\nPlease follow the instructions at https://docs.sentry.io/platforms/android/#verify",
      );
    }
    Sentry.setTag("main-activity-patched", activityPatched);
  }

  // ======== STEP 4. Add sentry.properties for the Gradle plugin ============
  clack.log.step(
    `Configuring ${chalk.bold("proguard mappings upload")} via the ${chalk.cyan(
      "sentry.properties",
    )} file.`,
  );

  await addSentryCliConfig({ authToken }, proguardMappingCliSetupConfig);

  // Offer optional project-scoped MCP config for Sentry with org and project scope
  await offerProjectScopedMcpConfig(
    selectedProject.organization.slug,
    selectedProject.slug,
  );

  // Fix mixed line endings caused by inserting LF content into CRLF files (Windows)
  fixLineEndings();

  // ======== OUTRO ========
  const issuesPageLink = selfHosted
    ? `${sentryUrl}organizations/${selectedProject.organization.slug}/issues/?project=${selectedProject.id}`
    : `https://${selectedProject.organization.slug}.sentry.io/issues/?project=${selectedProject.id}`;

  clack.outro(`
${chalk.greenBright("Successfully installed the Sentry Android SDK!")}

${chalk.cyan(
  `You can validate your setup by launching your application and checking Sentry issues page afterwards
${issuesPageLink}`,
)}

Check out the SDK documentation for further configuration:
https://docs.sentry.io/platforms/android/
  `);
}

//find files with the given extension
function findFilesWithExtensions(
  dir: string,
  extensions: string[],
  filesWithExtensions: string[] = [],
): string[] {
  const cwd = process.cwd();
  const files = readdirSync(dir, { withFileTypes: true });
  for (const file of files) {
    if (file.isDirectory()) {
      const childDir = path.join(dir, file.name);
      findFilesWithExtensions(childDir, extensions, filesWithExtensions);
    } else if (extensions.some((ext) => file.name.endsWith(ext))) {
      filesWithExtensions.push(path.relative(cwd, path.join(dir, file.name)));
    }
  }
  return filesWithExtensions;
}
