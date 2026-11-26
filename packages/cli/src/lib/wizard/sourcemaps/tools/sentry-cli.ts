/**
 * Source maps setup for projects without a supported bundler plugin: install
 * the `sentry` CLI and add a `sentry:sourcemaps` npm script that injects
 * debug IDs into the build output and uploads it.
 *
 * sentry-wizard installed `@sentry/cli@^2` and wrote `sentry-cli sourcemaps
 * inject/upload` scripts. These are the v4 `sentry sourcemap` commands.
 */

import chalk from "chalk";
import { promises } from "node:fs";
import path from "node:path";

import { Sentry, traceStep } from "../../telemetry.js";
import {
  abortIfCancelled,
  addSentryCliConfig,
  artifactsExist,
  askToRunBuildOrEnterPathOrProceed,
  getPackageDotJson,
  getPackageManager,
  installPackage,
} from "../../utils/clack/index.js";
import { clack } from "../../utils/clack/prompts.js";
import { hasPackageInstalled } from "../../utils/package-json.js";
import { NPM } from "../../utils/package-manager.js";
import type { SourceMapUploadToolConfigurationOptions } from "./types.js";

/** The npm package of the `sentry` CLI. */
export const SENTRY_CLI_PACKAGE = "sentry";

/** The `sentry` CLI major the generated scripts are written for. */
export const SENTRY_CLI_PACKAGE_RANGE = `${SENTRY_CLI_PACKAGE}@^4`;

const SENTRY_NPM_SCRIPT_NAME = "sentry:sourcemaps";

let addedToBuildCommand = false;

type ConfigureSentryCLIOptions = SourceMapUploadToolConfigurationOptions & {
  defaultArtifactPath?: string | undefined;
};

/**
 * Install the `sentry` CLI, ask for the build output directory, and add the
 * `sentry:sourcemaps` script (optionally to the production build command).
 *
 * @param configureSourcemapGenerationFlow - Tool-specific step that makes
 *   sure the build emits source maps
 * @param skipValidation - Skip `configureSourcemapGenerationFlow`, for
 *   callers (the Angular wizard) that already configured it
 */
export async function configureSentryCLI(
  options: ConfigureSentryCLIOptions,
  configureSourcemapGenerationFlow: () => Promise<void> = defaultConfigureSourcemapGenerationFlow,
  skipValidation = false,
): Promise<void> {
  const packageDotJson = await getPackageDotJson();

  await installPackage({
    packageName: SENTRY_CLI_PACKAGE_RANGE,
    packageNameDisplayLabel: SENTRY_CLI_PACKAGE,
    alreadyInstalled: hasPackageInstalled(SENTRY_CLI_PACKAGE, packageDotJson),
  });

  let validPath = false;
  let relativeArtifactPath: string | undefined;
  do {
    const rawArtifactPath = await abortIfCancelled(
      clack.text({
        message: "Where are your build artifacts located?",
        placeholder:
          relativeArtifactPath ??
          options.defaultArtifactPath ??
          `.${path.sep}out`,
        initialValue:
          relativeArtifactPath ??
          options.defaultArtifactPath ??
          `.${path.sep}out`,
        validate(value) {
          if (!value) {
            return "Please enter a path.";
          }
          return undefined;
        },
      }),
    );

    if (path.isAbsolute(rawArtifactPath)) {
      relativeArtifactPath = path.relative(process.cwd(), rawArtifactPath);
    } else {
      relativeArtifactPath = rawArtifactPath;
    }

    if (artifactsExist(relativeArtifactPath)) {
      validPath = true;
      continue;
    }

    const runBuildOrEnterPathOrProceed =
      await askToRunBuildOrEnterPathOrProceed({
        relativeArtifactPath,
      });

    validPath = runBuildOrEnterPathOrProceed.validPath;
    relativeArtifactPath =
      runBuildOrEnterPathOrProceed.relativeArtifactPath ?? relativeArtifactPath;
  } while (!validPath);

  const relativePosixArtifactPath = relativeArtifactPath
    .split(path.sep)
    .join(path.posix.sep);

  if (!skipValidation) {
    await configureSourcemapGenerationFlow();
  }

  await createAndAddNpmScript(options, relativePosixArtifactPath);

  if (await askShouldAddToBuildCommand()) {
    await traceStep("sentry-cli-add-to-build-cmd", () =>
      addSentryCommandToBuildCommand(),
    );
  } else {
    clack.log.info(
      `No problem, just make sure to run this script ${chalk.bold(
        "after",
      )} building your application but ${chalk.bold("before")} deploying!`,
    );
  }

  await addSentryCliConfig({ authToken: options.authToken });
}

