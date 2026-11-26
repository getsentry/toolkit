/**
 * Print how to export SwiftUI preview snapshots with `xcodebuild` and upload
 * them with `sentry snapshots upload`, or the project's Fastlane lane when it
 * has one.
 *
 * The wizard runs through `sentry`, whose `snapshots upload` is built in, so
 * there is no CLI to check or install here: the upload runs later from the
 * user's terminal or CI.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { sentry } from "../../../app-identity.js";
import { clack } from "../../utils/clack/prompts.js";
import { debug } from "../../utils/debug.js";
import { fastFile } from "../fastlane.js";

type SnapshotVerificationGuidance = {
  appId?: string | undefined;
  hostedTestTargetName: string;
  projectDir: string;
  projectPath: string;
  schemeName?: string | undefined;
  snapshotTestClassName: string;
};

/** Print the snapshot export and upload commands for the project. */
export function printSnapshotsUploadSetup({
  projectDir,
  verificationGuidance,
}: {
  projectDir: string;
  verificationGuidance: SnapshotVerificationGuidance;
}): void {
  printSnapshotsUploadGuidance({
    fastlaneGuidance: getSnapshotFastlaneGuidance(projectDir),
    verificationGuidance,
  });
}

export function getSnapshotFastlaneGuidance(projectDir: string) {
  const fastfilePath = fastFile(projectDir) ?? undefined;
  if (!fastfilePath) {
    return {
      hasUploadLane: false,
      hasSentryUploadAction: false,
    };
  }

  let contents: string;
  try {
    contents = readFileSync(fastfilePath, "utf8");
  } catch (error) {
    // An unreadable Fastfile only means no Fastlane guidance; say so and go on.
    debug(error);
    clack.log.warn(
      `Could not read the Fastfile at ${fastfilePath}. Skipping Fastlane snapshots upload detection.`,
    );
    return {
      hasUploadLane: false,
      hasSentryUploadAction: false,
    };
  }

  return {
    fastfilePath,
    hasUploadLane: /lane\s+:upload_sentry_snapshots\b/.test(contents),
    hasSentryUploadAction: /\bsentry_upload_snapshots\s*\(/.test(contents),
  };
}

function printSnapshotsUploadGuidance({
  fastlaneGuidance,
  verificationGuidance,
}: {
  fastlaneGuidance: ReturnType<typeof getSnapshotFastlaneGuidance>;
  verificationGuidance: SnapshotVerificationGuidance;
}): void {
  if (fastlaneGuidance.fastfilePath && fastlaneGuidance.hasUploadLane) {
    clack.log.info(
      [
        "Detected existing Fastlane snapshots upload support.",
        buildSnapshotExportCommand(verificationGuidance),
        "Then verify upload with:",
        'bundle exec fastlane ios upload_sentry_snapshots path: "$PWD/snapshot-images"',
      ].join("\n"),
    );
    return;
  }

  if (fastlaneGuidance.fastfilePath && fastlaneGuidance.hasSentryUploadAction) {
    clack.log.info(
      [
        "Detected a Fastlane lane that calls sentry_upload_snapshots.",
        "After exporting snapshots, run that existing lane with your snapshot image path.",
        "If you are unsure which lane to use, fall back to the upload command below.",
      ].join("\n"),
    );
  }

  clack.log.info(
    [
      buildSnapshotExportCommand(verificationGuidance),
      "",
      "After SnapshotPreviews exports images, verify local upload with:",
      // `sentry` reads the org and project from SENTRY_ORG and SENTRY_PROJECT,
      // or from .sentryclirc; `snapshots upload` has no flags for them.
      "SENTRY_ORG=your-org SENTRY_PROJECT=your-ios-project \\",
      sentry`snapshots upload "$PWD/snapshot-images" \\`,
      verificationGuidance.appId
        ? `  --app-id ${verificationGuidance.appId}`
        : "  --app-id YOUR_APP_BUNDLE_ID # replace with your app bundle identifier",
      "",
      `Auth comes from \`${sentry`auth login`}\`, SENTRY_AUTH_TOKEN, or a .sentryclirc file. In CI, set SENTRY_AUTH_TOKEN, SENTRY_ORG, and SENTRY_PROJECT, and SENTRY_URL for self-hosted Sentry. CI workflow setup is documented at https://docs.sentry.io/platforms/apple/snapshots/#step-3-integrate-into-ci; this wizard does not write workflow files.`,
    ].join("\n"),
  );
}

function buildSnapshotExportCommand(
  guidance: SnapshotVerificationGuidance,
): string {
  return [
    `From ${quoteShell(guidance.projectDir)}, export snapshots with:`,
    'TEST_RUNNER_SNAPSHOTS_EXPORT_DIR="$PWD/snapshot-images" \\',
    "xcodebuild test \\",
    `  -project ${quoteShell(
      path.relative(guidance.projectDir, guidance.projectPath) ||
        guidance.projectPath,
    )} \\`,
    `  -scheme ${
      guidance.schemeName ? quoteShell(guidance.schemeName) : "<scheme>"
    } \\`,
    "  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \\",
    `  -only-testing:${quoteShell(
      `${guidance.hostedTestTargetName}/${guidance.snapshotTestClassName}`,
    )} \\`,
    "  CODE_SIGNING_ALLOWED=NO \\",
    "  | xcpretty",
  ].join("\n");
}

function quoteShell(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, "'\\''")}'`;
}
