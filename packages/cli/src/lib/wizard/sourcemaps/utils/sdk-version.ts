/**
 * Check that the project's Sentry SDK is new enough for debug ID based source
 * maps (7.47.0), and help the user update it if not.
 */

import chalk from "chalk";
import { minVersion, satisfies } from "semver";

import { Sentry } from "../../telemetry.js";
import {
  abortIfCancelled,
  getPackageDotJson,
  installPackage,
} from "../../utils/clack/index.js";
import { clack } from "../../utils/clack/prompts.js";
import { debug } from "../../utils/debug.js";
import { findInstalledPackageFromList } from "../../utils/package-json.js";

const MINIMUM_DEBUG_ID_SDK_VERSION = "7.47.0";

// This array is orderd by the SDKs we want to check for first.
// The reason is that some SDKs depend on others and some users might
// have added the dependencies to their package.json. We want to make sure
// that we actually detect the "top-level" SDK first.
const SENTRY_SDK_PACKAGE_NAMES = [
  // SDKs using other framework SDKs need to be checked first
  "@sentry/astro",
  "@sentry/gatsby",
  "@sentry/nextjs",
  "@sentry/nuxt",
  "@sentry/react-router",
  "@sentry/remix",
  "@sentry/solidstart",
  "@sentry/sveltekit",
  "@sentry/tanstackstart-react",

  // Framework SDKs
  "@sentry/angular",
  "@sentry/angular-ivy",
  "@sentry/aws-serverless",
  "@sentry/bun",
  "@sentry/ember",
  "@sentry/google-cloud-serverless",
  "@sentry/nestjs",
  "@sentry/react",
  "@sentry/solid",
  "@sentry/svelte",
  "@sentry/vue",
  "@sentry/serverless",

  // Base SDKs
  "@sentry/browser",
  "@sentry/cloudflare",
  "@sentry/node",
  "@sentry/deno",
];

/**
 * Check for a minimum SDK version and prompt the user to upgrade if necessary.
 * We distinguish between 4 cases here:
 *
 * 1. Users didn't install any SDK yet
 *    -> We tell them to install an SDK and then continue with the wizard
 * 2. Users installed an SDK in the range >=7.47.0
 *    -> All good, no need to do anything!
 * 3. Users installed an SDK in the range >=7.0.0 <= 7.46.0
 *    -> We ask if they want to auto-update to the latest version
 * 4. Users installed an SDK in the range <7.x
 *    -> We tell users to manually upgrade (migrate between majors)
 */
export async function ensureMinimumSdkVersionIsInstalled(): Promise<void> {
  const installedSdkPackage = findInstalledPackageFromList(
    SENTRY_SDK_PACKAGE_NAMES,
    await getPackageDotJson(),
  );

  // Case 1:
  if (!installedSdkPackage) {
    return await handleNoSdkInstalled();
  }

  const { name: installedSdkName, version: installedSdkVersionOrRange } =
    installedSdkPackage;

  Sentry.setTag("installed-sdk", installedSdkName);

  const minInstalledVersion = getMinInstalledVersion(
    installedSdkVersionOrRange,
    installedSdkName,
  );

  if (!minInstalledVersion) {
    // This is handled in the getMinInstalledVersion function
    return;
  }

  const hasDebugIdCompatibleSdkVersion = satisfies(
    minInstalledVersion,
    `>=${MINIMUM_DEBUG_ID_SDK_VERSION}`,
    { includePrerelease: true },
  );

  // Case 2:
  if (hasDebugIdCompatibleSdkVersion) {
    Sentry.setTag("initial-sdk-version", ">=7.47.0");
    return;
  }

  const hasV7SdkVersion = satisfies(minInstalledVersion, ">=7.0.0", {
    includePrerelease: true,
  });

  clack.log.warn(
    `${chalk.yellowBright(
      `It seems like you're using an outdated version (${installedSdkVersionOrRange}) of the ${chalk.bold(
        installedSdkName,
      )} SDK.`,
    )}
Uploading source maps is easiest with an SDK from version ${chalk.bold(
      MINIMUM_DEBUG_ID_SDK_VERSION,
    )} or newer.    
`,
  );

  // Case 3:
  if (hasV7SdkVersion) {
    await handleAutoUpdateSdk(installedSdkName);
    return;
  }

  // Case 4:
  await handleManuallyUpdateSdk(minInstalledVersion);
}

