/**
 * Offer to add the `sentry_debug_files_upload` action to a lane of the
 * project's Fastfile.
 */

import { clack } from "../utils/clack/prompts.js";
import { Sentry } from "../telemetry.js";
import chalk from "chalk";
import { traceStep } from "../telemetry.js";
import { abortIfCancelled } from "../utils/clack/index.js";
import { debug } from "../utils/debug.js";
import { addSentryToFastlane, fastFile } from "./fastlane.js";

export async function configureFastlane({
  projectDir,
  orgSlug,
  projectSlug,
}: {
  projectDir: string;
  orgSlug: string;
  projectSlug: string;
}) {
  debug(`Checking if Fastfile exists in directory: ${chalk.cyan(projectDir)}`);
  const isFastlaneAvailable = fastFile(projectDir);
  Sentry.setTag("fastlane-exists", isFastlaneAvailable);
  if (!isFastlaneAvailable) {
    debug(`Fastfile not found, not configuring Fastlane`);
    // If fastlane is not available, we don't need to configure it and exit early.
    return;
  }

  debug(`Fastfile found, asking user if they want to configure Fastlane`);
  const shouldAddLane = await abortIfCancelled(
    clack.confirm({
      message:
        "Found a Fastfile in your project. Do you want to configure a lane to upload debug symbols to Sentry?",
    }),
  );
  debug(`User wants to add lane: ${chalk.cyan(shouldAddLane.toString())}`);
  Sentry.setTag("fastlane-desired", shouldAddLane);

  if (shouldAddLane) {
    debug(`Adding Sentry lane to Fastlane`);
    const added = await traceStep("Configure fastlane", () =>
      addSentryToFastlane(projectDir, orgSlug, projectSlug),
    );
    Sentry.setTag("fastlane-added", added);
    debug(`Fastlane added: ${chalk.cyan(added.toString())}`);

    if (added) {
      clack.log.step(
        "A new step was added to your fastlane file. Now and you build your project with fastlane, debug symbols and source context will be uploaded to Sentry.",
      );
    } else {
      clack.log.warn(
        "Could not edit your fastlane file to upload debug symbols to Sentry. Please follow the instructions at https://docs.sentry.io/platforms/apple/guides/ios/dsym/#fastlane",
      );
    }
  }
}
