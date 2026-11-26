/**
 * The iOS wizard (`sentry wizard ios`): adds the Sentry Cocoa SDK through
 * Swift Package Manager, a debug-symbol upload build phase, the SDK init
 * snippet, and an optional Fastlane upload step to an Xcode project.
 */

import { clack } from "../utils/clack/prompts.js";
import chalk from "chalk";

import { withTelemetry } from "../telemetry.js";
import {
  confirmContinueIfNoOrDirtyGitRepo,
  featureSelectionPrompt,
  getOrAskForProjectData,
  printWelcome,
} from "../utils/clack/index.js";
import { offerProjectScopedMcpConfig } from "../utils/clack/mcp-config.js";
import { Sentry } from "../telemetry.js";

import { checkInstalledCLI } from "./check-installed-cli.js";
import { configureFastlane } from "./configure-fastlane.js";
import { configureSentryCLI } from "./configure-sentry-cli.js";
import { configureXcodeProject } from "./configure-xcode-project.js";
import { injectCodeSnippet } from "./inject-code-snippet.js";
import {
  lookupXcodeProject,
  selectXcodeTarget,
} from "./lookup-xcode-project.js";
import { type AppleWizardOptions } from "./options.js";
import { abortIfSpotlightNotSupported } from "../utils/abort-if-sportlight-not-supported.js";

export async function runAppleWizard(
  options: AppleWizardOptions,
): Promise<void> {
  return await withTelemetry(
    {
      enabled: options.telemetryEnabled,
      integration: "ios",
      wizardOptions: options,
    },
    () => runAppleWizardWithTelementry(options),
  );
}

async function runAppleWizardWithTelementry(
  options: AppleWizardOptions,
): Promise<void> {
  // Define options with defaults
  const projectDir = options.projectDir ?? process.cwd();

  // Step - Welcome Message
  printWelcome({
    wizardName: "Sentry Apple Wizard",
  });

  // Step - Git Status Check
  await confirmContinueIfNoOrDirtyGitRepo({
    ignoreGitChanges: options.ignoreGitChanges,
    cwd: projectDir,
  });

  // Step - Sentry CLI Check
  checkInstalledCLI();

  // Step - Xcode Project Lookup
  // This step should be run before the Sentry Project and API Key step
  // because it can abort the wizard if no Xcode project is found.
  const xcProject = await lookupXcodeProject({ projectDir });
  const target = await selectXcodeTarget(xcProject);

  // Step - Sentry Project and API Key
  const projectData = await getOrAskForProjectData(options, "apple-ios");

  if (projectData.spotlight) {
    return await abortIfSpotlightNotSupported("Apple/iOS");
  }

  const { selectedProject, authToken } = projectData;

  // Step - Sentry CLI Configuration Setup
  configureSentryCLI({
    projectDir,
    authToken: authToken,
    orgSlug: selectedProject.organization.slug,
    projectSlug: selectedProject.slug,
  });

  Sentry.setTag("package-manager", "SPM");

  // Step - Configure Xcode Project
  configureXcodeProject({
    xcProject,
    project: selectedProject,
    target,
  });

  // Step - Feature Selection
  const selectedFeatures = await featureSelectionPrompt([
    {
      id: "logs",
      prompt: `Do you want to enable ${chalk.bold(
        "Logs",
      )} to send your application logs to Sentry?`,
      enabledHint: "optional",
    },
  ]);

  // Step - Add Code Snippet
  injectCodeSnippet({
    project: xcProject,
    target,
    dsn: selectedProject.keys[0].dsn.public,
    enableLogs: selectedFeatures["logs"] ?? false,
  });

  // Step - Fastlane Configuration
  await configureFastlane({
    projectDir,
    orgSlug: selectedProject.organization.slug,
    projectSlug: selectedProject.slug,
  });

  // Offer optional project-scoped MCP config for Sentry with org and project scope
  await offerProjectScopedMcpConfig(
    selectedProject.organization.slug,
    selectedProject.slug,
  );

  clack.log.success(
    "Sentry was successfully added to your project! Run your project to send your first event to Sentry. Go to Sentry.io to see whether everything is working fine.",
  );
}