/**
 * Ask the user to run the `sentry:sourcemaps` script in CI, unless the
 * wizard already added it to the build command.
 */
export async function setupNpmScriptInCI(): Promise<void> {
  if (addedToBuildCommand) {
    // No need to tell users to add it manually to their CI
    // if the script is already added to the build command
    return;
  }

  const addedToCI = await abortIfCancelled(
    clack.select({
      message: `Add a step to your CI pipeline that runs the ${chalk.cyan(
        SENTRY_NPM_SCRIPT_NAME,
      )} script ${chalk.bold("right after")} building your application.`,
      options: [
        { label: "I did, continue!", value: true },
        {
          label: "I'll do it later...",
          value: false,
          hint: chalk.yellow(
            `You need to run ${chalk.cyan(
              SENTRY_NPM_SCRIPT_NAME,
            )} after each build for source maps to work properly.`,
          ),
        },
      ],
      initialValue: true,
    }),
  );

  Sentry.setTag("added-ci-script", addedToCI);

  if (!addedToCI) {
    clack.log.info("Don't forget! :)");
  }
}

/**
 * The `sentry:sourcemaps` script: inject debug IDs into the build output,
 * then upload it. A self-hosted URL goes in `SENTRY_URL`, which replaced
 * the `--url` flag of sentry-cli.
 */
export function getSentryCliNpmScript(
  options: SourceMapUploadToolConfigurationOptions,
  relativePosixArtifactPath: string,
): string {
  const urlEnv = options.selfHosted ? `SENTRY_URL=${options.url} ` : "";
  // oxlint-disable-next-line sentry-cli/no-hardcoded-sentry-command -- runs the project's installed `sentry` package from its package.json scripts, not a hint
  return `sentry sourcemap inject ${relativePosixArtifactPath} && ${urlEnv}sentry sourcemap upload --org ${options.orgSlug} --project ${options.projectSlug} ${relativePosixArtifactPath}`;
}

async function createAndAddNpmScript(
  options: SourceMapUploadToolConfigurationOptions,
  relativePosixArtifactPath: string,
): Promise<void> {
  const packageDotJson = await getPackageDotJson();

  packageDotJson.scripts = packageDotJson.scripts || {};
  packageDotJson.scripts[SENTRY_NPM_SCRIPT_NAME] = getSentryCliNpmScript(
    options,
    relativePosixArtifactPath,
  );

  await promises.writeFile(
    path.join(process.cwd(), "package.json"),
    JSON.stringify(packageDotJson, null, 2),
  );

  clack.log.info(
    `Added a ${chalk.cyan(SENTRY_NPM_SCRIPT_NAME)} script to your ${chalk.cyan(
      "package.json",
    )}.`,
  );
}

async function askShouldAddToBuildCommand(): Promise<boolean> {
  const shouldAddToBuildCommand = await abortIfCancelled(
    clack.select({
      message: `Do you want to automatically run the ${chalk.cyan(
        SENTRY_NPM_SCRIPT_NAME,
      )} script after each production build?`,
      options: [
        {
          label: "Yes",
          value: true,
          hint: "This will modify your prod build command",
        },
        { label: "No", value: false },
      ],
      initialValue: true,
    }),
  );

  Sentry.setTag("modify-build-command", shouldAddToBuildCommand);

  return shouldAddToBuildCommand;
}

