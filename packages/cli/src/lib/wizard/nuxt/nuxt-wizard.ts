/**
 * The Nuxt setup wizard: installs `@sentry/nuxt`, adds the Sentry Nuxt
 * module to the Nuxt config, writes the client and server SDK configs and
 * the auth token for source map uploads, and optionally creates an example
 * page or component.
 */

import chalk from "chalk";
import { lt, minVersion } from "semver";
import { Sentry, traceStep, withTelemetry } from "../telemetry.js";
import { abortIfSpotlightNotSupported } from "../utils/abort-if-sportlight-not-supported.js";
import {
  abort,
  abortIfCancelled,
  addDotEnvSentryBuildPluginFile,
  askShouldCreateExampleComponent,
  askShouldCreateExamplePage,
  confirmContinueIfNoOrDirtyGitRepo,
  ensurePackageIsInstalled,
  getOrAskForProjectData,
  getPackageDotJson,
  getPackageManager,
  installPackage,
  printSdkV11MigrationGuideIfOutdated,
  printWelcome,
  runPrettierIfInstalled,
} from "../utils/clack/index.js";
import { offerProjectScopedMcpConfig } from "../utils/clack/mcp-config.js";
import { clack } from "../utils/clack/prompts.js";
import {
  askShouldReduceDataCollection,
  sdkSupportsDataCollection,
} from "../utils/data-collection.js";
import { warnIfNodeVersionUnsupportedBySdkV11 } from "../utils/node-version.js";
import {
  getPackageVersion,
  hasPackageInstalled,
} from "../utils/package-json.js";
import type { WizardOptions } from "../utils/types.js";
import {
  createExampleComponent,
  createExamplePage,
  supportsExamplePage,
} from "./sdk-example.js";
import {
  addNuxtOverrides,
  addSDKModule,
  createConfigFiles,
  getNuxtConfig,
} from "./sdk-setup.js";
import { isNuxtV4 } from "./utils.js";

/** Run the Nuxt wizard (`sentry wizard -i nuxt`). */
export async function runNuxtWizard(options: WizardOptions): Promise<void> {
  return await withTelemetry(
    {
      enabled: options.telemetryEnabled,
      integration: "nuxt",
      wizardOptions: options,
    },
    () => runNuxtWizardWithTelemetry(options),
  );
}

async function runNuxtWizardWithTelemetry(
  options: WizardOptions,
): Promise<void> {
  const { telemetryEnabled, forceInstall } = options;

  printWelcome({
    wizardName: "Sentry Nuxt Wizard",
    telemetryEnabled,
  });

  warnIfNodeVersionUnsupportedBySdkV11();

  await confirmContinueIfNoOrDirtyGitRepo({
    ignoreGitChanges: options.ignoreGitChanges,
    cwd: undefined,
  });

  const packageJson = await getPackageDotJson();

  await ensurePackageIsInstalled(packageJson, "nuxt", "Nuxt");

  const nuxtVersion = getPackageVersion("nuxt", packageJson);
  Sentry.setTag("nuxt-version", nuxtVersion);

  const minVer = minVersion(nuxtVersion || "0.0.0");

  if (!nuxtVersion || !minVer || lt(minVer, "3.7.0")) {
    clack.log.warn(
      "It seems you're using a Nuxt version <3.7.0 which is not supported by Sentry.\nWe recommend upgrading to the latest version before you continue.",
    );
    const shouldContinue = await abortIfCancelled(
      clack.select({
        message: "Do you want to continue anyway?",
        options: [
          {
            label: "Yes, continue",
            hint: "The SDK might not work correctly",
            value: true,
          },
          { label: "No, I'll upgrade first", value: false },
        ],
      }),
    );
    if (!shouldContinue) {
      await abort("Exiting Wizard", 0);
      return;
    }
  }

  const projectDataResult = await getOrAskForProjectData(
    options,
    "javascript-nuxt",
  );

  if (projectDataResult.spotlight) {
    return await abortIfSpotlightNotSupported("Nuxt");
  }

  const { authToken, selectedProject, selfHosted, sentryUrl } =
    projectDataResult;

  const packageManager = await getPackageManager();

  await addNuxtOverrides(packageManager, minVer);

  const sdkAlreadyInstalled = hasPackageInstalled("@sentry/nuxt", packageJson);
  Sentry.setTag("sdk-already-installed", sdkAlreadyInstalled);

  printSdkV11MigrationGuideIfOutdated("@sentry/nuxt", packageJson);

  await installPackage({
    packageName: "@sentry/nuxt@^11",
    alreadyInstalled: sdkAlreadyInstalled,
    packageManager,
    forceInstall,
  });

  // The install may have been skipped (user declined the update prompt), so
  // re-read package.json to learn which SDK major is actually installed.
  const installedSdkVersion = getPackageVersion(
    "@sentry/nuxt",
    await getPackageDotJson(),
  );

  // From v11 on, the SDK collects rich context by default, so offer to
  // reduce collection of data that can identify users.
  const reduceDataCollection =
    sdkSupportsDataCollection(installedSdkVersion, "^10") &&
    (await askShouldReduceDataCollection());

  await addDotEnvSentryBuildPluginFile(authToken);

  const nuxtConfig = await traceStep("load-nuxt-config", getNuxtConfig);

  const projectData = {
    org: selectedProject.organization.slug,
    project: selectedProject.slug,
    projectId: selectedProject.id,
    url: sentryUrl,
    selfHosted,
  };

  await traceStep("configure-sdk", async () => {
    await addSDKModule(nuxtConfig, projectData);
    await createConfigFiles(
      selectedProject.keys[0].dsn.public,
      reduceDataCollection,
    );
  });

  let shouldCreateExamplePage = false;
  let shouldCreateExampleButton = false;

  const isV4 = await isNuxtV4(nuxtConfig, nuxtVersion);
  const canCreateExamplePage = await supportsExamplePage(isV4);
  Sentry.setTag("supports-example-page-creation", canCreateExamplePage);

  if (canCreateExamplePage) {
    shouldCreateExamplePage = await askShouldCreateExamplePage();

    if (shouldCreateExamplePage) {
      await traceStep(
        "create-example-page",
        async () => await createExamplePage(isV4, projectData),
      );
    }
  } else {
    shouldCreateExampleButton = await askShouldCreateExampleComponent();

    if (shouldCreateExampleButton) {
      await traceStep(
        "create-example-component",
        async () => await createExampleComponent(isV4),
      );
    }
  }

  await runPrettierIfInstalled({ cwd: undefined });

  // Offer optional project-scoped MCP config for Sentry with org and project scope
  await offerProjectScopedMcpConfig(
    selectedProject.organization.slug,
    selectedProject.slug,
  );

  clack.outro(
    buildOutroMessage(shouldCreateExamplePage, shouldCreateExampleButton),
  );
}

function buildOutroMessage(
  shouldCreateExamplePage: boolean,
  shouldCreateExampleButton: boolean,
): string {
  let msg = chalk.green("Successfully installed the Sentry Nuxt SDK!");

  if (shouldCreateExamplePage) {
    msg += `\n\nYou can validate your setup by visiting ${chalk.cyan(
      '"/sentry-example-page"',
    )}.`;
  }
  if (shouldCreateExampleButton) {
    msg += `\n\nYou can validate your setup by adding the ${chalk.cyan(
      "`SentryExampleButton`",
    )} component to a page and triggering it.`;
  }

  msg += `\n\nCheck out the SDK documentation for further configuration: ${chalk.underline(
    "https://docs.sentry.io/platforms/javascript/guides/nuxt/",
  )}`;

  return msg;
}
