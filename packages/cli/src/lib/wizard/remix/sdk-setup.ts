/**
 * Setup steps of the Remix wizard: revealing the entry files, writing and
 * importing the server instrumentation file, and updating the `build` and
 * `start` scripts.
 */

import { formatError } from "../../errors.js";
import type { namedTypes as t } from "ast-types";

import type { Proxified, ProxifiedModule } from "magicast";

import { existsSync, promises, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execSync } from "node:child_process";

import { clack } from "../utils/clack/prompts.js";
import chalk from "chalk";
import { gte, minVersion } from "semver";

import {
  builders,
  generateCode,
  loadFile,
  parseModule,
  writeFile,
} from "magicast";
import type { PackageDotJson } from "../utils/package-json.js";
import { getPackageVersion } from "../utils/package-json.js";
import { getDataCollectionSnippet } from "../utils/data-collection.js";
import {
  getAfterImportsInsertionIndex,
  hasSentryContent,
  serverHasInstrumentationImport,
} from "./utils.js";
import { instrumentRoot } from "./codemods/root.js";
import { instrumentHandleError } from "./codemods/handle-error.js";
import { getPackageDotJson } from "../utils/clack/index.js";
import { findCustomExpressServerImplementation } from "./codemods/express-server.js";

export type PartialRemixConfig = {
  unstable_dev?: boolean;
};

const REMIX_CONFIG_FILE = "remix.config.js";
const REMIX_REVEAL_COMMAND = "npx remix reveal";

export function runRemixReveal(isTS: boolean): void {
  // Check if entry files already exist
  const clientEntryFilename = `entry.client.${isTS ? "tsx" : "jsx"}`;
  const serverEntryFilename = `entry.server.${isTS ? "tsx" : "jsx"}`;

  const clientEntryPath = path.join(process.cwd(), "app", clientEntryFilename);
  const serverEntryPath = path.join(process.cwd(), "app", serverEntryFilename);

  if (existsSync(clientEntryPath) && existsSync(serverEntryPath)) {
    clack.log.info(
      `Found entry files ${chalk.cyan(clientEntryFilename)} and ${chalk.cyan(
        serverEntryFilename,
      )}.`,
    );
  } else {
    clack.log.info(
      `Couldn't find entry files in your project. Trying to run ${chalk.cyan(
        REMIX_REVEAL_COMMAND,
      )}...`,
    );

    clack.log.info(execSync(REMIX_REVEAL_COMMAND).toString());
  }
}

interface SdkAstOptions {
  dsn: string;
  tracesSampleRate?: number;
  replaysSessionSampleRate?: number;
  replaysOnErrorSampleRate?: number;
  integrations?: Array<Proxified>;
}

function getInitCallArgs(
  dsn: string,
  type: "client" | "server",
  selectedFeatures: {
    performance: boolean;
    replay: boolean;
  },
) {
  const initCallArgs: SdkAstOptions = {
    dsn,
  };

  // Adding tracing sample rate for both client and server
  if (selectedFeatures.performance) {
    initCallArgs.tracesSampleRate = 1.0;
  }

  // Adding integrations and replay options only for client
  if (
    type === "client" &&
    (selectedFeatures.performance || selectedFeatures.replay)
  ) {
    initCallArgs.integrations = [] as Array<Proxified>;

    if (selectedFeatures.performance) {
      initCallArgs.integrations.push(
        builders.functionCall(
          "browserTracingIntegration",
          builders.raw("{ useEffect, useLocation, useMatches }"),
        ),
      );
    }

    if (selectedFeatures.replay) {
      initCallArgs.integrations.push(
        builders.functionCall("replayIntegration", {
          maskAllText: true,
          blockAllMedia: true,
        }),
      );

      initCallArgs.replaysSessionSampleRate = 0.1;
      initCallArgs.replaysOnErrorSampleRate = 1.0;
    }
  }

  return initCallArgs;
}

/**
 * Splices the PII-reducing `dataCollection` preset (with its comment block)
 * into generated init code. Magicast cannot express comments inside an
 * options object, so the block is inserted textually before the closing `})`.
 */
