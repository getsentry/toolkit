/**
 * Shared prompts and project helpers of the setup wizards: aborting, git
 * checks, package installs, Sentry CLI config files, formatters, and
 * copy/paste instructions. Ported from sentry-wizard's `src/utils/clack`.
 *
 * The wizards never exit the process: {@link abort} and
 * {@link abortIfCancelled} throw a {@link WizardExitError}, which
 * `sentry wizard` turns into its exit code.
 */

import { execSync, spawn } from "node:child_process";
import {
  accessSync,
  existsSync,
  promises,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path, { basename, dirname, isAbsolute, join, relative } from "node:path";
import chalk from "chalk";
import { gte, minVersion, validRange } from "semver";
import { sentry } from "../../../app-identity.js";
import { CLI_VERSION } from "../../../constants.js";
import { reportCliError } from "../../../error-reporting.js";
import { WizardExitError } from "../../../errors.js";
import { Sentry, traceStep } from "../../telemetry.js";
import { debug } from "../debug.js";
import { getUncommittedOrUntrackedFilePaths, isInGitRepo } from "../git.js";
import {
  getPackageVersion,
  hasPackageInstalled,
  type PackageDotJson,
} from "../package-json.js";
import {
  _detectPackageManger,
  NPM,
  type PackageManager,
  packageManagers,
} from "../package-manager.js";
import { fulfillsVersionRange } from "../semver.js";
import type { Feature } from "../types.js";
import { clack } from "./prompts.js";

export { getOrAskForProjectData } from "../project-data.js";

export const SENTRY_DOT_ENV_FILE = ".env.sentry-build-plugin";
export const SENTRY_CLI_RC_FILE = ".sentryclirc";
export const SENTRY_PROPERTIES_FILE = "sentry.properties";

export interface CliSetupConfig {
  filename: string;
  name: string;
  gitignore: boolean;

  likelyAlreadyHasAuthToken(contents: string): boolean;
  tokenContent(authToken: string): string;

  likelyAlreadyHasOrgAndProject(contents: string): boolean;
  orgAndProjContent(org: string, project: string): string;

  likelyAlreadyHasUrl?(contents: string): boolean;
  urlContent?(url: string): string;
}

export interface CliSetupConfigContent {
  authToken: string;
  org?: string | undefined;
  project?: string | undefined;
  url?: string | undefined;
}

export const rcCliSetupConfig: CliSetupConfig = {
  filename: SENTRY_CLI_RC_FILE,
  name: "source maps",
  gitignore: true,
  likelyAlreadyHasAuthToken: function (contents: string): boolean {
    return !!(contents.includes("[auth]") && contents.match(/token=./g));
  },
  tokenContent: function (authToken: string): string {
    return `[auth]\ntoken=${authToken}`;
  },
  likelyAlreadyHasOrgAndProject: function (contents: string): boolean {
    return !!(
      contents.includes("[defaults]") &&
      contents.match(/org=./g) &&
      contents.match(/project=./g)
    );
  },
  orgAndProjContent: function (org: string, project: string): string {
    return `[defaults]\norg=${org}\nproject=${project}`;
  },
};

export const propertiesCliSetupConfig: Required<CliSetupConfig> = {
  filename: SENTRY_PROPERTIES_FILE,
  gitignore: true,
  name: "debug files",
  likelyAlreadyHasAuthToken(contents: string): boolean {
    return !!contents.match(/auth\.token=./g);
  },
  tokenContent(authToken: string): string {
    return `auth.token=${authToken}`;
  },
  likelyAlreadyHasOrgAndProject(contents: string): boolean {
    return !!(
      contents.match(/defaults\.org=./g) &&
      contents.match(/defaults\.project=./g)
    );
  },
  orgAndProjContent(org: string, project: string): string {
    return `defaults.org=${org}\ndefaults.project=${project}`;
  },
  likelyAlreadyHasUrl(contents: string): boolean {
    return !!contents.match(/defaults\.url=./g);
  },
  urlContent(url: string): string {
    return `defaults.url=${url}`;
  },
};

/**
 * Stop the wizard with `message`. `status` 0 means the user chose to stop;
 * anything else is a failure. Throws, so code after it never runs.
 *
 * @param message - Shown as the outro. Defaults to "Wizard setup cancelled."
 * @param status - Exit code of `sentry wizard`. Defaults to 1.
 */
export async function abort(message?: string, status?: number): Promise<never> {
  clack.outro(message ?? "Wizard setup cancelled.");
  Sentry.setTag("wizard.outcome", status === 0 ? "cancelled" : "aborted");
  throw new WizardExitError(status ?? 1);
}

/**
 * Resolve `input`, or stop the wizard with exit code 0 when the user
 * cancelled the prompt (Ctrl+C).
 */
export async function abortIfCancelled<T>(
  input: T | Promise<T>,
): Promise<Exclude<T, symbol>> {
  const value = await input;
  if (clack.isCancel(value)) {
    clack.cancel("Wizard setup cancelled.");
    Sentry.setTag("wizard.outcome", "cancelled");
    throw new WizardExitError(0);
  }
  return value as Exclude<T, symbol>;
}

/** Print the intro banner and welcome note of a wizard. */
export function printWelcome(options: {
  wizardName: string;
  promoCode?: string | undefined;
  message?: string | undefined;
  telemetryEnabled?: boolean | undefined;
}): void {
  clack.rawOutput("");
  clack.intro(chalk.inverse(` ${options.wizardName} `));

  let welcomeText =
    options.message ||
    `The ${options.wizardName} will help you set up Sentry for your application.\nThank you for using Sentry :)`;

  if (options.promoCode) {
    welcomeText = `${welcomeText}\n\nUsing promo-code: ${options.promoCode}`;
  }

  welcomeText = `${welcomeText}\n\nVersion: ${CLI_VERSION}`;

  if (options.telemetryEnabled) {
    welcomeText = `${welcomeText}

This wizard sends telemetry data and crash reports to Sentry. This helps us improve the Wizard.
You can turn this off at any time by running ${chalk.cyanBright(
      sentry`wizard --disable-telemetry`,
    )}.`;
  }

  clack.note(welcomeText);
}

/**
 * Confirms if the user wants to continue with the wizard if the project is not a git repository.
 *
 * @param options.ignoreGitChanges If true, the wizard will not check if the project is a git repository.
 * @param options.cwd The directory of the project. If undefined, the current process working directory will be used.
 */
export async function confirmContinueIfNoOrDirtyGitRepo({
  ignoreGitChanges,
  cwd,
  nonInteractive = false,
}: {
  ignoreGitChanges: boolean | undefined;
  cwd: string | undefined;
  nonInteractive?: boolean | undefined;
}): Promise<void> {
  return await traceStep("check-git-status", async () => {
    if (
      !isInGitRepo({
        cwd: cwd,
      }) &&
      ignoreGitChanges !== true
    ) {
      if (nonInteractive) {
        clack.log.error(
          "Project is not inside a git repository in non-interactive mode. Run from a git repository or pass --ignore-git-changes to skip this safety check.",
        );
        Sentry.setTag("continue-without-git", false);
        await abort();
      }

      const continueWithoutGit = await abortIfCancelled(
        clack.confirm({
          message:
            "You are not inside a git repository. The wizard will create and update files. Do you want to continue anyway?",
        }),
      );

      Sentry.setTag("continue-without-git", continueWithoutGit);

      if (!continueWithoutGit) {
        await abort(undefined, 0);
      }
      // return early to avoid checking for uncommitted files
      return;
    }

    const uncommittedOrUntrackedFilePaths = getUncommittedOrUntrackedFilePaths({
      cwd: cwd,
    });

    if (uncommittedOrUntrackedFilePaths.length && ignoreGitChanges !== true) {
      clack.log.warn(
        `You have uncommitted or untracked files in your repo:

${uncommittedOrUntrackedFilePaths.map((file) => `- ${file}`).join("\n")}

The wizard will create and update files.`,
      );

      if (nonInteractive) {
        clack.log.error(
          "Project has uncommitted or untracked files in non-interactive mode. Commit or stash your changes, or pass --ignore-git-changes to skip this safety check.",
        );
        Sentry.setTag("continue-with-dirty-repo", false);
        await abort();
      }

      const continueWithDirtyRepo = await abortIfCancelled(
        clack.confirm({
          message: "Do you want to continue anyway?",
        }),
      );

      Sentry.setTag("continue-with-dirty-repo", continueWithDirtyRepo);

      if (!continueWithDirtyRepo) {
        await abort(undefined, 0);
      }
    }
  });
}

export async function askToInstallSentryCLI(): Promise<boolean> {
  return await abortIfCancelled(
    clack.confirm({
      message:
        "You don't have Sentry CLI installed. Do you want to install it?",
    }),
  );
}

export async function askForItemSelection(
  items: string[],
  message: string,
): Promise<{ value: string; index: number }> {
  const selection: { value: string; index: number } | symbol =
    await abortIfCancelled(
      clack.select({
        maxItems: 12,
        message: message,
        options: items.map((item, index) => {
          return {
            value: { value: item, index: index },
            label: item,
          };
        }),
      }),
    );

  return selection;
}

export async function confirmContinueIfPackageVersionNotSupported({
  packageId,
  packageName,
  packageVersion,
  acceptableVersions,
  note,
}: {
  packageId: string;
  packageName: string;
  packageVersion: string;
  acceptableVersions: string;
  note?: string | undefined;
}): Promise<void> {
  return await traceStep(`check-package-version`, async () => {
    Sentry.setTag(`${packageName.toLowerCase()}-version`, packageVersion);
    const isSupportedVersion = fulfillsVersionRange({
      acceptableVersions,
      version: packageVersion,
      canBeLatest: true,
    });

    if (isSupportedVersion) {
      Sentry.setTag(`${packageName.toLowerCase()}-supported`, true);
      return;
    }

    clack.log.warn(
      `You have an unsupported version of ${packageName} installed:

  ${packageId}@${packageVersion}`,
    );

    clack.note(
      note ??
        `Please upgrade to ${acceptableVersions} if you wish to use the Sentry Wizard.`,
    );
    const continueWithUnsupportedVersion = await abortIfCancelled(
      clack.confirm({
        message: "Do you want to continue anyway?",
      }),
    );
    Sentry.setTag(
      `${packageName.toLowerCase()}-continue-with-unsupported-version`,
      continueWithUnsupportedVersion,
    );

    if (!continueWithUnsupportedVersion) {
      await abort(undefined, 0);
    }
  });
}

const JS_SDK_V11_MIGRATION_GUIDE_URL =
  "https://docs.sentry.io/platforms/javascript/migration/v10-to-v11/";

/** Docs guide slugs of the SDKs that have a platform-specific migration guide. */
const JS_SDK_V11_MIGRATION_GUIDE_SLUGS: Record<string, string> = {
  "@sentry/angular": "angular",
  "@sentry/cloudflare": "cloudflare",
  "@sentry/nextjs": "nextjs",
  "@sentry/nuxt": "nuxt",
  "@sentry/react-router": "react-router",
  "@sentry/remix": "remix",
  "@sentry/sveltekit": "sveltekit",
};

function getSdkV11MigrationGuideUrl(packageName: string): string {
  const slug = JS_SDK_V11_MIGRATION_GUIDE_SLUGS[packageName];

  return slug
    ? `https://docs.sentry.io/platforms/javascript/guides/${slug}/migration/v10-to-v11/`
    : JS_SDK_V11_MIGRATION_GUIDE_URL;
}

/**
 * Logs a link to the v10 to v11 migration guide if @param packageName is
 * already installed at a version below v11. The wizard updates the SDK to v11,
 * which contains breaking changes the user must apply to their code.
 */
export function printSdkV11MigrationGuideIfOutdated(
  packageName: string,
  packageJson: PackageDotJson,
): void {
  const installedRange = getPackageVersion(packageName, packageJson);
  const installedVersion =
    installedRange && validRange(installedRange)
      ? minVersion(installedRange)
      : null;

  if (!installedVersion || gte(installedVersion, "11.0.0")) {
    return;
  }

  clack.log.warn(
    `The wizard updates ${chalk.cyan(
      packageName,
    )} to version 11, which has ${chalk.bold("breaking changes")}.
Follow the migration guide to update your code: ${chalk.cyan(
      getSdkV11MigrationGuideUrl(packageName),
    )}`,
  );
}

type InstallPackageOptions = {
  /** The string that is passed to the package manager CLI as identifier to install (e.g. `@sentry/nextjs`, or `@sentry/nextjs@^8`) */
  packageName: string;
  alreadyInstalled: boolean;
  askBeforeUpdating?: boolean | undefined;
  /** Overrides what is shown in the installation logs in place of the `packageName` option. Useful if the `packageName` is ugly (e.g. `@sentry/nextjs@^8`) */
  packageNameDisplayLabel?: string | undefined;
  packageManager?: PackageManager | undefined;
  /** Add force install flag to command to skip install precondition fails */
  forceInstall?: boolean | undefined;
  /** Install as a dev dependency (@default: false) */
  devDependency?: boolean | undefined;
};

/**
 * Installs or updates a package with the user's package manager.
 *
 * IMPORTANT: This function modifies the `package.json`! Be sure to re-read
 * it if you make additional modifications to it after calling this function!
 */
export async function installPackage({
  packageName,
  alreadyInstalled,
  askBeforeUpdating = true,
  packageNameDisplayLabel,
  packageManager,
  forceInstall = false,
  devDependency = false,
}: InstallPackageOptions): Promise<{ packageManager?: PackageManager }> {
  return await traceStep("install-package", async () => {
    if (alreadyInstalled && askBeforeUpdating) {
      const shouldUpdatePackage = await abortIfCancelled(
        clack.confirm({
          message: `The ${chalk.bold.cyan(
            packageNameDisplayLabel ?? packageName,
          )} package is already installed. Do you want to update it to the latest version?`,
        }),
      );

      if (!shouldUpdatePackage) {
        return {};
      }
    }

    const sdkInstallSpinner = clack.spinner();

    const pkgManager = packageManager || (await getPackageManager());

    if (pkgManager.name === "pnpm") {
      clack.log.info(
        `If you use pnpm 11, dependency build scripts require explicit approval. If installation fails with ${chalk.cyan(
          "ERR_PNPM_IGNORED_BUILDS",
        )}, review the pending packages, run ${chalk.cyan(
          "pnpm approve-builds",
        )}, and then rerun the wizard.`,
      );
    }

    sdkInstallSpinner.start(
      `${alreadyInstalled ? "Updating" : "Installing"} ${chalk.bold.cyan(
        packageNameDisplayLabel ?? packageName,
      )} with ${chalk.bold(pkgManager.label)}.`,
    );

    try {
      await new Promise<void>((resolve, reject) => {
        const installArgs = [
          pkgManager.installCommand,
          ...(devDependency ? ["-D"] : []),
          pkgManager.registry
            ? `${pkgManager.registry}:${packageName}`
            : packageName,
          ...(pkgManager.flags ? pkgManager.flags.split(" ") : []),
          ...(forceInstall ? [pkgManager.forceInstallFlag] : []),
        ];

        const stringifiedInstallCmd = `${pkgManager.name} ${installArgs.join(
          " ",
        )}`;

        function handleErrorAndReject(
          code: number | null,
          cause: Error | string,
          type: "spawn_error" | "process_error",
        ) {
          const output = [stdout, stderr].filter(Boolean).join("\n");
          // Write a log file so we can better troubleshoot issues
          writeFileSync(
            join(
              process.cwd(),
              `sentry-wizard-installation-error-${Date.now()}.log`,
            ),
            output,
            { encoding: "utf8" },
          );

          reportCliError(new Error("Package Installation Error"), {
            tags: {
              "install-command": stringifiedInstallCmd,
              "package-manager": pkgManager.name,
              "package-name": packageName,
              "error-type": type,
            },
          });

          reject(
            new Error(
              `Installation command ${chalk.cyan(
                stringifiedInstallCmd,
              )} exited with code ${code ?? "null"}.`,
              {
                cause,
              },
            ),
          );
        }

        const installProcess = spawn(pkgManager.name, installArgs, {
          shell: true,
          // Ignoring Yarn `stdout` to prevent certain node + yarn v4 (observed on ubuntu + snap)
          // combinations from crashing here. See #851
          stdio: [
            "pipe",
            pkgManager.name === "yarn" ? "ignore" : "pipe",
            "pipe",
          ],
        });

        let stdout = "";
        let stderr = "";

        // Defining data as unknown to avoid TS and ESLint errors because of `any` type
        installProcess.stdout?.on("data", (data: unknown) => {
          stdout += String(data);
        });
        installProcess.stderr?.on("data", (data: unknown) => {
          stderr += String(data);
        });

        installProcess.on("error", (err) => {
          handleErrorAndReject(null, err, "spawn_error");
        });

        installProcess.on("close", (code) => {
          if (code !== 0) {
            handleErrorAndReject(code, stderr, "process_error");
          } else {
            resolve();
          }
        });
      });
    } catch (e) {
      sdkInstallSpinner.stop("Installation failed.");
      clack.log.error(
        `${chalk.red(
          "Encountered the following error during installation:",
        )}\n\n${String(e)}\n\n${chalk.dim(
          "The wizard has created a `sentry-wizard-installation-error-*.log` file. Review it for sensitive information before sharing it. If you think this issue is caused by the Sentry wizard, create an issue on GitHub and include the redacted log file's content:\nhttps://github.com/getsentry/toolkit/issues",
        )}`,
      );
      await abort();
    }

    sdkInstallSpinner.stop(
      `${alreadyInstalled ? "Updated" : "Installed"} ${chalk.bold.cyan(
        packageNameDisplayLabel ?? packageName,
      )} with ${chalk.bold(pkgManager.label)}.`,
    );

    return { packageManager: pkgManager };
  });
}

export async function addSentryCliConfig(
  { authToken, org, project, url }: CliSetupConfigContent,
  setupConfig: CliSetupConfig = rcCliSetupConfig,
): Promise<void> {
  return await traceStep("add-sentry-cli-config", async () => {
    const configPath = join(process.cwd(), setupConfig.filename);
    const configExists = existsSync(configPath);

    let configContents =
      (configExists && readFileSync(configPath, "utf8")) || "";
    configContents = addAuthTokenToSentryConfig(
      configContents,
      authToken,
      setupConfig,
    );
    configContents = addOrgAndProjectToSentryConfig(
      configContents,
      org,
      project,
      setupConfig,
    );
    configContents = addUrlToSentryConfig(configContents, url, setupConfig);

    try {
      await promises.writeFile(configPath, configContents, {
        encoding: "utf8",
        flag: "w",
      });
      clack.log.success(
        `${configExists ? "Saved" : "Created"} ${chalk.cyan(
          setupConfig.filename,
        )}.`,
      );
    } catch {
      clack.log.warning(
        `Failed to add auth token to ${chalk.cyan(
          setupConfig.filename,
        )}. Uploading ${
          setupConfig.name
        } during build will likely not work locally.`,
      );
    }

    if (setupConfig.gitignore) {
      await addCliConfigFileToGitIgnore(setupConfig.filename);
    } else {
      clack.log.warn(
        chalk.yellow("DO NOT commit auth token to your repository!"),
      );
    }
  });
}

function addAuthTokenToSentryConfig(
  configContents: string,
  authToken: string | undefined,
  setupConfig: CliSetupConfig,
): string {
  if (!authToken) {
    return configContents;
  }

  if (setupConfig.likelyAlreadyHasAuthToken(configContents)) {
    clack.log.warn(
      `${chalk.cyan(
        setupConfig.filename,
      )} already has auth token. Will not add one.`,
    );
    return configContents;
  }

  const newContents = `${configContents}\n${setupConfig.tokenContent(
    authToken,
  )}\n`;
  clack.log.success(
    `Added auth token to ${chalk.cyan(
      setupConfig.filename,
    )} for you to test uploading ${setupConfig.name} locally.`,
  );
  return newContents;
}

function addOrgAndProjectToSentryConfig(
  configContents: string,
  org: string | undefined,
  project: string | undefined,
  setupConfig: CliSetupConfig,
): string {
  if (!org || !project) {
    return configContents;
  }

  if (setupConfig.likelyAlreadyHasOrgAndProject(configContents)) {
    clack.log.warn(
      `${chalk.cyan(
        setupConfig.filename,
      )} already has org and project. Will not add them.`,
    );
    return configContents;
  }

  const newContents = `${configContents}\n${setupConfig.orgAndProjContent(
    org,
    project,
  )}\n`;
  clack.log.success(
    `Added default org and project to ${chalk.cyan(
      setupConfig.filename,
    )} for you to test uploading ${setupConfig.name} locally.`,
  );
  return newContents;
}

function addUrlToSentryConfig(
  configContents: string,
  url: string | undefined,
  setupConfig: CliSetupConfig,
): string {
  if (!url || !setupConfig.urlContent || !setupConfig.likelyAlreadyHasUrl) {
    return configContents;
  }

  if (setupConfig.likelyAlreadyHasUrl(configContents)) {
    clack.log.warn(
      `${chalk.cyan(setupConfig.filename)} already has url. Will not add one.`,
    );
    return configContents;
  }

  const newContents = `${configContents}\n${setupConfig.urlContent(url)}\n`;
  clack.log.success(
    `Added default url to ${chalk.cyan(
      setupConfig.filename,
    )} for you to test uploading ${setupConfig.name} locally.`,
  );
  return newContents;
}

export async function addDotEnvSentryBuildPluginFile(
  authToken: string,
): Promise<void> {
  const envVarContent = `# DO NOT commit this file to your repository!
# The SENTRY_AUTH_TOKEN variable is picked up by the Sentry Build Plugin.
# It's used for authentication when uploading source maps.
# You can also set this env variable in your own \`.env\` files and remove this file.
SENTRY_AUTH_TOKEN=${authToken}
`;

  const dotEnvFilePath = join(process.cwd(), SENTRY_DOT_ENV_FILE);
  const dotEnvFileExists = existsSync(dotEnvFilePath);

  if (dotEnvFileExists) {
    const dotEnvFileContent = readFileSync(dotEnvFilePath, "utf8");

    const hasAuthToken = !!dotEnvFileContent.match(
      /^\s*SENTRY_AUTH_TOKEN\s*=/g,
    );

    if (hasAuthToken) {
      clack.log.warn(
        `${chalk.bold.cyan(
          SENTRY_DOT_ENV_FILE,
        )} already has auth token. Will not add one.`,
      );
    } else {
      try {
        await promises.writeFile(
          dotEnvFilePath,
          `${dotEnvFileContent}\n${envVarContent}`,
          {
            encoding: "utf8",
            flag: "w",
          },
        );
        clack.log.success(
          `Added auth token to ${chalk.bold.cyan(SENTRY_DOT_ENV_FILE)}`,
        );
      } catch {
        clack.log.warning(
          `Failed to add auth token to ${chalk.bold.cyan(
            SENTRY_DOT_ENV_FILE,
          )}. Uploading source maps during build will likely not work locally.`,
        );
      }
    }
  } else {
    try {
      await promises.writeFile(dotEnvFilePath, envVarContent, {
        encoding: "utf8",
        flag: "w",
      });
      clack.log.success(
        `Created ${chalk.bold.cyan(
          SENTRY_DOT_ENV_FILE,
        )} with auth token for you to test source map uploading locally.`,
      );
    } catch {
      clack.log.warning(
        `Failed to create ${chalk.bold.cyan(
          SENTRY_DOT_ENV_FILE,
        )} with auth token. Uploading source maps during build will likely not work locally.`,
      );
    }
  }

  await addCliConfigFileToGitIgnore(SENTRY_DOT_ENV_FILE);
}

async function addCliConfigFileToGitIgnore(filename: string): Promise<void> {
  const gitignorePath = join(process.cwd(), ".gitignore");

  try {
    const gitignoreContent = await promises.readFile(gitignorePath, "utf8");
    if (gitignoreContent.split(/\r?\n/).includes(filename)) {
      clack.log.info(
        `${chalk.bold(".gitignore")} already has ${chalk.bold(
          filename,
        )}. Will not add it again.`,
      );
      return;
    }

    await promises.appendFile(
      gitignorePath,
      `\n# Sentry Config File\n${filename}\n`,
      { encoding: "utf8" },
    );
    clack.log.success(
      `Added ${chalk.cyan(filename)} to ${chalk.cyan(".gitignore")}.`,
    );
  } catch {
    clack.log.error(
      `Failed adding ${chalk.cyan(filename)} to ${chalk.cyan(
        ".gitignore",
      )}. Please add it manually!`,
    );
  }
}

/**
 * Returns the changed or untracked files for the formatter step, or null if not
 * in a git repo or nothing changed.
 */
function getFormatterTargetFiles(): string[] | null {
  if (!isInGitRepo({ cwd: undefined })) {
    return null;
  }

  const changedOrUntrackedFiles =
    getUncommittedOrUntrackedFilePaths().filter(Boolean);

  return changedOrUntrackedFiles.length ? changedOrUntrackedFiles : null;
}

/** Resolves a package's bin entry point from the target project, or null. */
function resolveFormatterBinary(
  packageName: string,
  binName: string,
): string | null {
  const requireFromProject = createRequire(join(process.cwd(), "package.json"));

  const packageJsonCandidates: string[] = [];
  try {
    packageJsonCandidates.push(
      requireFromProject.resolve(`${packageName}/package.json`),
    );
  } catch (error) {
    debug(error);
    // Package may not expose package.json via exports; fall through.
  }
  packageJsonCandidates.push(
    join(process.cwd(), "node_modules", packageName, "package.json"),
  );

  for (const packageJsonPath of packageJsonCandidates) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
        bin?: string | Record<string, string> | undefined;
      };
      const relativeBin =
        typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[binName];
      if (relativeBin) {
        return join(dirname(packageJsonPath), relativeBin);
      }
    } catch (error) {
      debug(error);
      // Try the next candidate.
    }
  }

  return null;
}

