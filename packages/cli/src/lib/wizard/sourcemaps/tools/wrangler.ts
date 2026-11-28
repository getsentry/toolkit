/**
 * Source maps setup for Cloudflare Wrangler: make `wrangler deploy` keep
 * its output and source maps, tag the worker with a release, and upload the
 * output with the `sentry` CLI after each deploy.
 *
 * sentry-wizard installed `@sentry/cli@^2` and called `sentry-cli releases
 * propose-version/new` and `sentry-cli sourcemaps upload`. These are the v4
 * `sentry release` and `sentry sourcemap` commands, which read the org and
 * project from `.sentryclirc`.
 */

import chalk from "chalk";
import { promises } from "node:fs";
import path from "node:path";

import {
  abort,
  abortIfCancelled,
  addSentryCliConfig,
  getPackageDotJson,
  getPackageManager,
  installPackage,
  showCopyPasteInstructions,
} from "../../utils/clack/index.js";
import { clack } from "../../utils/clack/prompts.js";
import { hasPackageInstalled } from "../../utils/package-json.js";
import { NPM, YARN_V2 } from "../../utils/package-manager.js";
import {
  addUploadTargetToSentryCliRc,
  SENTRY_CLI_PACKAGE_SPEC,
} from "./sentry-cli.js";
import type { SourceMapUploadToolConfigurationOptions } from "./types.js";

const SENTRY_NPM_SCRIPT_NAME = "sentry:sourcemaps";

/**
 * only exported for testing
 */
export const DIST_DIR = path.join(".", "dist");

/**
 * A `--var` that sets SENTRY_RELEASE, with `=` or `:` and optional quotes,
 * like `SHELL_SPOTLIGHT_VAR_RE` in `lib/wrangler.ts`.
 */
