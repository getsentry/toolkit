/**
 * The Apple Snapshots wizard (`sentry wizard appleSnapshots`): links
 * SnapshotPreviews to a hosted XCTest target, adds a snapshot test, and
 * prints how to export and upload the snapshots.
 */

import { existsSync } from "node:fs";
import path from "node:path";

import { clack } from "../../utils/clack/prompts.js";

import { withTelemetry } from "../../telemetry.js";
import {
  abort,
  abortIfCancelled,
  askForItemSelection,
  confirmContinueIfNoOrDirtyGitRepo,
  printWelcome,
} from "../../utils/clack/index.js";
import {
  lookupXcodeProject,
  selectXcodeTarget,
} from "../lookup-xcode-project.js";
import type { AppleSnapshotsWizardOptions } from "../options.js";
import type { XcodeProject } from "../xcode-manager.js";
import { printSnapshotsUploadSetup } from "./snapshots-cli-preflight.js";
import { configureSnapshotPreviewsXcodeProject } from "./configure-snapshotpreviews-xcode-project.js";
import {
  ensureSnapshotTestFile,
  snapshotTestClassName,
  snapshotTestTemplate,
} from "./snapshot-test-file.js";
import { resolveSnapshotVerificationSchemeName } from "./snapshot-verification-scheme.js";
import {
  SNAPSHOTPREVIEWS_MINIMUM_VERSION,
  SNAPSHOTPREVIEWS_PACKAGE_URL,
  SNAPSHOTPREVIEWS_PREFERENCES_PRODUCT,
  SNAPSHOTPREVIEWS_SNAPSHOT_TESTS_PRODUCT,
} from "./snapshotpreviews-package.js";

const APPLE_SNAPSHOTS_SETUP_DID_NOT_COMPLETE =
  "Apple Snapshots setup did not complete.";

export async function runAppleSnapshotsWizard(
  options: AppleSnapshotsWizardOptions,
): Promise<void> {
  return await withTelemetry(
    {
      enabled: options.telemetryEnabled,
      integration: "appleSnapshots",
      wizardOptions: options,
    },
    () => runAppleSnapshotsWizardWithTelemetry(options),
  );
}