/**
 * Runs a formatter without passing file names through a shell (command
 * injection) and with a `--` separator (option injection). POSIX runs `npx`
 * directly; Windows resolves the bin and runs it via Node, since `npx.cmd`
 * would otherwise need a shell.
 *
 * @param packageName The npm package that provides the formatter.
 * @param binName The bin entry to run from that package (Windows only).
 * @param subArgs The formatter flags and subcommands.
 * @param files The file paths to format.
 * @param options.ignoreExitCode When true, a non-zero exit or unresolved binary resolves instead of rejecting.
 */
function runFormatterCommand(
  packageName: string,
  binName: string,
  subArgs: string[],
  files: string[],
  { ignoreExitCode }: { ignoreExitCode: boolean },
): Promise<void> {
  let command: string;
  let args: string[];

  if (process.platform === "win32") {
    const binPath = resolveFormatterBinary(packageName, binName);
    if (!binPath) {
      return ignoreExitCode
        ? Promise.resolve()
        : Promise.reject(
            new Error(`Could not resolve the ${packageName} binary.`),
          );
    }
    command = process.execPath;
    args = [binPath, ...subArgs, "--", ...files];
  } else {
    command = "npx";
    args = [packageName, ...subArgs, "--", ...files];
  }

  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: "ignore",
    });

    child.on("error", (err) => {
      if (ignoreExitCode) {
        resolve();
      } else {
        reject(err);
      }
    });

    child.on("close", (code) => {
      if (code !== 0 && !ignoreExitCode) {
        reject(new Error(`Formatter exited with code ${code ?? "null"}.`));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Runs available formatters (Prettier and/or Biome) on the changed or untracked files in the project.
 * This function provides a unified interface for running multiple formatters with a single user prompt.
 *
 * @param _opts The directory of the project. If undefined, the current process working directory will be used.
 */
export async function runFormatters(_opts: {
  cwd: string | undefined;
}): Promise<void> {
  return await traceStep("run-formatters", async () => {
    const targetFiles = getFormatterTargetFiles();
    if (!targetFiles) {
      return;
    }

    const packageJson = await getPackageDotJson();
    const prettierInstalled = hasPackageInstalled("prettier", packageJson);
    const biomeInstalled = hasPackageInstalled("@biomejs/biome", packageJson);

    Sentry.setTag("prettier-installed", prettierInstalled);
    Sentry.setTag("biome-installed", biomeInstalled);

    if (!prettierInstalled && !biomeInstalled) {
      return;
    }

    // Determine prompt message based on what's installed
    const formattersAvailable = [];
    if (prettierInstalled) formattersAvailable.push("Prettier");
    if (biomeInstalled) formattersAvailable.push("Biome");

    const message =
      formattersAvailable.length === 1
        ? `Looks like you have ${formattersAvailable[0]} in your project. Do you want to run it on your files?`
        : `Looks like you have ${formattersAvailable.join(
            " and ",
          )} in your project. Do you want to run them on your files?`;

    const shouldRun = await abortIfCancelled(clack.confirm({ message }));

    if (!shouldRun) {
      return;
    }

    const spinner = clack.spinner();
    spinner.start("Running formatters on your files.");

    try {
      // Run Prettier first if installed (handles general formatting)
      if (prettierInstalled) {
        await runFormatterCommand(
          "prettier",
          "prettier",
          ["--ignore-unknown", "--write"],
          targetFiles,
          { ignoreExitCode: false },
        );
      }

      // Run Biome if installed (handles linting + additional formatting)
      if (biomeInstalled) {
        // Format first
        await runFormatterCommand(
          "@biomejs/biome",
          "biome",
          ["format", "--write"],
          targetFiles,
          // Ignore errors, just continue
          { ignoreExitCode: true },
        );

        // Then lint with fixes (using --unsafe for auto-fixable issues)
        // See: https://biomejs.dev/linter/#unsafe-fixes
        // The --unsafe flag applies potentially behavior-changing fixes like removing unused imports.
        // This is acceptable for wizard-generated code which may have fixable issues.
        await runFormatterCommand(
          "@biomejs/biome",
          "biome",
          ["check", "--write", "--unsafe"],
          targetFiles,
          // Ignore errors, Biome exits non-zero if there are remaining issues
          { ignoreExitCode: true },
        );
      }

      spinner.stop("Formatters have processed your files.");
    } catch (e) {
      spinner.stop("Formatting encountered an issue.");
      clack.log.warn(
        "Formatting encountered an issue. There may be formatting or linting issues in your updated files.",
      );
    }
  });
}

/**
 * Runs prettier on the changed or untracked files in the project.
 *
 * @param options.cwd The directory of the project. If undefined, the current process working directory will be used.
 */
export async function runPrettierIfInstalled(_opts: {
  cwd: string | undefined;
}): Promise<void> {
  return await traceStep("run-prettier", async () => {
    const changedOrUntrackedFiles = getFormatterTargetFiles();
    if (!changedOrUntrackedFiles) {
      return;
    }

    const packageJson = await getPackageDotJson();
    const prettierInstalled = hasPackageInstalled("prettier", packageJson);

    Sentry.setTag("prettier-installed", prettierInstalled);

    if (!prettierInstalled) {
      return;
    }

    // prompt the user if they want to run prettier
    const shouldRunPrettier = await abortIfCancelled(
      clack.confirm({
        message:
          "Looks like you have Prettier in your project. Do you want to run it on your files?",
      }),
    );

    if (!shouldRunPrettier) {
      return;
    }

    const prettierSpinner = clack.spinner();
    prettierSpinner.start("Running Prettier on your files.");

    try {
      await runFormatterCommand(
        "prettier",
        "prettier",
        ["--ignore-unknown", "--write"],
        changedOrUntrackedFiles,
        { ignoreExitCode: false },
      );
    } catch (e) {
      prettierSpinner.stop("Prettier failed to run.");
      clack.log.warn(
        "Prettier failed to run. There may be formatting issues in your updated files.",
      );
      return;
    }

    prettierSpinner.stop("Prettier has formatted your files.");
  });
}

/**
 * Runs Biome on the changed or untracked files in the project.
 *
 * @param options.cwd The directory of the project. If undefined, the current process working directory will be used.
 */
export async function runBiomeIfInstalled(_opts: {
  cwd: string | undefined;
}): Promise<void> {
  return await traceStep("run-biome", async () => {
    const changedOrUntrackedFiles = getFormatterTargetFiles();
    if (!changedOrUntrackedFiles) {
      return;
    }

    const packageJson = await getPackageDotJson();
    const biomeInstalled = hasPackageInstalled("@biomejs/biome", packageJson);

    Sentry.setTag("biome-installed", biomeInstalled);

    if (!biomeInstalled) {
      return;
    }

    // prompt the user if they want to run biome
    const shouldRunBiome = await abortIfCancelled(
      clack.confirm({
        message:
          "Looks like you have Biome in your project. Do you want to run it on your files?",
      }),
    );

    if (!shouldRunBiome) {
      return;
    }

    const biomeSpinner = clack.spinner();
    biomeSpinner.start("Running Biome on your files.");

    try {
      // Use biome format --write for formatting (always succeeds if it can format)
      // Then biome check --write for lint fixes
      // We ignore exit codes because Biome exits non-zero if there are unfixable issues
      await runFormatterCommand(
        "@biomejs/biome",
        "biome",
        ["format", "--write"],
        changedOrUntrackedFiles,
        // Ignore errors, just continue
        { ignoreExitCode: true },
      );

      await runFormatterCommand(
        "@biomejs/biome",
        "biome",
        ["check", "--write", "--unsafe"],
        changedOrUntrackedFiles,
        // Ignore errors, Biome exits non-zero if there are remaining issues
        { ignoreExitCode: true },
      );
    } catch (e) {
      biomeSpinner.stop("Biome encountered an issue.");
      clack.log.warn(
        "Biome encountered an issue. There may be formatting or linting issues in your updated files.",
      );
      return;
    }

    biomeSpinner.stop("Biome has formatted your files.");
  });
}

/**
 * Checks if @param packageId is listed as a dependency in @param packageJson.
 * If not, it will ask users if they want to continue without the package.
 *
 * Use this function to check if e.g. a the framework of the SDK is installed
 *
 * @param packageJson the package.json object
 * @param packageId the npm name of the package
 * @param packageName a human readable name of the package
 */
export async function ensurePackageIsInstalled(
  packageJson: PackageDotJson,
  packageId: string,
  packageName: string,
): Promise<void> {
  return await traceStep("ensure-package-installed", async () => {
    const installed = hasPackageInstalled(packageId, packageJson);

    Sentry.setTag(`${packageName.toLowerCase()}-installed`, installed);

    if (!installed) {
      Sentry.setTag(`${packageName.toLowerCase()}-installed`, false);
      const continueWithoutPackage = await abortIfCancelled(
        clack.confirm({
          message: `${packageName} does not seem to be installed. Do you still want to continue?`,
          initialValue: false,
        }),
      );

      if (!continueWithoutPackage) {
        await abort(undefined, 0);
      }
    }
  });
}

export async function getPackageDotJson(): Promise<PackageDotJson> {
  const packageJsonFileContents = await promises
    .readFile(join(process.cwd(), "package.json"), "utf8")
    .catch(() => {
      clack.log.error(
        "Could not find package.json. Make sure to run the wizard in the root of your app!",
      );
      return abort();
    });

  let packageJson: PackageDotJson | undefined = undefined;

  try {
    packageJson = JSON.parse(packageJsonFileContents);
  } catch {
    clack.log.error(
      `Unable to parse your ${chalk.cyan(
        "package.json",
      )}. Make sure it has a valid format!`,
    );

    await abort();
  }

  return packageJson || {};
}

export async function updatePackageDotJson(
  packageDotJson: PackageDotJson,
): Promise<void> {
  try {
    await promises.writeFile(
      join(process.cwd(), "package.json"),
      // TODO: maybe figure out the original indentation
      JSON.stringify(packageDotJson, null, 2),
      {
        encoding: "utf8",
        flag: "w",
      },
    );
  } catch {
    clack.log.error(`Unable to update your ${chalk.cyan("package.json")}.`);

    await abort();
  }
}

/**
 * Use this function to get the used JS Package manager.
 *
 * This function:
 * - attempts to auto-detect the used package manager and return it
 * - if unsuccessful, returns the passed fallback package manager
 * - if no fallback is passed, it asks the user to select a package manager
 *
 * The result is cached on the first invocation to avoid asking the user multiple times.
 *
 * @param fallback the package manager to use if auto-detection fails and you don't want to
 * ask the user. This is useful in cases where asking users would be too intrusive/low in value
 * and where it's okay to fall back to a default package manager. Use this with caution.
 */
export async function getPackageManager(
  fallback?: PackageManager,
): Promise<PackageManager> {
  const globalWithSentryWizard: typeof global & {
    __sentry_wizard_cached_package_manager?: PackageManager | undefined;
  } = global;

  if (globalWithSentryWizard.__sentry_wizard_cached_package_manager) {
    return globalWithSentryWizard.__sentry_wizard_cached_package_manager;
  }

  const detectedPackageManager = _detectPackageManger();

  if (detectedPackageManager) {
    globalWithSentryWizard.__sentry_wizard_cached_package_manager =
      detectedPackageManager;
    return detectedPackageManager;
  }

  if (fallback) {
    // explicitly avoiding to cache the fallback in case this function
    // gets called again without a fallback (or a different fallback)
    // later on in the wizard flow.
    return fallback;
  }

  const selectedPackageManager: PackageManager | symbol =
    await abortIfCancelled(
      clack.select({
        message: "Please select your package manager.",
        options: packageManagers.map((packageManager) => ({
          value: packageManager,
          label: packageManager.label,
        })),
      }),
    );

  globalWithSentryWizard.__sentry_wizard_cached_package_manager =
    selectedPackageManager;

  Sentry.setTag("package-manager", selectedPackageManager.name);

  return selectedPackageManager;
}

export function isUsingTypeScript() {
  try {
    return existsSync(join(process.cwd(), "tsconfig.json"));
  } catch (error) {
    debug(error);
    return false;
  }
}

/**
 * Asks users if they have a config file for @param tool (e.g. Vite).
 * If yes, asks users to specify the path to their config file.
 *
 * Use this helper function as a fallback mechanism if the lookup for
 * a config file with its most usual location/name fails.
 *
 * @param toolName Name of the tool for which we're looking for the config file
 * @param configFileName Name of the most common config file name (e.g. vite.config.js)
 *
 * @returns a user path to the config file or undefined if the user doesn't have a config file
 */
export async function askForToolConfigPath(
  toolName: string,
  configFileName: string,
): Promise<string | undefined> {
  const hasConfig = await abortIfCancelled(
    clack.confirm({
      message: `Do you have a ${toolName} config file (e.g. ${chalk.cyan(
        configFileName,
      )})?`,
      initialValue: true,
    }),
  );

  if (!hasConfig) {
    return undefined;
  }

  return await abortIfCancelled(
    clack.text({
      message: `Please enter the path to your ${toolName} config file:`,
      placeholder: join(".", configFileName),
      validate: (value) => {
        if (!value) {
          return "Please enter a path.";
        }

        try {
          accessSync(value);
        } catch (error) {
          debug(error);
          return "Could not access the file at this path.";
        }
        return undefined;
      },
    }),
  );
}

type ShowCopyPasteInstructionsOptions = { codeSnippet: string } & (
  | {
      filename: string;
      hint?: string | undefined;
    }
  | {
      instructions: string;
    }
);

/**
 * Prints copy/paste-able instructions to the console.
 * Afterwards asks the user if they added the code snippet to their file.
 *
 * While there's no point in providing a "no" answer here, it gives users time to fulfill the
 * task before the wizard continues with additional steps.
 *
 * Use this function if you want to show users instructions on how to add/modify
 * code in their file. This is helpful if automatic insertion failed or is not possible/feasible.
 *
 * @param filename the name of the file to which the code snippet should be applied.
 * If a path is provided, only the filename will be used.
 *
 * @param codeSnippet the snippet to be printed. Use {@link makeCodeSnippet}  to create the
 * diff-like format for visually highlighting unchanged or modified lines of code.
 *
 * @param hint (optional) a hint to be printed after the main instruction to add
 * the code from @param codeSnippet to their @param filename.
 *
 * More guidelines on copy/paste instructions:
 * @see {@link https://develop.sentry.dev/sdk/setup-wizards/#copy--paste-snippets}
 *
 * TODO: refactor copy paste instructions across different wizards to use this function.
 *       this might require adding a custom message parameter to the function
 */
export async function showCopyPasteInstructions(
  opts: ShowCopyPasteInstructionsOptions,
): Promise<void> {
  if ("instructions" in opts) {
    clack.log.step(opts.instructions);
  } else {
    const defaultInstructions = `Add the following code to your ${chalk.cyan(
      basename(opts.filename),
    )} file:${opts.hint ? chalk.dim(` (${chalk.dim(opts.hint)})`) : ""}`;

    clack.log.step(defaultInstructions);
  }

  // Padding the code snippet to be printed with a \n at the beginning and end
  // This makes it easier to distinguish the snippet from the rest of the output
  // Printed outside clack's gutter so that the code can be copied/pasted directly
  clack.rawOutput(`\n${opts.codeSnippet}\n`);

  await abortIfCancelled(
    clack.select({
      message: "Did you apply the snippet above?",
      options: [{ label: "Yes, continue!", value: true }],
      initialValue: true,
    }),
  );
}

/**
 * Callback that exposes formatting helpers for a code snippet.
 * @param unchanged - Formats text as old code.
 * @param plus - Formats text as new code.
 * @param minus - Formats text as removed code.
 */
type CodeSnippetFormatter = (
  unchanged: (txt: string) => string,
  plus: (txt: string) => string,
  minus: (txt: string) => string,
) => string;

/**
 * Crafts a code snippet that can be used to e.g.
 * - print copy/paste instructions to the console
 * - create a new config file.
 *
 * @param colors set this to true if you want the final snippet to be colored.
 * This is useful for printing the snippet to the console as part of copy/paste instructions.
 *
 * @param callback the callback that returns the formatted code snippet.
 * It exposes takes the helper functions for marking code as unchanged, new or removed.
 * These functions no-op if no special formatting should be applied
 * and otherwise apply the appropriate formatting/coloring.
 * (@see {@link CodeSnippetFormatter})
 *
 * @see {@link showCopyPasteInstructions} for the helper with which to display the snippet in the console.
 *
 * @returns a string containing the final, formatted code snippet.
 */
export function makeCodeSnippet(
  colors: boolean,
  callback: CodeSnippetFormatter,
): string {
  const unchanged = (txt: string) => (colors ? chalk.grey(txt) : txt);
  const plus = (txt: string) => (colors ? chalk.greenBright(txt) : txt);
  const minus = (txt: string) => (colors ? chalk.redBright(txt) : txt);

  return callback(unchanged, plus, minus);
}

/**
 * Creates a new config file with the given @param filepath and @param codeSnippet.
 *
 * Use this function to create a new config file for users. This is useful
 * when users answered that they don't yet have a config file for a tool.
 *
 * (This doesn't mean that they don't yet have some other way of configuring
 * their tool but we can leave it up to them to figure out how to merge configs
 * here.)
 *
 * @param filepath absolute path to the new config file
 * @param codeSnippet the snippet to be inserted into the file
 * @param moreInformation (optional) the message to be printed after the file was created
 * For example, this can be a link to more information about configuring the tool.
 *
 * @returns true on success, false otherwise
 */
export async function createNewConfigFile(
  filepath: string,
  codeSnippet: string,
  moreInformation?: string,
): Promise<boolean> {
  if (!isAbsolute(filepath)) {
    debug(`createNewConfigFile: filepath is not absolute: ${filepath}`);
    return false;
  }

  const prettyFilename = chalk.cyan(relative(process.cwd(), filepath));

  try {
    await promises.writeFile(filepath, codeSnippet);

    clack.log.success(`Added new ${prettyFilename} file.`);

    if (moreInformation) {
      clack.log.info(chalk.gray(moreInformation));
    }

    return true;
  } catch (e) {
    debug(e);
    clack.log.warn(
      `Could not create a new ${prettyFilename} file. Please create one manually and follow the instructions below.`,
    );
  }

  return false;
}

export async function askShouldCreateExamplePage(
  customRoute?: string,
): Promise<boolean> {
  const route = chalk.cyan(customRoute ?? "/sentry-example-page");

  const createExamplePage = await traceStep("ask-create-example-page", () =>
    abortIfCancelled(
      clack.select({
        message: `Do you want to create an example page ("${route}") to test your Sentry setup?`,
        initialValue: true,
        options: [
          {
            value: true,
            label: "Yes",
            hint: "Recommended - Check your git status before committing!",
          },
          { value: false, label: "No" },
        ],
      }),
    ),
  );

  Sentry.setTag("create-example-page", createExamplePage);
  return createExamplePage;
}

export async function askShouldCreateExampleComponent(): Promise<boolean> {
  return await traceStep("ask-create-example-component", () =>
    abortIfCancelled(
      clack.select({
        message: `Do you want to create an example component to test your Sentry setup?`,
        options: [
          {
            value: true,
            label: "Yes",
            hint: "Recommended - Check your git status before committing!",
          },
          { value: false, label: "No" },
        ],
      }),
    ),
  );
}

export async function featureSelectionPrompt<F extends ReadonlyArray<Feature>>(
  features: F,
): Promise<Record<F[number]["id"], boolean>> {
  return await traceStep("feature-selection", async () => {
    const selectedFeatures: Record<string, boolean> = {};

    for (const feature of features) {
      const selected = await abortIfCancelled(
        clack.select({
          message: feature.prompt,
          initialValue: true,
          options: [
            {
              value: true,
              label: "Yes",
              ...(feature.enabledHint ? { hint: feature.enabledHint } : {}),
            },
            {
              value: false,
              label: "No",
              ...(feature.disabledHint ? { hint: feature.disabledHint } : {}),
            },
          ],
        }),
      );

      selectedFeatures[feature.id] = selected;
    }

    return selectedFeatures;
  });
}

export async function askShouldInstallPackage(
  pkgName: string,
): Promise<boolean> {
  return await traceStep(`ask-install-package`, () =>
    abortIfCancelled(
      clack.confirm({
        message: `Do you want to install ${chalk.cyan(pkgName)}?`,
      }),
    ),
  );
}

export async function askShouldAddPackageOverride(
  pkgName: string,
  pkgVersion: string,
): Promise<boolean> {
  return await traceStep(`ask-add-package-override`, () =>
    abortIfCancelled(
      clack.confirm({
        message: `Do you want to add an override for ${chalk.cyan(
          pkgName,
        )} version ${chalk.cyan(pkgVersion)}?`,
      }),
    ),
  );
}

async function getBuildCommand(): Promise<string | null> {
  const packageDotJson = await getPackageDotJson();
  return typeof packageDotJson.scripts?.["build"] === "string" ? "build" : null;
}

export function artifactsExist(relativePath: string): boolean {
  return existsSync(path.join(process.cwd(), relativePath));
}

export async function askToRunBuildOrEnterPathOrProceed({
  relativeArtifactPath,
}: {
  relativeArtifactPath: string;
}): Promise<{ validPath: boolean; relativeArtifactPath?: string }> {
  const options: { label: string; value: string }[] = [];

  const buildCommand = await getBuildCommand();

  if (buildCommand) {
    options.push({
      label: "Let the wizard run the build command",
      value: "run-build",
    });
  }

  options.push(
    {
      label: "Enter a different path manually",
      value: "manual",
    },
    {
      label: "Proceed anyway — I believe the path is correct",
      value: "proceed",
    },
  );

  const whatToDo = await abortIfCancelled(
    clack.select({
      message: `We couldn't find build artifacts at "${relativeArtifactPath}". What would you like to do?`,
      options,
      initialValue: buildCommand ? "run-build" : "manual",
    }),
  );

  if (whatToDo === "proceed") {
    return {
      validPath: true,
    };
  }

  if (whatToDo === "run-build" && buildCommand) {
    const ranBuildAndCheckArtifacts = await runBuildAndCheckArtifacts(
      buildCommand,
      relativeArtifactPath,
    );

    if (!ranBuildAndCheckArtifacts.validPath) {
      return await askToRunBuildOrEnterPathOrProceed({ relativeArtifactPath });
    }

    return ranBuildAndCheckArtifacts;
  }

  return {
    validPath: false,
  };
}

function getPossibleBuildFolders(): string[] {
  const commonBuildFolders = ["build", "dist", "out", ".next"];

  return commonBuildFolders.filter((folder) =>
    existsSync(path.join(process.cwd(), folder)),
  );
}

async function promptForAlternativeArtifactPath(): Promise<string | undefined> {
  const folders = getPossibleBuildFolders();

  if (!folders.length) {
    return undefined;
  }

  if (folders.length === 1) {
    const [onlyFolder] = folders;

    const confirmed = await abortIfCancelled(
      clack.select({
        message: `Detected one possible build folder. Use "${onlyFolder}" as your build artifacts folder?`,
        options: [
          {
            value: true,
            label: "Yes",
          },
          { value: false, label: "No" },
        ],
      }),
    );

    return confirmed ? onlyFolder : undefined;
  }

  const selected = await abortIfCancelled(
    clack.select<string | false>({
      message: `Detected multiple possible build folders. Is one of these your build artifacts folder?`,
      options: [
        ...folders.map((f) => ({ value: f, label: f })),
        { value: false, label: "No" },
      ],
    }),
  );

  if (selected) {
    return String(selected);
  }

  return undefined;
}

async function runBuildCommand(buildCommand: string): Promise<boolean> {
  const packageManager = await getPackageManager(NPM);
  const command = `${packageManager.runScriptCommand} ${buildCommand}`;
  const spinner = clack.spinner();

  spinner.start(`Running ${chalk.cyan(command)}...`);
  try {
    execSync(command, {
      stdio: "inherit",
      cwd: process.cwd(),
    });
    spinner.stop("Build finished running.");
    return true;
  } catch (error) {
    spinner.stop(
      `Build failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    clack.log.error(
      "Failed to run your build command. Please run it manually and try again.",
    );
    return false;
  }
}

async function runBuildAndCheckArtifacts(
  buildCommand: string,
  relativeArtifactPath: string,
): Promise<{ validPath: boolean; relativeArtifactPath?: string }> {
  const buildRan = await runBuildCommand(buildCommand);

  if (!buildRan) {
    return { validPath: false };
  }

  const found = artifactsExist(relativeArtifactPath);

  if (found) {
    clack.log.success("Build completed and build artifacts folder found!");
    return { validPath: true };
  }

  clack.log.warn(
    `Build ran, but build artifacts folder still not found at ${relativeArtifactPath}.`,
  );

  const fallbackPath = await promptForAlternativeArtifactPath();

  if (!fallbackPath) {
    return { validPath: false };
  }

  return {
    validPath: artifactsExist(fallbackPath),
    relativeArtifactPath: fallbackPath,
  };
}