function withDataCollectionPreset(
  generatedInitCode: string,
  reduceDataCollection: boolean,
): string {
  if (!reduceDataCollection) {
    return generatedInitCode;
  }

  return generatedInitCode.replace(
    /\n\}\)$/,
    `,\n${getDataCollectionSnippet("    ")}\n})`,
  );
}

function insertClientInitCall(
  dsn: string,
  originalHooksMod: ProxifiedModule,
  selectedFeatures: {
    performance: boolean;
    replay: boolean;
  },
  reduceDataCollection: boolean,
): void {
  const initCallArgs = getInitCallArgs(dsn, "client", selectedFeatures);
  const initCall = builders.functionCall("init", initCallArgs);

  const generatedInitCode = withDataCollectionPreset(
    generateCode(initCall).code,
    reduceDataCollection,
  );

  const originalHooksModAST = originalHooksMod.$ast as t.Program;
  const initCallInsertionIndex =
    getAfterImportsInsertionIndex(originalHooksModAST);

  originalHooksModAST.body.splice(
    initCallInsertionIndex,
    0,
    // @ts-expect-error - string works here because the AST is proxified by magicast
    generatedInitCode,
  );
}

export function generateServerInstrumentationFile(
  dsn: string,
  selectedFeatures: {
    performance: boolean;
    replay: boolean;
  },
  reduceDataCollection: boolean,
) {
  // create an empty file named `instrument.server.mjs`
  const instrumentationFile = "instrumentation.server.mjs";
  const instrumentationFileMod = parseModule("");

  instrumentationFileMod.imports.$add({
    from: "@sentry/remix",
    imported: "*",
    local: "Sentry",
  });

  const initCallArgs = getInitCallArgs(dsn, "server", selectedFeatures);
  const initCall = builders.functionCall("Sentry.init", initCallArgs);

  const generatedInitCode = withDataCollectionPreset(
    generateCode(initCall).code,
    reduceDataCollection,
  );

  const instrumentationFileModAST = instrumentationFileMod.$ast as t.Program;

  const initCallInsertionIndex = getAfterImportsInsertionIndex(
    instrumentationFileModAST,
  );

  instrumentationFileModAST.body.splice(
    initCallInsertionIndex,
    0,
    // @ts-expect-error - string works here because the AST is proxified by magicast
    generatedInitCode,
  );

  return { instrumentationFile, instrumentationFileMod };
}

export async function createServerInstrumentationFile(
  dsn: string,
  selectedFeatures: {
    performance: boolean;
    replay: boolean;
  },
  reduceDataCollection: boolean,
) {
  const { instrumentationFile, instrumentationFileMod } =
    generateServerInstrumentationFile(
      dsn,
      selectedFeatures,
      reduceDataCollection,
    );

  await writeFile(instrumentationFileMod.$ast, instrumentationFile);

  return instrumentationFile;
}

export async function insertServerInstrumentationFile(
  dsn: string,
  selectedFeatures: {
    performance: boolean;
    replay: boolean;
  },
  reduceDataCollection: boolean,
) {
  const instrumentationFile = await createServerInstrumentationFile(
    dsn,
    selectedFeatures,
    reduceDataCollection,
  );

  const expressServerPath = await findCustomExpressServerImplementation();

  if (!expressServerPath) {
    return false;
  }

  const originalExpressServerMod = await loadFile(expressServerPath);

  if (
    serverHasInstrumentationImport(
      expressServerPath,
      originalExpressServerMod.$code,
    )
  ) {
    clack.log.warn(
      `File ${chalk.cyan(
        path.basename(expressServerPath),
      )} already contains instrumentation import.
Skipping adding instrumentation functionality to ${chalk.cyan(
        path.basename(expressServerPath),
      )}.`,
    );

    return true;
  }

  originalExpressServerMod.$code = `import './${instrumentationFile}';\n${originalExpressServerMod.$code}`;

  writeFileSync(expressServerPath, originalExpressServerMod.$code);

  return true;
}

