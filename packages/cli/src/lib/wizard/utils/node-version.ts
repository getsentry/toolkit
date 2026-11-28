/**
 * Check the Node.js version a framework's SDK needs.
 */

import { clack } from "./clack/prompts.js";
import chalk from "chalk";
import { coerce, satisfies } from "semver";

/**
 * Node.js versions supported by version 11 of the Sentry JavaScript SDKs.
 * See https://docs.sentry.io/platforms/javascript/migration/v10-to-v11/#nodejs
 */
export const NODE_VERSION_RANGE_FOR_SDK_V11 =
  ">=20.19.0 <22.0.0 || >=22.12.0 <23.0.0 || >=23.2.0";

/**
 * Returns `false` when the given Node.js version is definitely not supported by
 * SDK v11. Unparseable versions are treated as supported.
 */
export function isNodeVersionSupportedBySdkV11(
  version: string = process.version,
): boolean {
  const parsed = coerce(version);
  if (!parsed) {
    return true;
  }
  return satisfies(parsed, NODE_VERSION_RANGE_FOR_SDK_V11);
}

/**
 * Warns when the wizard runs on a Node.js version that SDK v11 does not
 * support. The wizard continues either way: the project may be built and run
 * on a different Node.js than the one the wizard runs on.
 */
export function warnIfNodeVersionUnsupportedBySdkV11(
  version: string = process.version,
): void {
  if (isNodeVersionSupportedBySdkV11(version)) {
    return;
  }

  clack.log.warn(
    `${chalk.yellow(
      `Version 11 of the Sentry JavaScript SDKs requires Node.js 20.19.0 or newer (22.12.0 on Node.js 22, 23.2.0 on Node.js 23), but this wizard is running on Node.js ${chalk.bold(
        version,
      )}.`,
    )}
The wizard will continue. Make sure your project builds and runs on a supported Node.js version before moving to SDK v11.`,
  );
}
