/**
 * Source map upload with `sentry` commands, for build tools that have no
 * Sentry bundler plugin (Angular, tsc, Create React App, …).
 *
 * Installs the `sentry` CLI package, adds a `sentry:sourcemaps` npm script
 * that runs `sentry sourcemap inject` and `sentry sourcemap upload` on the
 * build output, optionally appends it to the production build script, and
 * writes the org, project, and auth token to `.sentryclirc`. v4 reads that
 * file: `[defaults]` feeds org/project resolution and `[auth] token` becomes
 * `SENTRY_AUTH_TOKEN`.
 *
 * Ported from sentry-wizard's `src/sourcemaps/tools/sentry-cli.ts`, which
 * installed `@sentry/cli`, ran `sentry-cli sourcemaps …`, and also wrote the
 * token to `.sentryclirc`.
 */

import { existsSync, promises, readFileSync } from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { Sentry, traceStep } from "../../telemetry.js";
import {
  abortIfCancelled,
  addSentryCliConfig,
  artifactsExist,
  askToRunBuildOrEnterPathOrProceed,
  getPackageDotJson,
  getPackageManager,
  installPackage,
  SENTRY_CLI_RC_FILE,
} from "../../utils/clack/index.js";
import { clack } from "../../utils/clack/prompts.js";
import { debug } from "../../utils/debug.js";
import { hasPackageInstalled } from "../../utils/package-json.js";
import { NPM } from "../../utils/package-manager.js";
import type { SourceMapUploadToolConfigurationOptions } from "./types.js";

const SENTRY_NPM_SCRIPT_NAME = "sentry:sourcemaps";

let addedToBuildCommand = false;

type configureSentryCLIOptions = SourceMapUploadToolConfigurationOptions & {
  defaultArtifactPath?: string | undefined;
};

/**
 * Set up source map upload with `sentry sourcemap` commands.
 *
 * @param options - The Sentry project to upload to, and the build output
 *   path to suggest
 * @param configureSourcemapGenerationFlow - Asks the user to turn on source
 *   map generation in their build tool
 * @param skipValidation - Skip `configureSourcemapGenerationFlow`, for flows
 *   that already turned source maps on
 */
