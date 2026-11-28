/**
 * The Cloudflare Workers setup wizard: installs `@sentry/cloudflare`, wraps
 * the worker with `Sentry.withSentry()`, and adds the compatibility flags
 * and version metadata binding the SDK needs to the Wrangler config.
 */

import chalk from "chalk";

import { traceStep, withTelemetry } from "../telemetry.js";
import { abortIfSpotlightNotSupported } from "../utils/abort-if-sportlight-not-supported.js";
import {
  confirmContinueIfNoOrDirtyGitRepo,
  ensurePackageIsInstalled,
  featureSelectionPrompt,
  getOrAskForProjectData,
  getPackageDotJson,
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
import { debug } from "../utils/debug.js";
import { warnIfNodeVersionUnsupportedBySdkV11 } from "../utils/node-version.js";
import {
  getPackageVersion,
  hasPackageInstalled,
} from "../utils/package-json.js";
import type { WizardOptions } from "../utils/types.js";
import { createSentryInitFile } from "./sdk-setup.js";
import { ensureWranglerConfig } from "./wrangler/ensure-wrangler-config.js";
import {
  defaultEntryPoint,
  getEntryPointFromWranglerConfig,
} from "./wrangler/get-entry-point-from-wrangler-config.js";
import { updateWranglerConfig } from "./wrangler/update-wrangler-config.js";

/** The `@sentry/cloudflare` range the wizard installs. */
const SDK_INSTALL_RANGE = "^11";

/** Run the Cloudflare wizard (`sentry wizard -i cloudflare`). */
export async function runCloudflareWizard(
  options: WizardOptions,
): Promise<void> {
  return await withTelemetry(
    {
      enabled: options.telemetryEnabled,
      integration: "cloudflare",
      wizardOptions: options,
    },
    () => runCloudflareWizardWithTelemetry(options),
  );
}

async function runCloudflareWizardWithTelemetry(
  options: WizardOptions,
): Promise<void> {
  const { telemetryEnabled, forceInstall } = options;

  printWelcome({
    wizardName: "Sentry Cloudflare Wizard",
    telemetryEnabled,
  });

  warnIfNodeVersionUnsupportedBySdkV11();

  await confirmContinueIfNoOrDirtyGitRepo({
    ignoreGitChanges: options.ignoreGitChanges,
    cwd: undefined,
  });

  const packageJson = await getPackageDotJson();

  await ensurePackageIsInstalled(packageJson, "wrangler", "Cloudflare");

  traceStep("Ensure Wrangler config", () => {
    ensureWranglerConfig();
  });

  const projectData = await getOrAskForProjectData(
    options,
    "node-cloudflare-workers",
  );

  if (projectData.spotlight) {
    return await abortIfSpotlightNotSupported("Cloudflare");
  }

  const { selectedProject } = projectData;

  printSdkV11MigrationGuideIfOutdated("@sentry/cloudflare", packageJson);

  await installPackage({
    packageName: `@sentry/cloudflare@${SDK_INSTALL_RANGE}`,
    packageNameDisplayLabel: "@sentry/cloudflare",
    alreadyInstalled: hasPackageInstalled("@sentry/cloudflare", packageJson),
    forceInstall,
  });

  // The install may have been skipped (user declined the update prompt), so
  // re-read package.json to learn which SDK major is actually installed.
  const installedSdkVersion = getPackageVersion(
    "@sentry/cloudflare",
    await getPackageDotJson(),
  );

  const selectedFeatures = await featureSelectionPrompt([
    {
      id: "performance",
      prompt: `Do you want to enable ${chalk.bold(
        "Tracing",
      )} to track the performance of your application?`,
      enabledHint: "recommended",
    },
  ] as const);

  // From v11 on, the SDK collects rich context by default, so offer to
  // reduce collection of data that can identify users.
  const reduceDataCollection =
    sdkSupportsDataCollection(installedSdkVersion, SDK_INSTALL_RANGE) &&
    (await askShouldReduceDataCollection());

  await traceStep("Create Sentry initialization", async () => {
    try {
      await createSentryInitFile(
        selectedProject.keys[0].dsn.public,
        selectedFeatures,
        reduceDataCollection,
      );
    } catch (e) {
      clack.log.warn(
        "Could not automatically set up Sentry initialization. Please set it up manually using instructions from https://docs.sentry.io/platforms/javascript/guides/cloudflare/",
      );
      debug(e);
    }
  });

  const mainFile = getEntryPointFromWranglerConfig();

  await traceStep("Update Wrangler config with Sentry requirements", () =>
    updateWranglerConfig(
      {
        ...(mainFile ? {} : { main: defaultEntryPoint }),
        // The SDK needs Node.js compatibility. `nodejs_compat` is a superset of
        // the `nodejs_als` flag older setups used, and the only one SDK v11 accepts.
        compatibility_flags: ["nodejs_compat"],
        compatibility_date: new Date().toISOString().slice(0, 10),
        version_metadata: {
          binding: "CF_VERSION_METADATA",
        },
      },
      {
        removeCompatibilityFlags: ["nodejs_als"],
        keepCompatibilityDate: true,
      },
    ),
  );

  await runPrettierIfInstalled({ cwd: undefined });

  // Offer optional project-scoped MCP config for Sentry with org and project scope
  await offerProjectScopedMcpConfig(
    selectedProject.organization.slug,
    selectedProject.slug,
  );

  clack.outro(buildOutroMessage());
}

/** The closing message, with the next steps. */
function buildOutroMessage(): string {
  return `
  ${chalk.green(
    "Sentry has been successfully configured for your Cloudflare project.",
  )}

  ${chalk.dim("Next steps:")}
  ${chalk.dim("1. Wrap your worker with Sentry as instructed above")}
  ${chalk.dim("2. Deploy your application with:")} ${chalk.cyan(
    "wrangler deploy",
  )}
  ${chalk.dim("3. Trigger an error to test Sentry integration")}

  ${chalk.cyan(
    `To learn more about using Sentry with Cloudflare, visit:
  https://docs.sentry.io/platforms/javascript/guides/cloudflare/`,
  )}
  `;
}
