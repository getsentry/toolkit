/**
 * The source maps wizard: configures a project's build tool to upload source
 * maps to Sentry, either with a bundler plugin or with `sentry sourcemap`
 * commands in an npm script.
 */

import chalk from "chalk";
import { sep } from "node:path";

import { Sentry, traceStep, withTelemetry } from "../telemetry.js";
import {
  abort,
  abortIfCancelled,
  confirmContinueIfNoOrDirtyGitRepo,
  getOrAskForProjectData,
  getPackageManager,
  printWelcome,
  runPrettierIfInstalled,
} from "../utils/clack/index.js";
import { clack } from "../utils/clack/prompts.js";
import { NPM } from "../utils/package-manager.js";
import type { WizardOptions } from "../utils/types.js";
import { getIssueStreamUrl } from "../utils/url.js";
import { isUnicodeSupported } from "../utils/vendor/is-unicorn-supported.js";
import { setupCI } from "./ci.js";
import { configureAngularSourcemapGenerationFlow } from "./tools/angular.js";
import { configureCRASourcemapGenerationFlow } from "./tools/create-react-app.js";
import { configureEsbuildPlugin } from "./tools/esbuild.js";
import { configureRollupPlugin } from "./tools/rollup.js";
import { configureSentryCLI } from "./tools/sentry-cli.js";
import { configureTscSourcemapGenerationFlow } from "./tools/tsc.js";
import type { SourceMapUploadToolConfigurationOptions } from "./tools/types.js";
import { configureVitePlugin } from "./tools/vite.js";
import { configureWebPackPlugin } from "./tools/webpack.js";
import { configureWrangler } from "./tools/wrangler.js";
import type { SupportedTools } from "./utils/detect-tool.js";
import { detectUsedTool } from "./utils/detect-tool.js";
import { checkIfMoreSuitableWizardExistsAndAskForRedirect } from "./utils/other-wizards.js";
import { ensureMinimumSdkVersionIsInstalled } from "./utils/sdk-version.js";

/**
 * Run the source maps wizard (`sentry wizard -i sourcemaps`). Framework
 * wizards pass `preSelectedTool` to run only the tool and CI setup.
 */
export async function runSourcemapsWizard(
  options: WizardOptions,
  preSelectedTool?: SupportedTools,
): Promise<void> {
  return await withTelemetry(
    {
      enabled: options.telemetryEnabled,
      integration: "sourcemaps",
      wizardOptions: options,
    },
    () => runSourcemapsWizardWithTelemetry(options, preSelectedTool),
  );
}

async function runSourcemapsWizardWithTelemetry(
  options: WizardOptions,
  preSelectedTool?: SupportedTools,
): Promise<void> {
  if (!preSelectedTool) {
    printWelcome({
      wizardName: "Sentry Source Maps Upload Configuration Wizard",
      message: `This wizard will help you upload source maps to Sentry as part of your build.
Thank you for using Sentry :)`,
      telemetryEnabled: options.telemetryEnabled,
    });
  }

  const moreSuitableWizard = await traceStep(
    "check-framework-wizard",
    checkIfMoreSuitableWizardExistsAndAskForRedirect,
  );
  if (moreSuitableWizard) {
    await traceStep("run-framework-wizard", () => moreSuitableWizard(options));
    return;
  }

  if (!preSelectedTool) {
    await confirmContinueIfNoOrDirtyGitRepo({
      ignoreGitChanges: options.ignoreGitChanges,
      cwd: undefined,
    });
  }

  await traceStep("check-sdk-version", ensureMinimumSdkVersionIsInstalled);

  const projectData = await getOrAskForProjectData({
    ...options,
    spotlight: false,
  });

  if (projectData.spotlight) {
    // `spotlight: false` above makes this unreachable; it narrows the type
    return await abort("Source maps upload needs a Sentry project.");
  }

  const { selfHosted, selectedProject, sentryUrl, authToken } = projectData;

  const selectedTool =
    preSelectedTool ?? (await traceStep("select-tool", askForUsedBundlerTool));

  Sentry.setTag("selected-tool", selectedTool);

  if (selectedTool === "no-tool") {
    clack.log.info(
      "No Problem! But in this case, there's nothing to configure :)",
    );
    await abort("Exiting, have a great day!", 0);
  }

  await traceStep("tool-setup", () =>
    startToolSetupFlow(
      selectedTool,
      {
        orgSlug: selectedProject.organization.slug,
        projectSlug: selectedProject.slug,
        selfHosted,
        url: sentryUrl,
        authToken,
      },
      preSelectedTool,
    ),
  );

  await traceStep("ci-setup", () => setupCI(selectedTool, authToken));

  if (!preSelectedTool) {
    // running prettier is only necessary if the source maps wizard is the main flow
    // skip it, if it's called from another wizard (e.g. angular)
    await runPrettierIfInstalled({ cwd: process.cwd() });
  }

  if (!preSelectedTool) {
    await traceStep("outro", () =>
      printOutro(
        sentryUrl,
        selectedProject.organization.slug,
        selectedProject.id,
      ),
    );
  }
}

