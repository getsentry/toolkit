/**
 * The SvelteKit setup wizard: installs `@sentry/sveltekit`, sets up the
 * hooks and instrumentation files and the Vite plugin, and optionally adds
 * an example page.
 */

import { formatError } from "../../errors.js";
import { reportCliError } from "../../error-reporting.js";
import { clack } from "../utils/clack/prompts.js";
import chalk from "chalk";

import { Sentry } from "../telemetry.js";

import { traceStep, withTelemetry } from "../telemetry.js";
import {
  abort,
  abortIfCancelled,
  addDotEnvSentryBuildPluginFile,
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
import {
  askShouldReduceDataCollection,
  sdkSupportsDataCollection,
} from "../utils/data-collection.js";
import {
  getPackageVersion,
  hasPackageInstalled,
} from "../utils/package-json.js";
import { NPM } from "../utils/package-manager.js";
import type { WizardOptions } from "../utils/types.js";
import { offerProjectScopedMcpConfig } from "../utils/clack/mcp-config.js";
import { createExamplePage } from "./sdk-example.js";
import { createOrMergeSvelteKitFiles } from "./sdk-setup/setup.js";
import { loadSvelteConfig } from "./sdk-setup/svelte-config.js";
import {
  getKitVersionBucket,
  getSvelteVersionBucket,
  SENTRY_SVELTEKIT_SDK_RANGE,
  getSentrySvelteKitVitePluginImportPath,
} from "./utils.js";
import { abortIfSpotlightNotSupported } from "../utils/abort-if-sportlight-not-supported.js";
import { warnIfNodeVersionUnsupportedBySdkV11 } from "../utils/node-version.js";

export async function runSvelteKitWizard(
  options: WizardOptions,
): Promise<void> {
  return await withTelemetry(
    {
      enabled: options.telemetryEnabled,
      integration: "sveltekit",
      wizardOptions: options,
    },
    () => runSvelteKitWizardWithTelemetry(options),
  );
}

export async function runSvelteKitWizardWithTelemetry(
  options: WizardOptions,
): Promise<void> {
  const { telemetryEnabled, forceInstall } = options;

  printWelcome({
    wizardName: "Sentry SvelteKit Wizard",
    telemetryEnabled,
  });

  warnIfNodeVersionUnsupportedBySdkV11();

  await confirmContinueIfNoOrDirtyGitRepo({
    ignoreGitChanges: options.ignoreGitChanges,
    cwd: undefined,
  });

  const packageJson = await getPackageDotJson();

  await ensurePackageIsInstalled(packageJson, "@sveltejs/kit", "Sveltekit");

  const kitVersion = getPackageVersion("@sveltejs/kit", packageJson);
  const kitVersionBucket = getKitVersionBucket(kitVersion);
  Sentry.setTag("sveltekit-version", kitVersionBucket);

  if (kitVersionBucket === "0.x") {
    clack.log.warn(
      "It seems you're using a SvelteKit version <1.0.0 which is not supported by Sentry.\nWe recommend upgrading to the latest 1.x version before you continue.",
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

  let setupForSvelteKitTracing = kitVersionBucket === ">=2.31.0";

  if (kitVersionBucket !== ">=2.31.0") {
    clack.log.warn(
      `It seems you're using a SvelteKit version ${chalk.cyan(
        "<2.31.0",
      )} (detected ${chalk.cyan(kitVersion ?? "unknown")}).

We recommend upgrading SvelteKit to version ${chalk.cyan(
        ">=2.31.0",
      )} to use SvelteKit's builtin observability:
${chalk.cyan("https://svelte.dev/docs/kit/observability")}

Sentry works best with SvelteKit versions ${chalk.cyan(">=2.31.0")}.

If you prefer, you can stay on your current version and use the Sentry SDK
without SvelteKit's builtin observability.`,
    );

    const decision = await abortIfCancelled(
      clack.select({
        message: "Do you want to continue anyway?",
        options: [
          {
            label: "No, I'll upgrade SvelteKit first",
            hint: "Recommended",
            value: "exit-to-upgrade",
          },
          {
            label: "I'm already on SvelteKit >=2.31.0",
            hint: "Sorry, my bad!",
            value: "install-with-kit-tracing",
          },
          {
            label: "Yes, continue",
            hint: "No Problem!",
            value: "install-without-kit-tracing",
          },
        ],
      }),
    );

    if (decision === "install-with-kit-tracing") {
      setupForSvelteKitTracing = true;
    }

    if (decision === "exit-to-upgrade") {
      await abort("Exiting Wizard", 0);
      return;
    }
  }

  const svelteVersionBucket = getSvelteVersionBucket(
    getPackageVersion("svelte", packageJson),
  );
  Sentry.setTag("svelte-version", svelteVersionBucket);

  const projectData = await getOrAskForProjectData(
    options,
    "javascript-sveltekit",
  );

  if (projectData.spotlight) {
    return await abortIfSpotlightNotSupported("SvelteKit");
  }

  const { selectedProject, selfHosted, sentryUrl, authToken } = projectData;

  const sdkAlreadyInstalled = hasPackageInstalled(
    "@sentry/sveltekit",
    packageJson,
  );
  Sentry.setTag("sdk-already-installed", sdkAlreadyInstalled);

  printSdkV11MigrationGuideIfOutdated("@sentry/sveltekit", packageJson);

  await installPackage({
    packageName: `@sentry/sveltekit@${SENTRY_SVELTEKIT_SDK_RANGE}`,
    packageNameDisplayLabel: "@sentry/sveltekit",
    alreadyInstalled: sdkAlreadyInstalled,
    forceInstall,
  });

  // The install may have been skipped (user declined the update prompt), so
  // re-read package.json to learn which SDK major is actually installed.
  const installedSdkVersion = getPackageVersion(
    "@sentry/sveltekit",
    await getPackageDotJson(),
  );
  const vitePluginImportPath =
    getSentrySvelteKitVitePluginImportPath(installedSdkVersion);

  // From v11 on, the SDK collects rich context by default, so offer to
  // reduce collection of data that can identify users.
  const reduceDataCollection =
    sdkSupportsDataCollection(
      installedSdkVersion,
      SENTRY_SVELTEKIT_SDK_RANGE,
    ) && (await askShouldReduceDataCollection());

  await addDotEnvSentryBuildPluginFile(authToken);

  const svelteConfig = await traceStep("load-svelte-config", loadSvelteConfig);

  try {
    await traceStep("configure-sdk", () =>
      createOrMergeSvelteKitFiles(
        {
          dsn: selectedProject.keys[0].dsn.public,
          org: selectedProject.organization.slug,
          project: selectedProject.slug,
          selfHosted,
          url: sentryUrl,
          vitePluginImportPath,
          reduceDataCollection,
        },
        svelteConfig,
        setupForSvelteKitTracing,
      ),
    );
  } catch (e: unknown) {
    clack.log.error("Error while setting up the SvelteKit SDK:");
    clack.log.info(chalk.dim(formatError(e)));
    reportCliError(new Error("Error while setting up the SvelteKit SDK"));
    await abort("Exiting Wizard");
    return;
  }

  const shouldCreateExamplePage = await askShouldCreateExamplePage(
    "/sentry-example-page",
  );

  if (shouldCreateExamplePage) {
    try {
      await traceStep(
        "create-example-page",
        async () =>
          await createExamplePage(svelteConfig, {
            selfHosted,
            url: sentryUrl,
            orgSlug: selectedProject.organization.slug,
            projectId: selectedProject.id,
            isUsingSvelte5: ["5.x", ">5.x"].includes(svelteVersionBucket),
          }),
      );
    } catch (e: unknown) {
      clack.log.error("Error while creating an example page to test Sentry:");
      clack.log.info(chalk.dim(formatError(e)));
      reportCliError(
        new Error("Error while creating an example Svelte page to test Sentry"),
      );
      await abort("Exiting Wizard");
      return;
    }
  }

  await runPrettierIfInstalled({ cwd: undefined });

  // Offer optional project-scoped MCP config for Sentry with org and project scope
  await offerProjectScopedMcpConfig(
    selectedProject.organization.slug,
    selectedProject.slug,
  );

  clack.outro(await buildOutroMessage(shouldCreateExamplePage));
}

async function buildOutroMessage(
  shouldCreateExamplePage: boolean,
): Promise<string> {
  const packageManager = await getPackageManager(NPM);

  let msg = chalk.green("Successfully installed the Sentry SvelteKit SDK!");

  if (shouldCreateExamplePage) {
    msg += `\n\nYou can validate your setup by starting your dev environment (${chalk.cyan(
      `\`${packageManager.runScriptCommand} dev\``,
    )}) and visiting ${chalk.cyan('"/sentry-example-page"')}.`;
  }

  msg += `\n\nCheck out the SDK documentation for further configuration:
https://docs.sentry.io/platforms/javascript/guides/sveltekit/`;

  return msg;
}
