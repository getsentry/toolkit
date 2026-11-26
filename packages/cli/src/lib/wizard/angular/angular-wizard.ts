/**
 * The Angular setup wizard: installs `@sentry/angular`, initializes it in
 * `src/main.ts`, adds the Sentry providers to the app config, turns on
 * source maps in `angular.json`, sets up their upload with `sentry
 * sourcemap` commands, and optionally creates an example component.
 */

import path from "node:path";
import chalk from "chalk";
import { gte, minVersion } from "semver";
import { setupCI } from "../sourcemaps/ci.js";
import { configureAngularSourcemapGenerationFlow } from "../sourcemaps/tools/angular.js";
import { configureSentryCLI } from "../sourcemaps/tools/sentry-cli.js";
import { Sentry, traceStep, withTelemetry } from "../telemetry.js";
import { abortIfSpotlightNotSupported } from "../utils/abort-if-sportlight-not-supported.js";
import {
  abort,
  abortIfCancelled,
  askShouldCreateExampleComponent,
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
import { addSourcemapEntryToAngularJSON } from "./codemods/sourcemaps.js";
import { createExampleComponent } from "./example-component.js";
import {
  initializeSentryOnApplicationEntry,
  updateAppConfig,
} from "./sdk-setup.js";

const MIN_SUPPORTED_ANGULAR_VERSION = "14.0.0";
const MIN_SUPPORTED_WIZARD_ANGULAR_VERSION = "17.0.0";

/** Run the Angular wizard (`sentry wizard -i angular`). */
export async function runAngularWizard(options: WizardOptions): Promise<void> {
  return await withTelemetry(
    {
      enabled: options.telemetryEnabled,
      integration: "angular",
      wizardOptions: options,
    },
    () => runAngularWizardWithTelemetry(options),
  );
}

async function runAngularWizardWithTelemetry(
  options: WizardOptions,
): Promise<void> {
  printWelcome({
    wizardName: "Sentry Angular Wizard",
    telemetryEnabled: options.telemetryEnabled,
  });

  warnIfNodeVersionUnsupportedBySdkV11();

  await confirmContinueIfNoOrDirtyGitRepo({
    ignoreGitChanges: options.ignoreGitChanges,
    cwd: undefined,
  });

  const packageJson = await getPackageDotJson();

  await ensurePackageIsInstalled(packageJson, "@angular/core", "Angular");

  let installedAngularVersion = getPackageVersion("@angular/core", packageJson);

  if (!installedAngularVersion) {
    clack.log.warn("Could not determine installed Angular version.");

    installedAngularVersion = await abortIfCancelled(
      clack.text({
        message: `Please enter your installed Angular major version (e.g. ${chalk.cyan(
          "18",
        )} for Angular 18)`,
        validate(value) {
          if (!value) {
            return "Angular version is required";
          }

          try {
            if (!minVersion(value)) {
              return `Invalid Angular version provided: ${value}`;
            }
          } catch (error) {
            // Not fatal: an unparsable version is reported as invalid input.
            debug(error);
            return `Invalid Angular version provided: ${value}`;
          }
          return undefined;
        },
      }),
    );
  }

  Sentry.setTag("angular-version", installedAngularVersion);

  const installedMinVersion = minVersion(installedAngularVersion);
  if (!installedMinVersion) {
    clack.log.warn(
      `Could not parse the Angular version ${chalk.cyan(installedAngularVersion)}.`,
    );
    return await abort("Exiting the wizard.");
  }

  const sdkSupportsAngularVersion = gte(
    installedMinVersion,
    MIN_SUPPORTED_ANGULAR_VERSION,
  );

  const wizardSupportsAngularVersion = gte(
    installedMinVersion,
    MIN_SUPPORTED_WIZARD_ANGULAR_VERSION,
  );

  if (!sdkSupportsAngularVersion) {
    Sentry.setTag("angular-version-compatible", false);

    clack.log.warn(
      `Angular version ${chalk.cyan(
        MIN_SUPPORTED_ANGULAR_VERSION,
      )} or higher is required for the Sentry SDK.`,
    );
    clack.log.warn(
      `Please refer to Sentry's version compatibility table for more information:

${chalk.underline(
  "https://docs.sentry.io/platforms/javascript/guides/angular/#angular-version-compatibility",
)}
`,
    );

    return await abort("Exiting the wizard.", 0);
  }

  if (!wizardSupportsAngularVersion) {
    Sentry.setTag("angular-wizard-version-compatible", false);

    clack.log.warn(
      `The Sentry Angular Wizard requires Angular version ${chalk.cyan(
        MIN_SUPPORTED_WIZARD_ANGULAR_VERSION,
      )} or higher.`,
    );
    clack.log.warn(
      `Your Angular version (${installedAngularVersion}) is compatible with the Sentry SDK but you need to set it up manually by following our documentation:

${chalk.underline("https://docs.sentry.io/platforms/javascript/guides/angular")}

Apologies for the inconvenience!`,
    );

    return await abort("Exiting the wizard.", 0);
  }

  const projectData = await getOrAskForProjectData(
    options,
    "javascript-angular",
  );

  if (projectData.spotlight) {
    return await abortIfSpotlightNotSupported("Angular");
  }

  const { selectedProject, authToken, sentryUrl, selfHosted } = projectData;

  const dsn = selectedProject.keys[0].dsn.public;

  const sdkAlreadyInstalled = hasPackageInstalled(
    "@sentry/angular",
    packageJson,
  );

  Sentry.setTag("sdk-already-installed", sdkAlreadyInstalled);

  printSdkV11MigrationGuideIfOutdated("@sentry/angular", packageJson);

  await installPackage({
    packageName: "@sentry/angular@^11",
    packageNameDisplayLabel: "@sentry/angular",
    alreadyInstalled: sdkAlreadyInstalled,
  });

  // The install may have been skipped (user declined the update prompt), so
  // re-read package.json to learn which SDK major is actually installed.
  const installedSdkVersion = getPackageVersion(
    "@sentry/angular",
    await getPackageDotJson(),
  );

  // From v11 on, the SDK collects rich context by default, so offer to
  // reduce collection of data that can identify users.
  const reduceDataCollection =
    sdkSupportsDataCollection(installedSdkVersion, "^10") &&
    (await askShouldReduceDataCollection());

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

  await traceStep(
    "Initialize Sentry on Angular application entry point",
    async () => {
      await initializeSentryOnApplicationEntry(
        dsn,
        selectedFeatures,
        reduceDataCollection,
      );
    },
  );

  await traceStep("Update Angular project configuration", async () => {
    await updateAppConfig(installedMinVersion, selectedFeatures.performance);
  });

  await traceStep("Setup for sourcemap uploads", async () => {
    await addSourcemapEntryToAngularJSON();

    // sentry-wizard ran its source maps wizard with the Angular tool
    // preselected here. Its other steps (redirect to a framework wizard, SDK
    // version check, project selection) are already done by this point, so
    // run the Angular tool setup and the CI step directly.
    await configureSentryCLI(
      {
        orgSlug: selectedProject.organization.slug,
        projectSlug: selectedProject.slug,
        selfHosted,
        url: sentryUrl,
        authToken,
        defaultArtifactPath: `.${path.sep}dist`,
      },
      configureAngularSourcemapGenerationFlow,
      true,
    );

    await setupCI("angular", authToken, {
      org: selectedProject.organization.slug,
      project: selectedProject.slug,
      url: selfHosted ? sentryUrl : undefined,
    });
  });

  const shouldCreateExampleComponent = await askShouldCreateExampleComponent();

  Sentry.setTag("create-example-component", shouldCreateExampleComponent);

  if (shouldCreateExampleComponent) {
    await traceStep(
      "create-example-component",
      async () =>
        await createExampleComponent({
          url: sentryUrl,
          orgSlug: selectedProject.organization.slug,
          projectId: selectedProject.id,
        }),
    );
  }

  await traceStep("Run Prettier", async () => {
    await runPrettierIfInstalled({ cwd: undefined });
  });

  // Offer optional project-scoped MCP config for Sentry with org and project scope
  await offerProjectScopedMcpConfig(
    selectedProject.organization.slug,
    selectedProject.slug,
  );

  clack.outro(buildOutroMessage(shouldCreateExampleComponent));
}

/** The closing message, with how to test the example component if one was created. */
export function buildOutroMessage(createdExampleComponent: boolean): string {
  let msg = chalk.green("Successfully installed the Sentry Angular SDK!");

  if (createdExampleComponent) {
    msg += `\n\nYou can validate your setup by starting your dev environment (${chalk.cyan(
      "ng serve",
    )}) and throwing an error in the example component.`;
  }

  msg += `\n\nCheck out the SDK documentation for further configuration:
https://docs.sentry.io/platforms/javascript/guides/angular/`;

  return msg;
}