async function askForUsedBundlerTool(): Promise<SupportedTools> {
  const selectedTool = await abortIfCancelled(
    clack.select<SupportedTools>({
      message: "Which framework, bundler or build tool are you using?",
      options: [
        {
          label: "Angular",
          value: "angular",
          hint: "Select this option if you are using Angular.",
        },
        {
          label: "Create React App",
          value: "create-react-app",
          hint: "Select this option if you set up your app with Create React App.",
        },
        {
          label: "Cloudflare Wrangler",
          value: "wrangler",
          hint: "You're using `wrangler deploy` to build and deploy your Cloudflare Worker.",
        },
        {
          label: "Webpack",
          value: "webpack",
          hint: "Select this if you are using Webpack and you have access to your Webpack config.",
        },
        {
          label: "Vite",
          value: "vite",
          hint: "Select this if you are using Vite and you have access to your Vite config.",
        },
        {
          label: "esbuild",
          value: "esbuild",
          hint: "Select this if you are using esbuild and you have access to your esbuild config.",
        },
        {
          label: "Rollup",
          value: "rollup",
          hint: "Select this if you are using Rollup and you have access to your Rollup config.",
        },
        {
          label: "tsc",
          value: "tsc",
          hint: "Configure source maps when using tsc as build tool",
        },
        {
          label: "I use another tool",
          value: "sentry-cli",
          hint: "This will configure source maps upload for you using the Sentry CLI",
        },
        {
          label: "I don't minify, transpile or bundle my code",
          value: "no-tool",
          hint: "This will exit the wizard",
        },
      ],
      initialValue: await detectUsedTool(),
    }),
  );

  return selectedTool;
}

async function startToolSetupFlow(
  selectedTool: SupportedTools,
  options: SourceMapUploadToolConfigurationOptions,
  preSelectedTool?: SupportedTools,
): Promise<void> {
  switch (selectedTool) {
    case "webpack":
      await configureWebPackPlugin(options);
      break;
    case "vite":
      await configureVitePlugin(options);
      break;
    case "esbuild":
      await configureEsbuildPlugin(options);
      break;
    case "rollup":
      await configureRollupPlugin(options);
      break;
    case "tsc":
      await configureSentryCLI(options, configureTscSourcemapGenerationFlow);
      break;
    case "create-react-app":
      await configureSentryCLI(
        { ...options, defaultArtifactPath: `.${sep}build` },
        configureCRASourcemapGenerationFlow,
      );
      break;
    case "wrangler":
      await configureWrangler(options);
      break;
    case "angular":
      await configureSentryCLI(
        { ...options, defaultArtifactPath: `.${sep}dist` },
        configureAngularSourcemapGenerationFlow,
        preSelectedTool === "angular",
      );
      break;
    default:
      await configureSentryCLI(options);
      break;
  }
}
async function printOutro(
  url: string,
  orgSlug: string,
  projectId: string,
): Promise<void> {
  const packageManager = await getPackageManager(NPM);

  const issueStreamUrl = getIssueStreamUrl({ url, orgSlug, projectId });

  const arrow = isUnicodeSupported() ? "→" : "->";

  clack.outro(`${chalk.green("That's it - everything is set up!")}

   ${chalk.cyan(`Test and validate your setup locally with the following Steps:

   1. Build your application in ${chalk.bold("production mode")}.
      ${chalk.gray(
        `${arrow} For example, run ${chalk.bold(packageManager.buildCommand)}.`,
      )}
      ${chalk.gray(
        `${arrow} You should see source map upload logs in your console.`,
      )}
   2. Run your application and throw a test error.
      ${chalk.gray(`${arrow} The error should appear in Sentry:`)}
      ${chalk.gray(`${arrow} ${issueStreamUrl}`)}
   3. Open the error in Sentry and verify that it's source-mapped.
      ${chalk.gray(
        `${arrow} The stack trace should show your original source code.`,
      )}
   `)}
   ${chalk.dim(
     `If you encounter any issues, please refer to the Troubleshooting Guide:
   https://docs.sentry.io/platforms/javascript/sourcemaps/troubleshooting_js

   If the guide doesn't help or you encounter a bug, please let us know:
   https://github.com/getsentry/sentry-javascript/issues`,
   )}
`);
}