async function runAppleSnapshotsWizardWithTelemetry(
  options: AppleSnapshotsWizardOptions,
): Promise<void> {
  const projectDir = options.projectDir ?? process.cwd();

  printWelcome({
    wizardName: "Sentry Apple Snapshots Wizard",
  });

  await confirmContinueIfNoOrDirtyGitRepo({
    ignoreGitChanges: options.ignoreGitChanges,
    cwd: projectDir,
    nonInteractive: options.nonInteractive,
  });

  clack.log.info(
    [
      `Apple Snapshots setup will use ${SNAPSHOTPREVIEWS_PACKAGE_URL}`,
      `${SNAPSHOTPREVIEWS_MINIMUM_VERSION}+ and link`,
      `${SNAPSHOTPREVIEWS_SNAPSHOT_TESTS_PRODUCT} to the hosted XCTest`,
      `target and ${SNAPSHOTPREVIEWS_PREFERENCES_PRODUCT} to the selected`,
      "app target.",
    ].join(" "),
  );

  const xcProject = await lookupXcodeProject({
    projectDir,
    nonInteractive: options.nonInteractive,
  });

  const appTargetName = await resolveAppTargetName(xcProject, options);
  if (!appTargetName) {
    return await abort(APPLE_SNAPSHOTS_SETUP_DID_NOT_COMPLETE);
  }

  const hostedTestTargetName = await resolveHostedTestTargetName(
    xcProject,
    appTargetName,
    options,
  );
  if (!hostedTestTargetName) {
    return await abort(APPLE_SNAPSHOTS_SETUP_DID_NOT_COMPLETE);
  }

  const previewTargetNames = [appTargetName];

  clack.log.info(
    [
      `${SNAPSHOTPREVIEWS_PREFERENCES_PRODUCT} will be linked to the selected`,
      "app target when possible. Import SnapshotPreferences in Swift",
      "preview files only if you want to use SnapshotPreviews modifiers.",
    ].join(" "),
  );

  if (existsSync(path.join(projectDir, "Package.swift"))) {
    clack.log.info(
      [
        "Detected Package.swift. This wizard does not edit SwiftPM manifests.",
        `If SwiftPM preview targets use SnapshotPreferences modifiers, add`,
        `the ${SNAPSHOTPREVIEWS_PREFERENCES_PRODUCT} product dependency to those`,
        "targets in Package.swift.",
      ].join(" "),
    );
  }

  const packageResult = configureSnapshotPreviewsXcodeProject({
    xcodeProject: xcProject,
    hostedTestTargetName,
    previewTargetNames,
  });

  if (!packageResult.linked) {
    clack.log.error(
      "SnapshotPreviews package products could not be linked to the selected targets. Please check the Xcode project target build phases and try again.",
    );
    await abort(APPLE_SNAPSHOTS_SETUP_DID_NOT_COMPLETE);
    return;
  }

  if (packageResult.failedSnapshotPreferencesTargetNames.length) {
    clack.log.warn(
      [
        `${SNAPSHOTPREVIEWS_PREFERENCES_PRODUCT} could not be linked to`,
        packageResult.failedSnapshotPreferencesTargetNames.join(", "),
        "because the target Frameworks build phase could not be updated.",
        "Apple Snapshots setup will continue; link the product manually if",
        "you want to use SnapshotPreviews modifiers in Swift previews.",
      ].join(" "),
    );
  }

  const snapshotTestResult = ensureSnapshotTestFile({
    xcodeProject: xcProject,
    hostedTestTargetName,
  });
  if (!snapshotTestResult.included) {
    clack.log.error(
      "SnapshotPreviews test file could not be added to the selected XCTest target. Please check the target Sources build phase and try again.",
    );
    await abort(APPLE_SNAPSHOTS_SETUP_DID_NOT_COMPLETE);
    return;
  }

  if (snapshotTestResult.changed || packageResult.changed) {
    xcProject.write();
    clack.log.success("Updated the Xcode project for SnapshotPreviews.");
  } else {
    clack.log.info("SnapshotPreviews Xcode project setup is already present.");
  }

  printSnapshotsUploadSetup({
    projectDir,
    verificationGuidance: {
      appId: xcProject.getBundleIdentifierForTarget(appTargetName),
      hostedTestTargetName,
      projectDir,
      projectPath: xcProject.xcodeprojPath,
      schemeName: resolveSnapshotVerificationSchemeName({
        hostedTestTargetName,
        xcodeprojPath: xcProject.xcodeprojPath,
      }),
      snapshotTestClassName: snapshotTestResult.className,
    },
  });

  clack.outro("Apple Snapshots setup complete.");
}

async function resolveAppTargetName(
  xcodeProject: XcodeProject,
  options: AppleSnapshotsWizardOptions,
): Promise<string | undefined> {
  const appTargetNames = xcodeProject.getAllTargets();
  if (options.appTarget) {
    if (appTargetNames.includes(options.appTarget)) {
      return options.appTarget;
    }

    clack.log.error(
      `Xcode app target ${
        options.appTarget
      } was not found. Available app targets: ${formatList(appTargetNames)}.`,
    );
    return undefined;
  }

  if (appTargetNames.length === 0) {
    clack.log.error("No application target found.");
    return undefined;
  }

  if (options.nonInteractive && appTargetNames.length !== 1) {
    clack.log.error(
      [
        "Could not automatically select an Xcode app target in non-interactive mode.",
        `Available app targets: ${formatList(appTargetNames)}.`,
        "Pass --app-target <target-name> to select the app target that SnapshotPreviews should use.",
      ].join(" "),
    );
    return undefined;
  }

  return await selectXcodeTarget(xcodeProject, {
    targetNames: appTargetNames,
    noTargetMessage: "No application target found.",
    promptMessage: "Which app target should SnapshotPreviews use?",
  });
}