export function isRemixV2(packageJson: PackageDotJson): boolean {
  const remixVersion = getPackageVersion("@remix-run/react", packageJson);
  if (!remixVersion) {
    return false;
  }

  const minVer = minVersion(remixVersion);

  if (!minVer) {
    return false;
  }

  return gte(minVer, "2.0.0");
}

export async function loadRemixConfig(): Promise<PartialRemixConfig> {
  const configFilePath = path.join(process.cwd(), REMIX_CONFIG_FILE);

  try {
    if (!existsSync(configFilePath)) {
      return {};
    }

    const configUrl = pathToFileURL(configFilePath).href;
    const remixConfigModule = (await import(configUrl)) as {
      default?: PartialRemixConfig;
    };

    return remixConfigModule.default ?? {};
  } catch (e: unknown) {
    clack.log.error(`Couldn't load ${REMIX_CONFIG_FILE}.`);
    clack.log.info(chalk.dim(formatError(e)));

    return {};
  }
}

export async function instrumentRootRoute(isTS?: boolean): Promise<void> {
  const rootFilename = `root.${isTS ? "tsx" : "jsx"}`;

  await instrumentRoot(rootFilename);

  clack.log.success(
    `Successfully instrumented root route ${chalk.cyan(rootFilename)}.`,
  );
}

export async function updateBuildScript(args: {
  org: string;
  project: string;
  url?: string | undefined;
  isHydrogen: boolean;
}): Promise<void> {
  const packageJson = await getPackageDotJson();

  if (!packageJson.scripts) {
    packageJson.scripts = {};
  }

  const buildCommand = args.isHydrogen
    ? "shopify hydrogen build"
    : "remix build";

  const instrumentedBuildCommand =
    `${buildCommand} --sourcemap && npx @sentry/remix --upload-sourcemaps --org ${args.org} --project ${args.project}` +
    (args.url ? ` --url ${args.url}` : "") +
    (args.isHydrogen ? " --buildPath ./dist" : "");

  if (
    packageJson.scripts["build"]?.includes("@sentry/remix --upload-sourcemaps")
  ) {
    // Already set up by an earlier run; replacing again would duplicate it.
    clack.log.info(
      `${chalk.cyan("build")} script already uploads sourcemaps, skipping.`,
    );
    return;
  }

  if (!packageJson.scripts["build"]) {
    packageJson.scripts["build"] = instrumentedBuildCommand;
  } else if (packageJson.scripts["build"].includes(buildCommand)) {
    packageJson.scripts["build"] = packageJson.scripts["build"].replace(
      buildCommand,
      instrumentedBuildCommand,
    );
  } else {
    throw new Error(
      "`build` script doesn't contain a known build command. Please update it manually.",
    );
  }

  await promises.writeFile(
    path.join(process.cwd(), "package.json"),
    JSON.stringify(packageJson, null, 2),
  );

  clack.log.success(
    `Successfully updated ${chalk.cyan("build")} script in ${chalk.cyan(
      "package.json",
    )} to generate and upload sourcemaps.`,
  );
}

export function updateEntryClientMod(
  originalEntryClientMod: ProxifiedModule,
  dsn: string,
  selectedFeatures: {
    performance: boolean;
    replay: boolean;
  },
  reduceDataCollection: boolean,
): ProxifiedModule {
  const imports = ["init"];
  if (selectedFeatures.replay) {
    imports.push("replayIntegration");
  }
  if (selectedFeatures.performance) {
    imports.push("browserTracingIntegration");
  }
  originalEntryClientMod.imports.$add({
    from: "@sentry/remix",
    imported: imports.join(", "),
  });

  if (selectedFeatures.performance) {
    originalEntryClientMod.imports.$add({
      from: "@remix-run/react",
      imported: "useLocation",
      local: "useLocation",
    });

    originalEntryClientMod.imports.$add({
      from: "@remix-run/react",
      imported: "useMatches",
      local: "useMatches",
    });

    originalEntryClientMod.imports.$add({
      from: "react",
      imported: "useEffect",
      local: "useEffect",
    });
  }

  insertClientInitCall(
    dsn,
    originalEntryClientMod,
    selectedFeatures,
    reduceDataCollection,
  );

  return originalEntryClientMod;
}

