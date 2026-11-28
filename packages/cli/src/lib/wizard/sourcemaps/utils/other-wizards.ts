/**
 * Point users of a framework that has its own wizard (SvelteKit, React
 * Native) to that wizard instead of the generic source maps one.
 */

import chalk from "chalk";

import { Sentry } from "../../telemetry.js";
import {
  abort,
  abortIfCancelled,
  getPackageDotJson,
} from "../../utils/clack/index.js";
import { clack } from "../../utils/clack/prompts.js";
import {
  findInstalledPackageFromList,
  hasPackageInstalled,
} from "../../utils/package-json.js";
import type { WizardOptions } from "../../utils/types.js";

type WizardFunction = (options: WizardOptions) => Promise<void>;

type FrameworkInfo = {
  frameworkName: string;
  frameworkPackage: string;
  troubleshootingDocsLink: string;
  sourcemapsDocsLink: string;
  wizard: WizardFunction;
};

/**
 * The `sentry wizard -i <integration>` flow. `run.ts` is imported on demand
 * because it imports this flow.
 */
function runOtherWizard(
  integration: "sveltekit" | "reactNative",
): WizardFunction {
  return async (options) => {
    const { runWizard } = await import("../../run.js");
    await runWizard({ integration, wizardOptions: options });
  };
}

const sdkMap: Record<string, FrameworkInfo> = {
  "@sentry/sveltekit": {
    frameworkName: "SvelteKit",
    frameworkPackage: "@sveltejs/kit",
    sourcemapsDocsLink:
      "https://docs.sentry.io/platforms/javascript/guides/sveltekit/manual-setup/#configure-source-maps-upload",
    troubleshootingDocsLink:
      "https://docs.sentry.io/platforms/javascript/guides/sveltekit/sourcemaps/troubleshooting_js/",
    wizard: runOtherWizard("sveltekit"),
  },
  "@sentry/react-native": {
    frameworkName: "React Native",
    frameworkPackage: "react-native",
    sourcemapsDocsLink:
      "https://docs.sentry.io/platforms/react-native/sourcemaps/",
    troubleshootingDocsLink:
      "https://docs.sentry.io/platforms/react-native/troubleshooting/#source-maps",
    wizard: runOtherWizard("reactNative"),
  },
};

/**
 * When the project uses a framework with its own wizard, ask whether to run
 * that wizard instead, and return it if so.
 */
export async function checkIfMoreSuitableWizardExistsAndAskForRedirect(): Promise<
  WizardFunction | undefined
> {
  const framework = await checkIfMoreSuitableWizardExists();

  if (!framework) {
    return undefined;
  }

  return await askForRedirect(framework.sdkName, framework.info);
}

async function checkIfMoreSuitableWizardExists(): Promise<
  { sdkName: string; info: FrameworkInfo } | undefined
> {
  Sentry.setTag("using-wrong-wizard", false);

  const packageJson = await getPackageDotJson();

  const installedSdkPackage = findInstalledPackageFromList(
    Object.keys(sdkMap),
    packageJson,
  );

  const info = installedSdkPackage && sdkMap[installedSdkPackage.name];
  if (!installedSdkPackage || !info) {
    return undefined;
  }

  if (!hasPackageInstalled(info.frameworkPackage, packageJson)) {
    // The user has installed the SDK but not the framework.
    // Maybe it's a false positive and the user is using a different framework.
    // Let's not redirect them to the framework wizard in that case.
    return undefined;
  }

  Sentry.setTag("using-wrong-wizard", true);

  return { sdkName: installedSdkPackage.name, info };
}

async function askForRedirect(
  sdkName: string,
  {
    frameworkName,
    sourcemapsDocsLink,
    troubleshootingDocsLink,
    wizard,
  }: FrameworkInfo,
): Promise<WizardFunction | undefined> {
  clack.log.warn(
    `${chalk.yellow(
      `It seems like you're using this wizard in a ${frameworkName} project.`,
    )}

We recommend using our dedicated ${frameworkName} wizard instead of this wizard.
The ${frameworkName} wizard will set up our ${sdkName} SDK and also configure uploading source maps for you.

If you already tried the ${frameworkName} wizard and it didn't work for you, check out the following guides:

Manual source maps configuration for ${frameworkName}:
${sourcemapsDocsLink}

Troubleshooting Source Maps:
${troubleshootingDocsLink}
`,
  );

  const nextStep = await abortIfCancelled(
    clack.select<"redirect" | "continue" | "stop">({
      message: `Do you want to run the ${frameworkName} wizard now?`,
      options: [
        {
          label: "Yes",
          value: "redirect",
          hint: chalk.green("Recommended"),
        },
        {
          label: "No, continue with this wizard",
          value: "continue",
        },
        {
          label: "No, I'll check out the guides ",
          value: "stop",
          hint: "Exit this wizard",
        },
      ],
    }),
  );

  Sentry.setTag("wrong-wizard-decision", nextStep);

  switch (nextStep) {
    case "redirect":
      return wizard;
    case "stop":
      return await abort("Exiting Wizard", 0);
    default:
      return undefined;
  }
}
