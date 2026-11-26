/**
 * The Remix (v2) setup wizard: installs `@sentry/remix`, instruments the
 * client and server entries and the root route, writes the server
 * instrumentation file, and sets up source map uploads.
 */

import { clack } from "../utils/clack/prompts.js";
import chalk from "chalk";
import path from "node:path";

import { traceStep, withTelemetry } from "../telemetry.js";
import { findFile } from "../utils/ast-utils.js";
import {
  addDotEnvSentryBuildPluginFile,
  addSentryCliConfig,
  askShouldCreateExamplePage,
  type CliSetupConfig,
  confirmContinueIfNoOrDirtyGitRepo,
  ensurePackageIsInstalled,
  featureSelectionPrompt,
  getOrAskForProjectData,
  getPackageDotJson,
  installPackage,
  printSdkV11MigrationGuideIfOutdated,
  isUsingTypeScript,
  printWelcome,
  rcCliSetupConfig,
  runPrettierIfInstalled,
} from "../utils/clack/index.js";
import {
  askShouldReduceDataCollection,
  sdkSupportsDataCollection,
} from "../utils/data-collection.js";
import { debug } from "../utils/debug.js";
import {
  getPackageVersion,
  hasPackageInstalled,
} from "../utils/package-json.js";
import type { WizardOptions } from "../utils/types.js";
import { offerProjectScopedMcpConfig } from "../utils/clack/mcp-config.js";
import { createExamplePage } from "./sdk-example.js";
import {
  createServerInstrumentationFile,
  initializeSentryOnEntryClient,
  insertServerInstrumentationFile,
  instrumentRootRoute,
  instrumentSentryOnEntryServer,
  isRemixV2,
  runRemixReveal,
  updateBuildScript,
  updateStartScript,
} from "./sdk-setup.js";
import { isHydrogenApp } from "./utils.js";
import { abortIfSpotlightNotSupported } from "../utils/abort-if-sportlight-not-supported.js";
import { warnIfNodeVersionUnsupportedBySdkV11 } from "../utils/node-version.js";

/**
 * `.sentryclirc` with `[defaults] url` as well, so `sentry sourcemap upload`
 * in the build script reaches a self-hosted Sentry.
 */
const sentryCliRcWithUrl: CliSetupConfig = {
  ...rcCliSetupConfig,
  likelyAlreadyHasUrl: (contents) => /^\s*url\s*=./m.test(contents),
  urlContent: (url) => `[defaults]\nurl=${url}`,
};

export async function runRemixWizard(options: WizardOptions): Promise<void> {
  return await withTelemetry(
    {
      enabled: options.telemetryEnabled,
      integration: "remix",
      wizardOptions: options,
    },
    () => runRemixWizardWithTelemetry(options),
  );
}