export async function initializeSentryOnEntryClient(
  dsn: string,
  isTS: boolean,
  selectedFeatures: {
    performance: boolean;
    replay: boolean;
  },
  reduceDataCollection: boolean,
): Promise<void> {
  const clientEntryFilename = `entry.client.${isTS ? "tsx" : "jsx"}`;

  const originalEntryClient = path.join(
    process.cwd(),
    "app",
    clientEntryFilename,
  );

  const originalEntryClientMod = await loadFile(originalEntryClient);

  if (hasSentryContent(originalEntryClient, originalEntryClientMod.$code)) {
    return;
  }

  const updatedEntryClientMod = updateEntryClientMod(
    originalEntryClientMod,
    dsn,
    selectedFeatures,
    reduceDataCollection,
  );

  await writeFile(
    updatedEntryClientMod.$ast,
    path.join(process.cwd(), "app", clientEntryFilename),
  );

  clack.log.success(
    `Successfully initialized Sentry on client entry point ${chalk.cyan(
      clientEntryFilename,
    )}`,
  );
}

export async function updateStartScript(instrumentationFile: string) {
  const packageJson = await getPackageDotJson();

  if (!packageJson.scripts?.["start"]) {
    throw new Error(
      "Couldn't find a `start` script in your package.json. Please add one manually.",
    );
  }

  if (packageJson.scripts["start"].includes("NODE_OPTIONS")) {
    clack.log.warn(
      `Found existing NODE_OPTIONS in ${chalk.cyan(
        "start",
      )} script. Skipping adding Sentry initialization.`,
    );

    return;
  }

  if (
    !packageJson.scripts["start"].includes("remix-serve") &&
    // Adding a following empty space not to match a path that includes `node`
    !packageJson.scripts["start"].includes("node ")
  ) {
    clack.log.warn(
      `Found a ${chalk.cyan("start")} script that doesn't use ${chalk.cyan(
        "remix-serve",
      )} or ${chalk.cyan("node")}. Skipping adding Sentry initialization.`,
    );

    return;
  }

  const startCommand = packageJson.scripts["start"];

  packageJson.scripts["start"] =
    `NODE_OPTIONS='--import ./${instrumentationFile}' ${startCommand}`;

  await promises.writeFile(
    path.join(process.cwd(), "package.json"),
    JSON.stringify(packageJson, null, 2),
  );

  clack.log.success(
    `Successfully updated ${chalk.cyan("start")} script in ${chalk.cyan(
      "package.json",
    )} to include Sentry initialization on start.`,
  );
}

export async function instrumentSentryOnEntryServer(
  isTS: boolean,
): Promise<void> {
  const serverEntryFilename = `entry.server.${isTS ? "tsx" : "jsx"}`;

  const originalEntryServer = path.join(
    process.cwd(),
    "app",
    serverEntryFilename,
  );

  const originalEntryServerMod = await loadFile(originalEntryServer);

  if (hasSentryContent(originalEntryServer, originalEntryServerMod.$code)) {
    return;
  }

  originalEntryServerMod.imports.$add({
    from: "@sentry/remix",
    imported: "*",
    local: "Sentry",
  });

  const handleErrorInstrumented = instrumentHandleError(
    originalEntryServerMod,
    serverEntryFilename,
  );

  if (handleErrorInstrumented) {
    clack.log.success(
      `Instrumented ${chalk.cyan("handleError")} in ${chalk.cyan(
        serverEntryFilename,
      )}`,
    );
  }

  await writeFile(
    originalEntryServerMod.$ast,
    path.join(process.cwd(), "app", serverEntryFilename),
  );

  clack.log.success(
    `Successfully initialized Sentry on server entry point ${chalk.cyan(
      serverEntryFilename,
    )}.`,
  );
}