export async function configureSentryCLI(
  options: configureSentryCLIOptions,
  configureSourcemapGenerationFlow: () => Promise<void> = defaultConfigureSourcemapGenerationFlow,
  skipValidation = false,
): Promise<void> {
  const packageDotJson = await getPackageDotJson();

  await installPackage({
    packageName: "sentry@^4",
    alreadyInstalled: hasPackageInstalled("sentry", packageDotJson),
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

  await createAndAddNpmScript(relativePosixArtifactPath);

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

  await addOrgAndProjectToSentryCliRc(options);
  await addSentryCliConfig({ authToken: options.authToken });

  if (options.selfHosted) {
    clack.log.info(
      `Set ${chalk.cyan(`SENTRY_URL=${options.url}`)} wherever ${chalk.cyan(
        SENTRY_NPM_SCRIPT_NAME,
      )} runs, such as in CI, so that it uploads to your Sentry instance.`,
    );
  }
}

/**
 * Ask the user to run the `sentry:sourcemaps` script in CI, unless the
 * wizard already appended it to the build script.
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
 * then upload it. `sentry sourcemap upload` reads the org and project from
 * `.sentryclirc` locally and from `SENTRY_ORG` / `SENTRY_PROJECT` in CI, and
 * the self-hosted URL from `SENTRY_URL`.
 */
export function getSentryCliNpmScript(
  relativePosixArtifactPath: string,
): string {
  // The script runs the `sentry` binary of the package installed above, so
  // it names `sentry` itself, not the program running the wizard.
  // oxlint-disable-next-line sentry-cli/no-hardcoded-sentry-command -- a package.json script, not a hint.
  return `sentry sourcemap inject ${relativePosixArtifactPath} && sentry sourcemap upload ${relativePosixArtifactPath}`;
}

/** An INI section header line, such as `[defaults]`. */
const INI_SECTION_RE = /^\s*\[([^\]]*)\]\s*$/;

/** The key of an INI `key = value` line. */
const INI_KEY_RE = /^\s*([^=;#\s][^=]*?)\s*=/;

/**
 * Set `values` in the `[defaults]` section of `.sentryclirc` contents and
 * keep every other line as it is.
 *
 * Existing keys are updated in every `[defaults]` section, since the last
 * one wins when the file is read. Missing keys go into the first
 * `[defaults]` section, which is appended when there is none.
 *
 * @param contents - The current file contents, empty for a new file
 * @param values - Lowercase keys and their values, such as `{ org, project }`
 */
export function setSentryCliRcDefaults(
  contents: string,
  values: Record<string, string>,
): string {
  const lines = contents === "" ? [] : contents.split("\n");
  const missing = new Map(Object.entries(values));
  let firstDefaultsHeader = -1;
  let inDefaults = false;

  lines.forEach((line, index) => {
    const section = INI_SECTION_RE.exec(line);
    if (section) {
      inDefaults = section[1]?.trim().toLowerCase() === "defaults";
      if (inDefaults && firstDefaultsHeader === -1) {
        firstDefaultsHeader = index;
      }
      return;
    }
    const key = inDefaults
      ? INI_KEY_RE.exec(line)?.[1]?.toLowerCase()
      : undefined;
    const value = key === undefined ? undefined : values[key];
    if (key !== undefined && value !== undefined) {
      lines[index] = `${key}=${value}${line.endsWith("\r") ? "\r" : ""}`;
      missing.delete(key);
    }
  });

  const newLines = [...missing].map(([key, value]) => `${key}=${value}`);
  if (newLines.length === 0) {
    return lines.join("\n");
  }
  if (firstDefaultsHeader !== -1) {
    lines.splice(firstDefaultsHeader + 1, 0, ...newLines);
    return lines.join("\n");
  }

  const prefix = lines.join("\n");
  let separator = "\n\n";
  if (prefix === "") {
    separator = "";
  } else if (prefix.endsWith("\n")) {
    separator = "\n";
  }
  return `${prefix}${separator}[defaults]\n${newLines.join("\n")}\n`;
}

/**
 * Write the org and project to the project's `.sentryclirc`, so that
 * `sentry sourcemap upload` finds them when the script runs locally.
 */
async function addOrgAndProjectToSentryCliRc(
  options: SourceMapUploadToolConfigurationOptions,
): Promise<void> {
  const configPath = path.join(process.cwd(), SENTRY_CLI_RC_FILE);
  const contents = existsSync(configPath)
    ? readFileSync(configPath, "utf8")
    : "";

  try {
    await promises.writeFile(
      configPath,
      setSentryCliRcDefaults(contents, {
        org: options.orgSlug,
        project: options.projectSlug,
      }),
    );
  } catch (error) {
    // Not fatal, like the auth token write: CI sets SENTRY_ORG and
    // SENTRY_PROJECT anyway, and the warning says what to do locally.
    debug(error);
    clack.log.warning(
      `Failed to add the org and project to ${chalk.cyan(
        SENTRY_CLI_RC_FILE,
      )}. Set ${chalk.cyan("SENTRY_ORG")} and ${chalk.cyan(
        "SENTRY_PROJECT",
      )} wherever ${chalk.cyan(SENTRY_NPM_SCRIPT_NAME)} runs.`,
    );
    return;
  }

  clack.log.success(
    `Added the org and project to ${chalk.cyan(SENTRY_CLI_RC_FILE)}.`,
  );
}

async function createAndAddNpmScript(
  relativePosixArtifactPath: string,
): Promise<void> {
  const sentryCliNpmScript = getSentryCliNpmScript(relativePosixArtifactPath);

  const packageDotJson = await getPackageDotJson();

  packageDotJson.scripts = packageDotJson.scripts || {};
  packageDotJson.scripts[SENTRY_NPM_SCRIPT_NAME] = sentryCliNpmScript;

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
 *
 * @param packageDotJson The package.json which will be modified.
 */
export async function addSentryCommandToBuildCommand(): Promise<void> {
  const packageDotJson = await getPackageDotJson();
  // This usually shouldn't happen because earlier we added the
  // SENTRY_NPM_SCRIPT_NAME script but just to be sure
  packageDotJson.scripts = packageDotJson.scripts || {};

  const allNpmScripts = Object.keys(packageDotJson.scripts).filter(
    (s) => s !== SENTRY_NPM_SCRIPT_NAME,
  );

  const packageManager = await getPackageManager(NPM);

  // Heuristic to pre-select the build command:
  // Often, 'build' is the prod build command, so we favour it.
  // If it's not there, commands that include 'build' might be the prod build command.
  let buildCommand =
    typeof packageDotJson.scripts["build"] === "string"
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

  const oldCommand = packageDotJson.scripts[buildCommand];
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

  packageDotJson.scripts[buildCommand] = newCommand;

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