async function runRemixWizardWithTelemetry(
  options: WizardOptions,
): Promise<void> {
  const { telemetryEnabled, forceInstall } = options;

  printWelcome({
    wizardName: "Sentry Remix Wizard",
    telemetryEnabled,
  });

  const packageJson = await getPackageDotJson();

  if (!isRemixV2(packageJson)) {
    clack.log.error(
      `Sentry only supports Remix v2 and above. Please upgrade your Remix version to use Sentry.`,
    );
    return;
  }

  warnIfNodeVersionUnsupportedBySdkV11();

  await confirmContinueIfNoOrDirtyGitRepo({
    ignoreGitChanges: options.ignoreGitChanges,
    cwd: undefined,
  });

  // We expect `@remix-run/dev` to be installed for every Remix project
  await ensurePackageIsInstalled(packageJson, "@remix-run/dev", "Remix");

  const projectData = await getOrAskForProjectData(options, "javascript-remix");

  if (projectData.spotlight) {
    return await abortIfSpotlightNotSupported("Remix");
  }

  const { selectedProject, authToken, sentryUrl, selfHosted } = projectData;

  printSdkV11MigrationGuideIfOutdated("@sentry/remix", packageJson);

  await installPackage({
    packageName: "@sentry/remix@^11",
    packageNameDisplayLabel: "@sentry/remix",
    alreadyInstalled: hasPackageInstalled("@sentry/remix", packageJson),
    forceInstall,
  });

  // The install may have been skipped (user declined the update prompt), so
  // re-read package.json to learn which SDK major is actually installed.
  const installedSdkVersion = getPackageVersion(
    "@sentry/remix",
    await getPackageDotJson(),
  );

  // From v11 on, the SDK collects rich context by default, so offer to
  // reduce collection of data that can identify users.
  const reduceDataCollection =
    sdkSupportsDataCollection(installedSdkVersion, "^10") &&
    (await askShouldReduceDataCollection());

  const dsn = selectedProject.keys[0].dsn.public;

  const isTS = isUsingTypeScript();
  const viteConfig = findFile("vite.config");
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

  if (viteConfig) {
    // The source maps wizard's Vite setup isn't in the CLI yet, so point at
    // the manual steps and write the auth token the plugin reads.
    await traceStep(
      "Update vite configuration for sourcemap uploads",
      async () => {
        clack.log.info(
          `To upload source maps, add the Sentry Vite plugin to your ${chalk.cyan(
            path.basename(viteConfig),
          )} using the instructions at https://docs.sentry.io/platforms/javascript/guides/remix/sourcemaps/`,
        );
        await addDotEnvSentryBuildPluginFile(authToken);
      },
    );
  } else {
    await traceStep("Update build script for sourcemap uploads", async () => {
      try {
        // The build script runs the project's own `sentry` CLI, so CI
        // can run it too.
        await installPackage({
          packageName: "sentry",
          alreadyInstalled: hasPackageInstalled("sentry", packageJson),
          devDependency: true,
          forceInstall,
        });

        await updateBuildScript({ isHydrogen: isHydrogenApp(packageJson) });

        await addSentryCliConfig(
          {
            authToken,
            org: selectedProject.organization.slug,
            project: selectedProject.slug,
            url: selfHosted ? sentryUrl : undefined,
          },
          sentryCliRcWithUrl,
        );
        clack.log.info(
          `${chalk.cyan(".sentryclirc")} stays out of git. In CI, set ${chalk.cyan(
            "SENTRY_AUTH_TOKEN",
          )}, ${chalk.cyan("SENTRY_ORG")} and ${chalk.cyan(
            "SENTRY_PROJECT",
          )} for the upload.`,
        );
      } catch (e) {
        clack.log
          .warn(`Could not update build script to generate and upload sourcemaps.
  Please update your build script manually using instructions from https://docs.sentry.io/platforms/javascript/guides/remix/sourcemaps/`);
        debug(e);
      }
    });
  }

  await traceStep("Instrument root route", async () => {
    try {
      await instrumentRootRoute(isTS);
    } catch (e) {
      clack.log.warn(`Could not instrument root route.
  Please do it manually using instructions from https://docs.sentry.io/platforms/javascript/guides/remix/manual-setup/`);
      debug(e);
    }
  });

  traceStep("Reveal missing entry files", () => {
    try {
      runRemixReveal(isTS);
    } catch (e) {
      clack.log.warn(`Could not run 'npx remix reveal'.
  Please create your entry files manually`);
      debug(e);
    }
  });

  await traceStep("Initialize Sentry on client entry", async () => {
    try {
      await initializeSentryOnEntryClient(
        dsn,
        isTS,
        selectedFeatures,
        reduceDataCollection,
      );
    } catch (e) {
      clack.log.warn(`Could not initialize Sentry on client entry.
  Please do it manually using instructions from https://docs.sentry.io/platforms/javascript/guides/remix/manual-setup/`);
      debug(e);
    }
  });

  let instrumentationFile = "" as string;

  await traceStep("Create server instrumentation file", async () => {
    try {
      instrumentationFile = await createServerInstrumentationFile(
        dsn,
        selectedFeatures,
        reduceDataCollection,
      );
    } catch (e) {
      clack.log.warn(
        "Could not create a server instrumentation file. Please do it manually using instructions from https://docs.sentry.io/platforms/javascript/guides/remix/manual-setup/",
      );
      debug(e);
    }
  });

  let serverFileInstrumented = false as boolean;

  await traceStep(
    "Create server instrumentation file and import it",
    async () => {
      try {
        serverFileInstrumented = await insertServerInstrumentationFile(
          dsn,
          selectedFeatures,
          reduceDataCollection,
        );
      } catch (e) {
        clack.log.warn(
          "Could not create a server instrumentation file. Please do it manually using instructions from https://docs.sentry.io/platforms/javascript/guides/remix/manual-setup/",
        );
        debug(e);
      }
    },
  );

  if (!serverFileInstrumented && instrumentationFile) {
    await traceStep(
      "Update `start` script to import instrumentation file.",
      async () => {
        try {
          await updateStartScript(instrumentationFile);
        } catch (e) {
          clack.log
            .warn(`Could not automatically add Sentry initialization to server entry.
    Please do it manually using instructions from https://docs.sentry.io/platforms/javascript/guides/remix/manual-setup/`);
          debug(e);
        }
      },
    );
  }

  await traceStep("Instrument server `handleError`", async () => {
    try {
      await instrumentSentryOnEntryServer(isTS);
    } catch (e) {
      clack.log.warn(`Could not initialize Sentry on server entry.
  Please do it manually using instructions from https://docs.sentry.io/platforms/javascript/guides/remix/manual-setup/`);
      debug(e);
    }
  });

  const shouldCreateExamplePage = await askShouldCreateExamplePage();

  if (shouldCreateExamplePage) {
    await traceStep("Create example page", async () => {
      await createExamplePage({
        isTS,
        selfHosted,
        orgSlug: selectedProject.organization.slug,
        projectId: selectedProject.id,
        url: sentryUrl,
      });
    });
  }

  await runPrettierIfInstalled({ cwd: undefined });

  // Offer optional project-scoped MCP config for Sentry with org and project scope
  await offerProjectScopedMcpConfig(
    selectedProject.organization.slug,
    selectedProject.slug,
  );

  clack.outro(`
${chalk.green(
  "Sentry has been successfully configured for your Remix project.",
)}

${chalk.cyan("You can now deploy your project to see Sentry in action.")}

${chalk.cyan(
  `To learn more about how to use Sentry with Remix, visit our documentation:
https://docs.sentry.io/platforms/javascript/guides/remix/`,
)}`);
}

/**
 * Offers to add a project-scoped MCP server configuration for the Sentry MCP.
 * Supports Cursor, VS Code, and Claude Code.
 */