const RELEASE_VAR_RE = /--var(?:=|\s+)["']?SENTRY_RELEASE(?::|=)/;

export async function configureWrangler(
  options: SourceMapUploadToolConfigurationOptions,
) {
  clack.note(
    chalk.whiteBright(
      `Configuring source maps upload with Cloudflare Wrangler requires the wizard to:
- Modify your deploy command to access source maps
- Set the SENTRY_RELEASE env var to identify source maps

Note: This setup may need additional configuration. 
We recommend using Vite to build your worker instead, for an easier and more reliable setup.

Learn more about CloudFlare's Vite setup here:
${chalk.underline(
  chalk.cyan(
    "https://developers.cloudflare.com/workers/vite-plugin/get-started/",
  ),
)}

You can switch to Vite and re-run this wizard later. 
Otherwise, let's proceed with the Wrangler setup.`,
    ),
    "Before we get started",
  );

  const proceed = await abortIfCancelled(
    clack.confirm({
      message: "Do you want to proceed with the Wrangler setup?",
    }),
  );

  if (!proceed) {
    await abort(
      "Got it! You can switch to Vite and re-run this wizard later.",
      0,
    );
    return;
  }

  await installPackage({
    packageName: SENTRY_CLI_PACKAGE_SPEC,
    alreadyInstalled: hasPackageInstalled("sentry", await getPackageDotJson()),
    devDependency: true,
  });

  if (!(await askContinueIfHasSentrySourcemapsScript())) {
    await abort("Exiting the wizard.", 0);
    return;
  }

  const deployCommand = await getDeployCommand();
  const outDir = deployCommand
    ? await getWranglerOutDir(deployCommand)
    : DIST_DIR;

  await createAndAddSentrySourcemapsScript(outDir);

  const packageManager = await getPackageManager(NPM);
  const runUpload = `${packageManager.runScriptCommand} ${SENTRY_NPM_SCRIPT_NAME}`;
  if (deployCommand) {
    // Yarn 2+ gets the upload chained onto the deploy script, so a manual
    // deploy command that replaces the script has to carry the upload too.
    const chainUpload = packageManager === YARN_V2;
    const modified = await modifyDeployCommand(
      deployCommand,
      outDir,
      chainUpload ? runUpload : undefined,
    );
    if (modified || !chainUpload) {
      await addUploadAfterDeploy(deployCommand);
    }
  } else {
    await showCopyPasteInstructions({
      codeSnippet: getManualDeployCommand(outDir, runUpload),
      filename: "package.json",
    });
  }

  await addUploadTargetToSentryCliRc(options);
  await addSentryCliConfig({ authToken: options.authToken });

  if (options.selfHosted) {
    clack.log.info(
      `Set ${chalk.cyan(`SENTRY_URL=${options.url}`)} wherever ${chalk.cyan(
        SENTRY_NPM_SCRIPT_NAME,
      )} runs, such as in CI, so that it uploads to your Sentry instance.`,
    );
  }
}

async function createAndAddSentrySourcemapsScript(
  outDir: string,
): Promise<void> {
  const pkgJson = await getPackageDotJson();
  pkgJson.scripts = pkgJson.scripts ?? {};
  pkgJson.scripts[SENTRY_NPM_SCRIPT_NAME] = getSentryCliCommand(outDir);

  await promises.writeFile(
    path.join(process.cwd(), "package.json"),
    JSON.stringify(pkgJson, null, 2),
  );

  clack.log.success(
    `Added a ${chalk.cyan(SENTRY_NPM_SCRIPT_NAME)} script to your ${chalk.cyan(
      "package.json",
    )}.`,
  );
}

/**
 * Prints the proposed release version. `sentry release propose-version`
 * prints a hint after the version when its output is piped, so only the
 * first line is kept.
 */
// oxlint-disable-next-line sentry-cli/no-hardcoded-sentry-command -- runs the project's installed `sentry` package from its package.json scripts, not a hint
const PROPOSE_VERSION = "$(sentry release propose-version | head -n 1)";

/**
 * The `sentry:sourcemaps` script: create the release and upload the deploy
 * output for it. The output is uploaded as deployed (`--no-rewrite`): the
 * worker was already deployed without debug IDs, so the files are matched
 * by release and URL, as with sentry-cli. The org and project come from
 * `.sentryclirc` (or `SENTRY_ORG` and `SENTRY_PROJECT` in CI), and a
 * self-hosted URL from `SENTRY_URL`.
 *
 * only exported for testing
 */
export function getSentryCliCommand(outDir: string): string {
  return [
    `_SENTRY_RELEASE=${PROPOSE_VERSION}`,
    // oxlint-disable-next-line sentry-cli/no-hardcoded-sentry-command -- a package.json script, not a hint
    'sentry release create "$_SENTRY_RELEASE"',
    // oxlint-disable-next-line sentry-cli/no-hardcoded-sentry-command -- a package.json script, not a hint
    `sentry sourcemap upload --release="$_SENTRY_RELEASE" --no-rewrite ${quoteShellArg(
      outDir,
    )}`,
  ].join(" && ");
}

// Package scripts run through a shell. Quote values as literal arguments,
// including embedded single quotes, before inserting them into shell source.
function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function askContinueIfHasSentrySourcemapsScript(): Promise<boolean> {
  const pkgJson = await getPackageDotJson();

  pkgJson.scripts = pkgJson.scripts ?? {};

  if (pkgJson.scripts[SENTRY_NPM_SCRIPT_NAME]) {
    clack.log.warn(
      `The ${chalk.cyan(
        SENTRY_NPM_SCRIPT_NAME,
      )} script already exists in your ${chalk.cyan("package.json")}.
This likely means that you already ran this wizard once.
If things don't work yet, try overwriting the script and continue with the wizard.`,
    );

    const overwrite = await abortIfCancelled(
      clack.select({
        message: "Do you want to overwrite it?",
        options: [
          { label: "Yes", value: true, hint: "Overwrite the existing script" },
          { label: "No", value: false, hint: "This will exit the wizard" },
        ],
      }),
    );

    if (!overwrite) {
      return false;
    }
  }

  return true;
}

async function getDeployCommand(): Promise<string | undefined> {
  const pkgJson = await getPackageDotJson();
  const scripts = pkgJson.scripts ?? {};

  let deployCommand = Object.keys(scripts).find((key) =>
    /wrangler\s+deploy/.test(scripts[key] ?? ""),
  );

  const packageManager = await getPackageManager(NPM);
  const isDeployCommand =
    !!deployCommand &&
    (await abortIfCancelled(
      clack.confirm({
        message: `Is ${chalk.cyan(
          `${packageManager.runScriptCommand} ${deployCommand}`,
        )} your build and deploy command?`,
      }),
    ));

  if (Object.keys(scripts).length && (!deployCommand || !isDeployCommand)) {
    deployCommand = await abortIfCancelled(
      clack.select({
        message: `Which ${packageManager.name} command in your ${chalk.cyan(
          "package.json",
        )} builds your worker and deploys it?`,
        options: [
          ...Object.keys(scripts).map((script) => ({
            label: script,
            value: script,
          })),
          { label: "None of the above", value: "none" },
        ],
      }),
    );
  }

  if (!deployCommand || deployCommand === "none") {
    clack.log.warn(
      `We can only add the ${chalk.cyan(
        SENTRY_NPM_SCRIPT_NAME,
      )} script to another \`script\` in your ${chalk.cyan("package.json")}.
Please add it manually to your deploy command:`,
    );
    return undefined;
  }

  return deployCommand;
}

/**
 * Run `sentry:sourcemaps` after `deployCommand`: from its `post<deploy>`
 * script, as the Sentry docs do, or chained onto the deploy script for Yarn
 * 2+, which doesn't run `post` scripts. An existing `post<deploy>` script is
 * kept, with the upload added after it.
 */
async function addUploadAfterDeploy(deployCommand: string): Promise<void> {
  const pkgJson = await getPackageDotJson();
  const packageManager = await getPackageManager(NPM);
  pkgJson.scripts = pkgJson.scripts ?? {};

  const scriptName =
    packageManager === YARN_V2 ? deployCommand : `post${deployCommand}`;
  const existingScript = pkgJson.scripts[scriptName];
  if (existingScript?.includes(SENTRY_NPM_SCRIPT_NAME)) {
    return;
  }

  const runUpload = `${packageManager.runScriptCommand} ${SENTRY_NPM_SCRIPT_NAME}`;
  pkgJson.scripts[scriptName] = existingScript
    ? `${existingScript} && ${runUpload}`
    : runUpload;

  await promises.writeFile(
    path.join(process.cwd(), "package.json"),
    JSON.stringify(pkgJson, null, 2),
  );

  clack.log.success(
    `${existingScript ? "Updated" : "Added"} the ${chalk.cyan(
      scriptName,
    )} script in your ${chalk.cyan("package.json")} to upload source maps after each deploy.`,
  );
}

/**
 * The `wrangler deploy` command to show when the wizard can't edit it,
 * followed by `thenRun` when given.
 */
function getManualDeployCommand(outDir: string, thenRun?: string): string {
  const deploy = `wrangler deploy --outdir ${quoteShellArg(
    outDir,
  )} --var SENTRY_RELEASE:${PROPOSE_VERSION} --upload-source-maps`;
  return thenRun ? `${deploy} && ${thenRun}` : deploy;
}

/**
 * Add the source map flags to the `deployCommand` script, or show a manual
 * deploy command, ending with `thenRun` when given, if it can't.
 *
 * @returns Whether it edited the script
 */
async function modifyDeployCommand(
  deployCommand: string,
  outDir: string,
  thenRun?: string,
): Promise<boolean> {
  const pkgJson = await getPackageDotJson();
  pkgJson.scripts = pkgJson.scripts ?? {};
  const oldDeployCommand = pkgJson.scripts[deployCommand];

  if (!oldDeployCommand) {
    clack.log.warn(
      `The ${chalk.cyan(
        deployCommand,
      )} script doesn't seem to be part of your package.json scripts anymore. Cannot modify it. Please modify it manually:`,
    );

    await showCopyPasteInstructions({
      codeSnippet: getManualDeployCommand(outDir, thenRun),
      filename: "package.json",
    });

    return false;
  }

  const newDeployCommand = safeInsertArgsToWranglerDeployCommand(
    oldDeployCommand,
    outDir,
  );

  if (!newDeployCommand) {
    clack.log.warn(
      `The ${chalk.cyan(
        deployCommand,
      )} script doesn't seem to be a valid ${chalk.cyan(
        "wrangler deploy",
      )} command. Cannot modify it. Please modify it manually:`,
    );

    await showCopyPasteInstructions({
      codeSnippet: getManualDeployCommand(outDir, thenRun),
      filename: "package.json",
    });

    return false;
  }

  pkgJson.scripts[deployCommand] = newDeployCommand;

  await promises.writeFile(
    path.join(process.cwd(), "package.json"),
    JSON.stringify(pkgJson, null, 2),
  );

  clack.log.success(
    `Modified your ${chalk.cyan(
      deployCommand,
    )} script to enable uploading source maps.`,
  );
  return true;
}

/**
 * Takes care of inserting the necessary arguments into the deploy command.
 * Ensures that existing arguments and values are kept and that the
 * wrangler deploy command is valid.
 *
 * only exported for testing
 */
export function safeInsertArgsToWranglerDeployCommand(
  deployCommand: string,
  outDir: string,
): string | undefined {
  // split deployCommand into individual bash commands (potentially separated by &&, ||, >> etc.)
  const wranglerDeployCommand = findWranglerDeployCommand(deployCommand);

  if (!wranglerDeployCommand) {
    return undefined;
  }
  const originalWranglerDeployCommand = wranglerDeployCommand.text;

  const existingArgs = originalWranglerDeployCommand
    .split(" ")
    .map((arg) => arg.trim())
    .filter(Boolean);

  const newArgs: string[] = [];

  if (!hasArg(existingArgs, "--outdir")) {
    newArgs.push("--outdir", quoteShellArg(outDir));
  }

  // Adding --upload-source-maps saves us from having to
  // modify the `wrangler.toml` or `wrangler.jsonc` files.
  // Not ideal because this forces source maps to be uploaded
  // but we'll live with it for now.
  if (!hasArg(existingArgs, "--upload-source-maps")) {
    newArgs.push("--upload-source-maps");
  }

  // This is how we inject the SENTRY_RELEASE variable,
  // which is picked up by the CloudFlare SDK.
  // Skip it when the script already sets SENTRY_RELEASE, e.g. on a rerun.
  if (!RELEASE_VAR_RE.test(originalWranglerDeployCommand)) {
    newArgs.push("--var", `SENTRY_RELEASE:${PROPOSE_VERSION}`);
  }

  if (newArgs.length === 0) {
    return deployCommand;
  }

  // Insert at the deploy command's own position: the same text can appear
  // earlier in the script, such as in `echo wrangler deploy`.
  const end =
    wranglerDeployCommand.start + originalWranglerDeployCommand.length;
  return `${deployCommand.slice(0, end)} ${newArgs.join(" ")} ${deployCommand.slice(
    end,
  )}`.trim();
}

/**
 * Look up an already specified --outdir argument and return it if found.
 * Otherwise, we defined `dist` as the default outdir.
 */
async function getWranglerOutDir(deployScript: string): Promise<string> {
  const pkgJson = await getPackageDotJson();
  const scripts = pkgJson.scripts ?? {};
  const deployCommand = scripts[deployScript];

  if (!deployCommand) {
    return DIST_DIR;
  }

  return findOutDir(deployCommand);
}

/**
 * only exported for testing
 */
export function findOutDir(deployCommand: string): string {
  const args = getWranglerDeployCommand(deployCommand)
    ?.split(" ")
    .map((arg) => arg.trim())
    .filter(Boolean);

  if (!args) {
    return DIST_DIR;
  }

  const outDirArgIndex = args.findIndex((arg) => arg.startsWith("--outdir"));
  const outDirArg = args[outDirArgIndex];
  if (outDirArg === undefined) {
    return DIST_DIR;
  }

  if (outDirArg.startsWith("--outdir=")) {
    return outDirArg.slice("--outdir=".length).trim().replace(/['"]/g, "");
  }

  const maybeOutDir = args[outDirArgIndex + 1];

  if (maybeOutDir && !maybeOutDir.startsWith("--")) {
    return maybeOutDir.replace(/['"]/g, "");
  }

  return DIST_DIR;
}

/** Whether `args` sets the `--name` flag, as `--name`, `--name value`, or `--name=value`. */
function hasArg(args: string[], name: string): boolean {
  return args.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

/** Shell operators that separate the commands of a script. */
const COMMAND_SEPARATORS = ["&&", "||", ">>", ">", "<", "|", ";"];

/**
 * Split a package script into its individual commands at the operators in
 * {@link COMMAND_SEPARATORS}. Operators inside quotes or a `$(…)` command
 * substitution (such as the `| head -n 1` of the release version this
 * wizard adds) don't split. Each command is a substring of `script` that
 * starts at `start`.
 */
function splitShellCommands(script: string): { start: number; text: string }[] {
  const commands: { start: number; text: string }[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | undefined;
  let i = 0;
  while (i < script.length) {
    const char = script.charAt(i);
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      i += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      i += 1;
      continue;
    }
    if (char === "$" && script.charAt(i + 1) === "(") {
      depth += 1;
      i += 2;
      continue;
    }
    if (char === ")" && depth > 0) {
      depth -= 1;
      i += 1;
      continue;
    }
    const separator =
      depth === 0
        ? COMMAND_SEPARATORS.find((op) => script.startsWith(op, i))
        : undefined;
    if (separator) {
      commands.push({ start, text: script.slice(start, i) });
      i += separator.length;
      start = i;
      continue;
    }
    i += 1;
  }
  commands.push({ start, text: script.slice(start) });
  return commands;
}

/**
 * Package-manager runners that the wizard edits when they come straight
 * before `wrangler`, as in `npx wrangler deploy`. Anything else, such as
 * runner flags, `cross-env` or `FOO=1`, gets the manual instructions.
 */
const WRANGLER_RUNNERS = new Set(["npx", "pnpm", "yarn", "bunx"]);

/**
 * Where `argv` runs `wrangler`: bare, or right after a runner from
 * {@link WRANGLER_RUNNERS}. -1 when it doesn't.
 */
function findWranglerIndex(argv: string[]): number {
  if (argv[0] === "wrangler") {
    return 0;
  }
  return WRANGLER_RUNNERS.has(argv[0] ?? "") && argv[1] === "wrangler" ? 1 : -1;
}

/**
 * Wrangler commands with their own `deploy` subcommand, which doesn't take
 * the Workers flags this wizard adds.
 */
const NON_WORKER_DEPLOY_COMMANDS = new Set(["pages", "versions"]);

/**
 * The command of `deployCommand` that runs `wrangler deploy`, bare or
 * through `npx`, `pnpm`, `yarn` or `bunx` (see {@link findWranglerIndex}).
 * `wrangler pages deploy` and `wrangler versions deploy` don't count.
 *
 * Exported for testing
 */
export function getWranglerDeployCommand(
  deployCommand: string,
): string | undefined {
  return findWranglerDeployCommand(deployCommand)?.text;
}

/** {@link getWranglerDeployCommand}, with where it starts in `deployCommand`. */
function findWranglerDeployCommand(
  deployCommand: string,
): { start: number; text: string } | undefined {
  return splitShellCommands(deployCommand).find(({ text }) => {
    const argv = text
      .split(" ")
      .map((arg) => arg.trim())
      .filter(Boolean);

    const wranglerIndex = findWranglerIndex(argv);
    if (wranglerIndex === -1) {
      return false;
    }
    const deployIndex = argv.indexOf("deploy", wranglerIndex + 1);
    return (
      deployIndex !== -1 &&
      !argv
        .slice(wranglerIndex + 1, deployIndex)
        .some((arg) => NON_WORKER_DEPLOY_COMMANDS.has(arg))
    );
  });
}