/**
 * Add the sentry:sourcemaps command to the prod build command in the package.json
 * - Detect the user's build command
 * - Append the sentry:sourcemaps command to it
 */
export async function addSentryCommandToBuildCommand(): Promise<void> {
  const packageDotJson = await getPackageDotJson();
  // This usually shouldn't happen because earlier we added the
  // SENTRY_NPM_SCRIPT_NAME script but just to be sure
  packageDotJson.scripts = packageDotJson.scripts || {};
  const scripts = packageDotJson.scripts;

  const allNpmScripts = Object.keys(scripts).filter(
    (s) => s !== SENTRY_NPM_SCRIPT_NAME,
  );

  const packageManager = await getPackageManager(NPM);

  // Heuristic to pre-select the build command:
  // Often, 'build' is the prod build command, so we favour it.
  // If it's not there, commands that include 'build' might be the prod build command.
  let buildCommand =
    typeof scripts["build"] === "string"
      ? "build"
      : allNpmScripts.find((s) => s.toLocaleLowerCase().includes("build"));

  const isProdBuildCommand =
    !!buildCommand &&
    (await abortIfCancelled(
      clack.confirm({
        message: `Is ${chalk.cyan(
          `${packageManager.runScriptCommand} ${buildCommand}`,
        )} your production build command?`,
      }),
    ));

  if (allNpmScripts.length && (!buildCommand || !isProdBuildCommand)) {
    buildCommand = await abortIfCancelled(
      clack.select({
        message: `Which ${packageManager.name} command in your ${chalk.cyan(
          "package.json",
        )} builds your application for production?`,
        options: [
          ...allNpmScripts.map((script) => ({
            label: script,
            value: script,
          })),
          { label: "None of the above", value: "none" },
        ],
      }),
    );
  }

  if (!buildCommand || buildCommand === "none") {
    clack.log.warn(
      `We can only add the ${chalk.cyan(
        SENTRY_NPM_SCRIPT_NAME,
      )} script to another \`script\` in your ${chalk.cyan("package.json")}.
Please add it manually to your prod build command.`,
    );
    return;
  }

  const oldCommand = scripts[buildCommand];
  if (!oldCommand) {
    // very unlikely to happen but nevertheless
    clack.log.warn(
      `\`${buildCommand}\` doesn't seem to be part of your package.json scripts`,
    );
    return;
  }

  const newCommand = `${oldCommand} && ${packageManager.runScriptCommand} ${SENTRY_NPM_SCRIPT_NAME}`;

  if (oldCommand.endsWith(SENTRY_NPM_SCRIPT_NAME)) {
    clack.log.info(
      `It seems like ${chalk.cyan(
        SENTRY_NPM_SCRIPT_NAME,
      )} is already part of your ${chalk.cyan(
        buildCommand,
      )} command. Will not add it again.
Current command: ${chalk.dim(oldCommand)}
Would have injected: ${chalk.dim(newCommand)}`,
    );

    return;
  }

  scripts[buildCommand] = newCommand;

  await promises.writeFile(
    path.join(process.cwd(), "package.json"),
    JSON.stringify(packageDotJson, null, 2),
  );

  addedToBuildCommand = true;

  clack.log.info(
    `Added ${chalk.cyan(SENTRY_NPM_SCRIPT_NAME)} script to your ${chalk.cyan(
      buildCommand,
    )} command.`,
  );
}

async function defaultConfigureSourcemapGenerationFlow(): Promise<void> {
  await abortIfCancelled(
    clack.select({
      message: `Verify that your build tool is generating source maps. ${chalk.dim(
        "(Your build output folder should contain .js.map files after a build)",
      )}`,
      options: [{ label: "I checked. Continue!", value: true }],
      initialValue: true,
    }),
  );
}
