/**
 * Setup steps of the React Router wizard: revealing the entry files,
 * writing the server instrumentation file, updating `package.json` scripts,
 * and the config edits, each with copy-paste instructions as a fallback.
 */

import { existsSync, promises, writeFileSync } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

import { clack } from "../utils/clack/prompts.js";
import chalk from "chalk";
import { gte, minVersion, coerce } from "semver";

import type { PackageDotJson } from "../utils/package-json.js";
import { getPackageVersion } from "../utils/package-json.js";
import { debug } from "../utils/debug.js";
import { getSentryInstrumentationServerContent } from "./templates.js";
import { instrumentServerEntry } from "./codemods/server-entry.js";
import { abortIfCancelled, getPackageDotJson } from "../utils/clack/index.js";
import { instrumentClientEntry } from "./codemods/client.entry.js";
import { instrumentViteConfig } from "./codemods/vite.js";
import { instrumentReactRouterConfig } from "./codemods/react-router-config.js";

const REACT_ROUTER_REVEAL_COMMAND = "npx react-router reveal";
const INSTRUMENTATION_FILE = "instrument.server.mjs";
const APP_DIRECTORY = "app";
const ROUTES_DIRECTORY = "routes";

function _formatConfigErrorMessage(
  filename: string,
  errorMessage: string,
  fallbackHint: string,
): string {
  return (
    `Could not automatically configure ${filename}. ${errorMessage}\n` +
    `This may happen if your config has an unusual format. ` +
    fallbackHint
  );
}

function getAppFilePath(
  filename: string,
  isTS: boolean,
  isPage = true,
): string {
  const ext = isPage ? (isTS ? "tsx" : "jsx") : isTS ? "ts" : "js";
  return path.join(process.cwd(), APP_DIRECTORY, `${filename}.${ext}`);
}

export function getRouteFilePath(filename: string, isTS: boolean): string {
  const ext = isTS ? "tsx" : "jsx";
  return path.join(
    process.cwd(),
    APP_DIRECTORY,
    ROUTES_DIRECTORY,
    `${filename}.${ext}`,
  );
}

export async function tryRevealAndGetManualInstructions(
  missingFilename: string,
  filePath: string,
): Promise<boolean> {
  const shouldTryReveal = await abortIfCancelled(
    clack.confirm({
      message: `Would you like to try running ${chalk.cyan(
        REACT_ROUTER_REVEAL_COMMAND,
      )} to generate entry files?`,
      initialValue: true,
    }),
  );

  if (shouldTryReveal) {
    try {
      clack.log.info(`Running ${chalk.cyan(REACT_ROUTER_REVEAL_COMMAND)}...`);
      const output = execSync(REACT_ROUTER_REVEAL_COMMAND, {
        encoding: "utf8",
        stdio: "pipe",
      });
      clack.log.info(output);

      if (existsSync(filePath)) {
        clack.log.success(
          `Found ${chalk.cyan(missingFilename)} after running reveal.`,
        );
        return true;
      }
      clack.log.warn(
        `${chalk.cyan(missingFilename)} still not found after running reveal.`,
      );
    } catch (e) {
      debug("Failed to run React Router reveal command:", e);
      clack.log.warn(
        `Failed to run ${chalk.cyan(
          REACT_ROUTER_REVEAL_COMMAND,
        )}. This command generates entry files for React Router v7.`,
      );
    }
  }

  return false; // File still doesn't exist, manual intervention needed
}

async function ensureEntryFileExists(
  filename: string,
  filePath: string,
): Promise<void> {
  if (existsSync(filePath)) {
    return; // File exists, nothing to do
  }

  clack.log.warn(`Could not find ${chalk.cyan(filename)}.`);

  const fileExists = await tryRevealAndGetManualInstructions(
    filename,
    filePath,
  );

  if (!fileExists) {
    throw new Error(
      `Failed to create or find ${filename}. Please create this file manually or ensure your React Router v7 project structure is correct.`,
    );
  }
}