async function resolveHostedTestTargetName(
  xcodeProject: XcodeProject,
  appTargetName: string,
  options: AppleSnapshotsWizardOptions,
): Promise<string | undefined> {
  const hostedTestTargetNames = xcodeProject.getHostedUnitTestTargetNames();
  if (options.hostedTestTarget) {
    if (hostedTestTargetNames.includes(options.hostedTestTarget)) {
      return options.hostedTestTarget;
    }

    clack.log.error(
      [
        `Hosted XCTest target ${options.hostedTestTarget} was not found or does not define TEST_HOST.`,
        `Available hosted XCTest targets: ${formatList(
          hostedTestTargetNames,
        )}.`,
      ].join(" "),
    );
    return undefined;
  }

  const inferredHostedTestTargetNames =
    xcodeProject.getHostedUnitTestTargetNamesForApplicationTarget(
      appTargetName,
    );
  if (inferredHostedTestTargetNames.length > 0) {
    return await selectHostedTestTargetName({
      appTargetName,
      hostedTestTargetNames: inferredHostedTestTargetNames,
      nonInteractive: options.nonInteractive,
      promptMessage: "Which test target should render SnapshotPreviews?",
    });
  }

  if (hostedTestTargetNames.length === 0) {
    clack.log.error(
      [
        `No hosted XCTest target was found for ${appTargetName}.`,
        manualAppleSnapshotsSetupInstructions({ appTargetName }),
      ].join("\n"),
    );
    return undefined;
  }

  clack.log.warn(
    [
      `Could not automatically match a hosted XCTest target to ${appTargetName}.`,
      "This can happen when TEST_HOST uses Xcode build-setting macros for the app bundle or executable name.",
    ].join(" "),
  );

  return await selectHostedTestTargetName({
    appTargetName,
    hostedTestTargetNames,
    nonInteractive: options.nonInteractive,
    promptMessage: "Which hosted XCTest target should render SnapshotPreviews?",
  });
}

async function selectHostedTestTargetName({
  appTargetName,
  hostedTestTargetNames,
  nonInteractive,
  promptMessage,
}: {
  appTargetName: string;
  hostedTestTargetNames: string[];
  nonInteractive: boolean;
  promptMessage: string;
}): Promise<string | undefined> {
  if (hostedTestTargetNames.length === 1) {
    return hostedTestTargetNames[0];
  }

  if (nonInteractive) {
    clack.log.error(
      [
        `Could not automatically select the hosted XCTest target for ${appTargetName} in non-interactive mode.`,
        `Available hosted XCTest targets: ${formatList(
          hostedTestTargetNames,
        )}.`,
        "Pass --hosted-test-target <target-name> to select the target explicitly.",
        manualAppleSnapshotsSetupInstructions({
          appTargetName,
          hostedTestTargetName: hostedTestTargetNames[0],
        }),
      ].join("\n"),
    );
    return undefined;
  }

  const selection = await abortIfCancelled(
    askForItemSelection(hostedTestTargetNames, promptMessage),
  );
  return selection.value;
}

function manualAppleSnapshotsSetupInstructions({
  appTargetName,
  hostedTestTargetName,
}: {
  appTargetName: string;
  hostedTestTargetName?: string | undefined;
}): string {
  const exampleHostedTestTargetName = hostedTestTargetName ?? "AppTests";
  const sourceFileInstruction = hostedTestTargetName
    ? "3. Add this XCTest source file to the hosted XCTest target:"
    : `3. Add this XCTest source file to the hosted XCTest target. This example assumes the hosted XCTest target is named ${exampleHostedTestTargetName}:`;

  return [
    "Manual setup:",
    `1. Add the ${SNAPSHOTPREVIEWS_SNAPSHOT_TESTS_PRODUCT} package product to the hosted XCTest target for ${appTargetName}.`,
    `2. Add the ${SNAPSHOTPREVIEWS_PREFERENCES_PRODUCT} package product to ${appTargetName} if its Swift previews use SnapshotPreviews modifiers.`,
    sourceFileInstruction,
    "```swift",
    snapshotTestTemplate(
      snapshotTestClassName(exampleHostedTestTargetName),
    ).trimEnd(),
    "```",
    "4. Run the hosted XCTest target with xcodebuild.",
  ].join("\n");
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}