async function handleManuallyUpdateSdk(
  minInstalledVersion: string,
): Promise<void> {
  Sentry.setTag(
    "initial-sdk-version",
    satisfies(minInstalledVersion, ">=6.0.0", { includePrerelease: true })
      ? "6.x"
      : "<6.0.0",
  );

  clack.log
    .info(`When upgrading from a version older than 7.0.0, make sure to follow the migration guide:
https://github.com/getsentry/sentry-javascript/blob/develop/MIGRATION.md#upgrading-from-6x-to-7x
`);

  const didUpdate = await abortIfCancelled(
    clack.select({
      message: "Did you update your SDK to the latest version?",
      options: [
        {
          label: "Yes!",
          value: true,
        },
        {
          label: "No, I'll do it later...",
          value: false,
          hint: chalk.yellow(
            `Remember to update your SDK to at least ${MINIMUM_DEBUG_ID_SDK_VERSION}.`,
          ),
        },
      ],
      initialValue: true,
    }),
  );

  Sentry.setTag(
    "resolved-sdk-status",
    didUpdate ? "updated-manually" : "update-later",
  );
}

async function handleAutoUpdateSdk(packageName: string): Promise<void> {
  Sentry.setTag("initial-sdk-version", ">=7.0.0 <7.47.0");

  const shouldUpdate = await abortIfCancelled(
    clack.select({
      message:
        "Do you want to automatically update your SDK to the latest version?",
      options: [
        {
          label: "Yes!",
          value: true,
          hint: chalk.green("Recommended"),
        },
        {
          label: "No, I'll do it later...",
          value: false,
          hint: chalk.yellow(
            `Remember to update your SDK to at least ${MINIMUM_DEBUG_ID_SDK_VERSION}.`,
          ),
        },
      ],
      initialValue: true,
    }),
  );

  if (shouldUpdate) {
    await installPackage({
      packageName,
      alreadyInstalled: true,
      askBeforeUpdating: false, // we already did this above
    });
  }

  Sentry.setTag(
    "resolved-sdk-status",
    shouldUpdate ? "updated-automatically" : "update-later",
  );
}

async function handleNoSdkInstalled(): Promise<void> {
  Sentry.setTag("initial-sdk-version", "none");
  Sentry.setTag("installed-sdk", "none");

  clack.log.warn(
    `${chalk.yellowBright(
      `It seems like you didn't yet install a Sentry SDK in your project.`,
    )}
We recommend setting up the SDK before continuing with the source maps wizard.

${chalk.dim(`Take a look at our docs to get started:
https://docs.sentry.io/`)}`,
  );

  const installedSDK = await abortIfCancelled(
    clack.select({
      message: "Did you set up your Sentry SDK?",
      options: [
        { label: "Yes, continue!", value: true },
        {
          label: "I'll do it later...",
          value: false,
          hint: chalk.yellow(
            "You need to set up an SDK before you can use Sentry",
          ),
        },
      ],
      initialValue: true,
    }),
  );

  Sentry.setTag(
    "resolved-sdk-status",
    installedSDK ? "installed-manually" : "install-later",
  );
}

function getMinInstalledVersion(
  installedSdkVersionOrRange: string,
  installedSdkName: string,
): string | undefined {
  try {
    // If `minVersion` is unable to parse the version it will throw an error
    // However, it will also return `null` if the parameter is undefined, which
    // we explicitly checked before but the typing doesn't know that.
    const minInstalledVersion = minVersion(installedSdkVersionOrRange)?.version;
    if (minInstalledVersion) {
      return minInstalledVersion;
    }
  } catch (error) {
    // An unparseable version is handled with the `null` case below
    debug(error);
  }

  Sentry.setTag("initial-sdk-version", "unknown");
  clack.log.warn(
    `${chalk.yellow(
      `Could not parse the version of your installed SDK ("${installedSdkName}": "${installedSdkVersionOrRange}")`,
    )}

Please make sure that your Sentry SDK is updated to version ${chalk.bold(
      MINIMUM_DEBUG_ID_SDK_VERSION,
    )} or newer.
    `,
  );

  return undefined;
}