export function runReactRouterReveal(): void {
  if (
    !existsSync(path.join(process.cwd(), "app", "entry.client.tsx")) &&
    !existsSync(path.join(process.cwd(), "app", "entry.client.jsx"))
  ) {
    try {
      execSync(REACT_ROUTER_REVEAL_COMMAND, {
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (e) {
      debug("Failed to run React Router reveal command:", e);
      throw e;
    }
  }
}

export function isReactRouterV7(packageJson: PackageDotJson): boolean {
  const reactRouterVersion = getPackageVersion(
    "@react-router/dev",
    packageJson,
  );
  if (!reactRouterVersion) {
    return false;
  }

  const minVer = minVersion(reactRouterVersion);

  if (!minVer) {
    return false;
  }

  return gte(minVer, "7.0.0");
}

export function getReactRouterVersion(
  packageJson: PackageDotJson,
): string | undefined {
  const rangeVersion = getPackageVersion("@react-router/dev", packageJson);
  if (!rangeVersion) {
    return undefined;
  }

  const coerced = coerce(rangeVersion);
  return coerced ? coerced.version : rangeVersion;
}

export function supportsOnError(packageJson: PackageDotJson): boolean {
  const reactRouterVersion = getPackageVersion(
    "@react-router/dev",
    packageJson,
  );
  if (!reactRouterVersion) {
    return false;
  }

  const minVer = minVersion(reactRouterVersion);

  if (!minVer) {
    return false;
  }

  return gte(minVer, "7.11.0");
}

export function supportsInstrumentationAPI(
  packageJson: PackageDotJson,
): boolean {
  const reactRouterVersion = getPackageVersion(
    "@react-router/dev",
    packageJson,
  );
  if (!reactRouterVersion) {
    return false;
  }

  const minVer = minVersion(reactRouterVersion);

  if (!minVer) {
    return false;
  }

  return gte(minVer, "7.15.0");
}

// oxlint-disable-next-line max-params -- positional like the sentry-wizard original and its tests
export async function initializeSentryOnEntryClient(
  dsn: string,
  enableTracing: boolean,
  enableReplay: boolean,
  isTS: boolean,
  reduceDataCollection: boolean,
  useInstrumentationAPI = false,
  useOnError = false,
): Promise<void> {
  const clientEntryPath = getAppFilePath("entry.client", isTS);
  const clientEntryFilename = path.basename(clientEntryPath);

  await ensureEntryFileExists(clientEntryFilename, clientEntryPath);

  await instrumentClientEntry(
    clientEntryPath,
    dsn,
    enableTracing,
    enableReplay,
    reduceDataCollection,
    useInstrumentationAPI,
    useOnError,
  );

  clack.log.success(
    `Updated ${chalk.cyan(clientEntryFilename)} with Sentry initialization.`,
  );
}

export function createServerInstrumentationFile(
  dsn: string,
  selectedFeatures: {
    performance: boolean;
    replay: boolean;
    profiling: boolean;
  },
  reduceDataCollection: boolean,
): string {
  const instrumentationPath = path.join(process.cwd(), INSTRUMENTATION_FILE);

  const content = getSentryInstrumentationServerContent(
    dsn,
    selectedFeatures.performance,
    selectedFeatures.profiling,
    reduceDataCollection,
  );

  writeFileSync(instrumentationPath, content);
  clack.log.success(`Created ${chalk.cyan(INSTRUMENTATION_FILE)}.`);
  return instrumentationPath;
}

export async function updatePackageJsonScripts(): Promise<void> {
  const packageJson = await getPackageDotJson();

  if (!packageJson.scripts) {
    throw new Error(
      "Could not find a `scripts` section in your package.json file. Please add scripts manually or ensure your package.json is valid.",
    );
  }

  if (!packageJson.scripts["start"]) {
    throw new Error(
      'Could not find a `start` script in your package.json. Please add: "start": "react-router-serve ./build/server/index.js" and re-run the wizard.',
    );
  }

  function mergeNodeOptions(
    scriptCommand: string,
    instrumentPath = "./instrument.server.mjs",
  ): string {
    if (scriptCommand.includes(instrumentPath)) {
      return scriptCommand;
    }

    // Shell semantics: an unquoted value ends at the first whitespace, so
    // `NODE_OPTIONS=--a PORT=3000 node` keeps `PORT=3000` as its own variable.
    const nodeOptions = /(^|\s)NODE_OPTIONS=(?:'([^']*)'|"([^"]*)"|(\S*))/.exec(
      scriptCommand,
    );
    if (nodeOptions) {
      const existingOptions =
        nodeOptions[2] ?? nodeOptions[3] ?? nodeOptions[4] ?? "";
      const mergedOptions =
        `${existingOptions} --import ${instrumentPath}`.trim();
      return scriptCommand.replace(
        nodeOptions[0],
        () => `${nodeOptions[1] ?? ""}NODE_OPTIONS='${mergedOptions}'`,
      );
    }

    return `NODE_OPTIONS='--import ${instrumentPath}' ${scriptCommand}`;
  }

  if (packageJson.scripts["dev"]) {
    packageJson.scripts["dev"] = mergeNodeOptions(packageJson.scripts["dev"]);
  }

  // Keep the project's own start command (custom server, port, flags) and
  // only add the instrumentation import to it.
  packageJson.scripts["start"] = mergeNodeOptions(packageJson.scripts["start"]);

  // Prevent React CJS dev/prod bundle mismatch when --import loads react
  // before react-router-serve sets NODE_ENV
  if (
    packageJson.scripts["start"].includes("--import") &&
    !packageJson.scripts["start"].includes("NODE_ENV=")
  ) {
    packageJson.scripts["start"] =
      `NODE_ENV=production ${packageJson.scripts["start"]}`;
  }

  await promises.writeFile(
    "package.json",
    JSON.stringify(packageJson, null, 2),
  );
}

export async function instrumentSentryOnEntryServer(
  isTS: boolean,
  useInstrumentationAPI = false,
): Promise<void> {
  const serverEntryPath = getAppFilePath("entry.server", isTS);
  const serverEntryFilename = path.basename(serverEntryPath);

  await ensureEntryFileExists(serverEntryFilename, serverEntryPath);

  await instrumentServerEntry(serverEntryPath, useInstrumentationAPI);

  clack.log.success(
    `Updated ${chalk.cyan(serverEntryFilename)} with Sentry error handling.`,
  );
}

export async function configureReactRouterVitePlugin(
  orgSlug: string,
  projectSlug: string,
  vitePluginImportPath: string,
): Promise<void> {
  const configPath = existsSync(path.join(process.cwd(), "vite.config.ts"))
    ? path.join(process.cwd(), "vite.config.ts")
    : path.join(process.cwd(), "vite.config.js");
  const filename = chalk.cyan(path.basename(configPath));

  try {
    const { wasConverted } = await instrumentViteConfig(
      orgSlug,
      projectSlug,
      vitePluginImportPath,
    );

    clack.log.success(`Updated ${filename} with sentryReactRouter plugin.`);

    if (wasConverted) {
      clack.log.info(
        `Converted your Vite config to function form ${chalk.dim(
          "(defineConfig(config => ({ ... })))",
        )} to support the Sentry React Router plugin.`,
      );
    }
  } catch (e) {
    debug("Failed to modify vite config:", e);
    const errorMessage = e instanceof Error ? e.message : String(e);
    throw new Error(
      _formatConfigErrorMessage(
        filename,
        errorMessage,
        "You may need to add the plugin manually.",
      ),
    );
  }
}

export async function configureReactRouterConfig(
  isTS: boolean,
  vitePluginImportPath: string,
): Promise<void> {
  const configFilename = `react-router.config.${isTS ? "ts" : "js"}`;
  const configPath = path.join(process.cwd(), configFilename);
  const filename = chalk.cyan(configFilename);

  try {
    const fileExistedBefore = existsSync(configPath);

    const { ssrWasChanged } = await instrumentReactRouterConfig(
      isTS,
      vitePluginImportPath,
    );

    if (fileExistedBefore) {
      clack.log.success(`Updated ${filename} with Sentry buildEnd hook.`);
    } else {
      clack.log.success(`Created ${filename} with Sentry buildEnd hook.`);
    }

    if (ssrWasChanged) {
      clack.log.warn(
        `${chalk.yellow(
          "Note:",
        )} SSR has been enabled in your React Router config (${chalk.cyan(
          "ssr: true",
        )}). This is required for Sentry sourcemap uploads to work correctly.`,
      );
    }
  } catch (e) {
    debug("Failed to modify react-router.config:", e);
    const errorMessage = e instanceof Error ? e.message : String(e);
    throw new Error(
      _formatConfigErrorMessage(
        filename,
        errorMessage,
        "You may need to add the buildEnd hook manually.",
      ),
    );
  }
}
