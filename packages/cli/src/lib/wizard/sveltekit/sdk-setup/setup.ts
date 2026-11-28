/**
 * Creates or merges the SvelteKit hooks and `instrumentation.server` files
 * that initialize the Sentry SDK.
 */

import { promises } from "node:fs";
import path from "node:path";
import chalk from "chalk";

import { Sentry } from "../../telemetry.js";

import { clack } from "../../utils/clack/prompts.js";
import type { ProxifiedModule } from "magicast";
import { builders, generateCode, loadFile } from "magicast";
import {
  getClientHooksTemplate,
  getInstrumentationServerTemplate,
  getServerHooksTemplate,
} from "../templates.js";
import {
  featureSelectionPrompt,
  isUsingTypeScript,
  showCopyPasteInstructions,
} from "../../utils/clack/index.js";
import { findFile } from "../../../dsn/fs-utils.js";
import { hasSentryContent } from "../../utils/ast-utils.js";
import { getDataCollectionSnippet } from "../../utils/data-collection.js";

import recast from "recast";
import type { namedTypes as t } from "ast-types";
import {
  enableTracingAndInstrumentation,
  type PartialBackwardsForwardsCompatibleSvelteConfig,
} from "./svelte-config.js";
import type { ProjectInfo } from "./types.js";
import { modifyViteConfig } from "./vite.js";
import { modifyAndRecordFail } from "./utils.js";
import { debug } from "../../utils/debug.js";

export async function createOrMergeSvelteKitFiles(
  projectInfo: ProjectInfo,
  svelteConfig: PartialBackwardsForwardsCompatibleSvelteConfig,
  setupForSvelteKitTracing: boolean,
): Promise<void> {
  const selectedFeatures = await featureSelectionPrompt([
    {
      id: "performance",
      prompt: `Do you want to enable ${chalk.bold(
        "Tracing",
      )} to track the performance of your application?`,
      enabledHint: "recommended",
    },
    {
      id: "replay",
      prompt: `Do you want to enable ${chalk.bold(
        "Session Replay",
      )} to get a video-like reproduction of errors during a user session?`,
      enabledHint: "recommended, but increases bundle size",
    },
  ] as const);

  const { clientHooksPath, serverHooksPath } = getHooksConfigDirs(svelteConfig);

  // full file paths with correct file ending (or undefined if not found)
  const originalClientHooksFile = await findFile(clientHooksPath);
  const originalServerHooksFile = await findFile(serverHooksPath);
  const originalInstrumentationServerFile = await findFile(
    path.resolve(process.cwd(), "src", "instrumentation.server"),
  );

  const viteConfig = await findFile(path.resolve(process.cwd(), "vite.config"));

  const fileEnding = isUsingTypeScript() ? "ts" : "js";

  const { dsn, reduceDataCollection } = projectInfo;

  if (setupForSvelteKitTracing) {
    await enableTracingAndInstrumentation(
      svelteConfig,
      selectedFeatures.performance,
    );

    try {
      if (!originalInstrumentationServerFile) {
        await createNewInstrumentationServerFile(
          dsn,
          selectedFeatures,
          reduceDataCollection,
        );
      } else {
        await mergeInstrumentationServerFile(
          originalInstrumentationServerFile,
          dsn,
          selectedFeatures,
          reduceDataCollection,
        );
      }
    } catch (e) {
      clack.log.warn(
        `Failed to automatically set up ${chalk.cyan(
          `instrumentation.server.${fileEnding}`,
        )}.`,
      );
      debug(e);

      await showCopyPasteInstructions({
        codeSnippet: getInstrumentationServerTemplate(
          dsn,
          selectedFeatures,
          reduceDataCollection,
        ),
        filename: `instrumentation.server.${fileEnding}`,
      });

      Sentry.setTag("created-instrumentation-server", "fail");
    }
  }

  Sentry.setTag(
    "server-hooks-file-strategy",
    originalServerHooksFile ? "merge" : "create",
  );

  if (!originalServerHooksFile) {
    await createNewHooksFile(
      `${serverHooksPath}.${fileEnding}`,
      "server",
      dsn,
      selectedFeatures,
      !setupForSvelteKitTracing,
      reduceDataCollection,
    );
  } else {
    await mergeHooksFile(
      originalServerHooksFile,
      "server",
      dsn,
      selectedFeatures,
      !setupForSvelteKitTracing,
      reduceDataCollection,
    );
  }

  Sentry.setTag(
    "client-hooks-file-strategy",
    originalClientHooksFile ? "merge" : "create",
  );
  if (!originalClientHooksFile) {
    await createNewHooksFile(
      `${clientHooksPath}.${fileEnding}`,
      "client",
      dsn,
      selectedFeatures,
      true,
      reduceDataCollection,
    );
  } else {
    await mergeHooksFile(
      originalClientHooksFile,
      "client",
      dsn,
      selectedFeatures,
      true,
      reduceDataCollection,
    );
  }

  if (viteConfig) {
    await modifyViteConfig(viteConfig, projectInfo);
  }
}

/**
 * Attempts to read the svelte.config.js file to find the location of the hooks files.
 * If users specified a custom location, we'll use that. Otherwise, we'll use the default.
 */
function getHooksConfigDirs(
  svelteConfig: PartialBackwardsForwardsCompatibleSvelteConfig,
): {
  clientHooksPath: string;
  serverHooksPath: string;
} {
  const relativeUserClientHooksPath = svelteConfig.kit?.files?.hooks?.client;
  const relativeUserServerHooksPath = svelteConfig.kit?.files?.hooks?.server;
  const userClientHooksPath =
    relativeUserClientHooksPath &&
    path.resolve(process.cwd(), relativeUserClientHooksPath);
  const userServerHooksPath =
    relativeUserServerHooksPath &&
    path.resolve(process.cwd(), relativeUserServerHooksPath);

  const defaulHooksDir = path.resolve(process.cwd(), "src");
  const defaultClientHooksPath = path.resolve(defaulHooksDir, "hooks.client"); // file ending missing on purpose
  const defaultServerHooksPath = path.resolve(defaulHooksDir, "hooks.server"); // same here

  return {
    clientHooksPath: userClientHooksPath || defaultClientHooksPath,
    serverHooksPath: userServerHooksPath || defaultServerHooksPath,
  };
}

/**
 * Reads the template, replaces the dsn placeholder with the actual dsn and writes the file to @param hooksFileDest
 */
// oxlint-disable-next-line max-params -- positional like the sentry-wizard original and its tests
async function createNewHooksFile(
  hooksFileDest: string,
  hooktype: "client" | "server",
  dsn: string,
  selectedFeatures: {
    performance: boolean;
    replay: boolean;
  },
  setupForSvelteKitTracing: boolean,
  reduceDataCollection: boolean,
): Promise<void> {
  const filledTemplate =
    hooktype === "client"
      ? getClientHooksTemplate(dsn, selectedFeatures, reduceDataCollection)
      : getServerHooksTemplate(
          dsn,
          selectedFeatures,
          setupForSvelteKitTracing,
          reduceDataCollection,
        );

  await promises.mkdir(path.dirname(hooksFileDest), { recursive: true });
  await promises.writeFile(hooksFileDest, filledTemplate);

  clack.log.success(`Created ${hooksFileDest}`);
  Sentry.setTag(`created-${hooktype}-hooks`, "success");
}

async function createNewInstrumentationServerFile(
  dsn: string,
  selectedFeatures: {
    performance: boolean;
  },
  reduceDataCollection: boolean,
): Promise<void> {
  const filledTemplate = getInstrumentationServerTemplate(
    dsn,
    selectedFeatures,
    reduceDataCollection,
  );

  const fileEnding = isUsingTypeScript() ? "ts" : "js";

  const instrumentationServerFile = path.resolve(
    process.cwd(),
    "src",
    `instrumentation.server.${fileEnding}`,
  );

  await promises.mkdir(path.dirname(instrumentationServerFile), {
    recursive: true,
  });

  await promises.writeFile(instrumentationServerFile, filledTemplate);

  clack.log.success(
    `Created ${chalk.cyan(path.basename(instrumentationServerFile))}`,
  );
  Sentry.setTag("created-instrumentation-server", "success");
}

/**
 * Merges the users' hooks file with Sentry-related code.
 *
 * Both hooks:
 * - add import * as Sentry
 * - add Sentry.init
 * - add handleError hook wrapper
 *
 * Additionally in  Server hook:
 * - add handle hook handler
 */
// oxlint-disable-next-line max-params -- positional like the sentry-wizard original and its tests
async function mergeHooksFile(
  hooksFile: string,
  hookType: "client" | "server",
  dsn: string,
  selectedFeatures: {
    performance: boolean;
    replay: boolean;
  },
  includeSentryInit: boolean,
  reduceDataCollection: boolean,
): Promise<void> {
  const originalHooksMod = await loadFile(hooksFile);

  const file: "server-hooks" | "client-hooks" = `${hookType}-hooks`;

  if (hasSentryContent(originalHooksMod.$ast as t.Program)) {
    // We don't want to mess with files that already have Sentry content.
    // Let's just bail out at this point.
    clack.log.warn(
      `File ${chalk.cyan(
        path.basename(hooksFile),
      )} already contains Sentry code.
Skipping adding Sentry functionality to.`,
    );
    Sentry.setTag(`modified-${file}`, "fail");
    Sentry.setTag(`${file}-fail-reason`, "has-sentry-content");
    return;
  }

  await modifyAndRecordFail(
    () =>
      originalHooksMod.imports.$add({
        from: "@sentry/sveltekit",
        imported: "*",
        local: "Sentry",
      }),
    "import-injection",
    file,
  );

  if (hookType === "client" || includeSentryInit) {
    await modifyAndRecordFail(
      () => {
        if (hookType === "client") {
          insertClientInitCall(
            dsn,
            originalHooksMod,
            selectedFeatures,
            reduceDataCollection,
          );
        } else {
          insertServerInitCall(
            dsn,
            originalHooksMod,
            selectedFeatures,
            reduceDataCollection,
          );
        }
      },
      "init-call-injection",
      file,
    );
  }

  await modifyAndRecordFail(
    () => wrapHandleError(originalHooksMod),
    "wrap-handle-error",
    file,
  );

  if (hookType === "server") {
    await modifyAndRecordFail(
      () => wrapHandle(originalHooksMod),
      "wrap-handle",
      "server-hooks",
    );
  }

  await modifyAndRecordFail(
    async () => {
      const modifiedCode = originalHooksMod.generate().code;
      await promises.writeFile(hooksFile, modifiedCode);
    },
    "write-file",
    file,
  );

  clack.log.success(`Added Sentry code to ${hooksFile}`);
  Sentry.setTag(`modified-${hookType}-hooks`, "success");
}

/**
 * Merges the users' instrumentation.server file with Sentry-related code.
 *
 * Both hooks:
 * - add import * as Sentry
 * - add Sentry.init
 * - add handleError hook wrapper
 *
 * Additionally in  Server hook:
 * - add handle hook handler
 */
async function mergeInstrumentationServerFile(
  instrumentationServerFilePath: string,
  dsn: string,
  selectedFeatures: {
    performance: boolean;
    replay: boolean;
  },
  reduceDataCollection: boolean,
): Promise<void> {
  const originalInstrumentationServerMod = await loadFile(
    instrumentationServerFilePath,
  );
  const filename = path.basename(instrumentationServerFilePath);

  if (hasSentryContent(originalInstrumentationServerMod.$ast as t.Program)) {
    // We don't want to mess with files that already have Sentry content.
    // Let's just bail out at this point.
    clack.log.warn(
      `File ${chalk.cyan(filename)} already contains Sentry code.
Skipping adding Sentry functionality to it.`,
    );
    Sentry.setTag(`modified-instrumentation-server`, "fail");
    Sentry.setTag(`instrumentation-server-fail-reason`, "has-sentry-content");
    return;
  }

  await modifyAndRecordFail(
    () =>
      originalInstrumentationServerMod.imports.$add({
        from: "@sentry/sveltekit",
        imported: "*",
        local: "Sentry",
      }),
    "import-injection",
    "instrumentation-server",
  );

  await modifyAndRecordFail(
    () => {
      insertServerInitCall(
        dsn,
        originalInstrumentationServerMod,
        selectedFeatures,
        reduceDataCollection,
      );
    },
    "init-call-injection",
    "instrumentation-server",
  );

  await modifyAndRecordFail(
    async () => {
      const modifiedCode = originalInstrumentationServerMod.generate().code;
      await promises.writeFile(instrumentationServerFilePath, modifiedCode);
    },
    "write-file",
    "instrumentation-server",
  );

  clack.log.success(`Added Sentry.init code to ${chalk.cyan(filename)}`);
  Sentry.setTag(`modified-instrumentation-server`, "success");
}

const DATA_COLLECTION_HINT = [
  "",
  "    dataCollection: {",
  "      // To disable sending user data and HTTP bodies, uncomment the lines below. For more info visit:",
  "      // https://docs.sentry.io/platforms/javascript/guides/sveltekit/configuration/options/#dataCollection",
  "      // userInfo: false,",
  "      // httpBodies: [],",
  "    },",
].join("\n");

/**
 * The active PII-reducing preset when the user opted in, the commented-out
 * hint otherwise. Spliced into the generated `Sentry.init` code right before
 * the closing `})`.
 */
function getDataCollectionInitCode(reduceDataCollection: boolean): string {
  return reduceDataCollection
    ? `\n${getDataCollectionSnippet("    ")}`
    : DATA_COLLECTION_HINT;
}

export function insertClientInitCall(
  dsn: string,
  originalHooksMod: ProxifiedModule,
  selectedFeatures: {
    performance: boolean;
    replay: boolean;
  },
  reduceDataCollection: boolean,
): void {
  const initCallComment = `
    // If you don't want to use Session Replay, remove the \`Replay\` integration,
    // \`replaysSessionSampleRate\` and \`replaysOnErrorSampleRate\` options.`;

  const initArgs: {
    dsn: string;
    tracesSampleRate?: number;
    replaysSessionSampleRate?: number;
    replaysOnErrorSampleRate?: number;
    integrations?: string[];
  } = {
    dsn,
  };

  if (selectedFeatures.performance) {
    initArgs.tracesSampleRate = 1.0;
  }

  if (selectedFeatures.replay) {
    initArgs.replaysSessionSampleRate = 0.1;
    initArgs.replaysOnErrorSampleRate = 1.0;
    initArgs.integrations = [builders.functionCall("Sentry.replayIntegration")];
  }

  // This assignment of any values is fine because we're just creating a function call in magicast
  const initCall = builders.functionCall("Sentry.init", initArgs);

  const generatedInitCode = generateCode(initCall).code;
  const initCodeWithHint = generatedInitCode.replace(
    /\n\}\)$/,
    `,${getDataCollectionInitCode(reduceDataCollection)}\n})`,
  );

  const initCallWithComment = builders.raw(
    `${initCallComment}\n${initCodeWithHint}`,
  );

  const originalHooksModAST = originalHooksMod.$ast as t.Program;

  const initCallInsertionIndex = getInitCallInsertionIndex(originalHooksModAST);

  originalHooksModAST.body.splice(
    initCallInsertionIndex,
    0,
    // @ts-expect-error - string works here because the AST is proxified by magicast
    generateCode(initCallWithComment).code,
  );
}

function insertServerInitCall(
  dsn: string,
  originalMod: ProxifiedModule,
  selectedFeatures: {
    performance: boolean;
  },
  reduceDataCollection: boolean,
): void {
  const initArgs: {
    dsn: string;
    tracesSampleRate?: number;
  } = {
    dsn,
  };

  if (selectedFeatures.performance) {
    initArgs.tracesSampleRate = 1.0;
  }

  // This assignment of any values is fine because we're just creating a function call in magicast
  const initCall = builders.functionCall("Sentry.init", initArgs);

  const generatedInitCode = generateCode(initCall).code;
  const initCodeWithHint = generatedInitCode.replace(
    /\n\}\)$/,
    `,${getDataCollectionInitCode(reduceDataCollection)}\n})`,
  );

  const originalModAST = originalMod.$ast as t.Program;

  const initCallInsertionIndex = getInitCallInsertionIndex(originalModAST);

  originalModAST.body.splice(
    initCallInsertionIndex,
    0,
    // @ts-expect-error - string works here because the AST is proxified by magicast
    initCodeWithHint,
  );
}

function wrapHandleError(mod: ProxifiedModule): void {
  const modAst = mod.exports.$ast as t.Program;
  const namedExports = modAst.body.filter(
    (node): node is t.ExportNamedDeclaration =>
      node.type === "ExportNamedDeclaration",
  );

  let foundHandleError = false as boolean;

  for (const modExport of namedExports) {
    const declaration = modExport.declaration;
    if (!declaration) {
      continue;
    }
    if (declaration.type === "FunctionDeclaration") {
      if (declaration.id?.name !== "handleError") {
        continue;
      }
      foundHandleError = true;
      const userCode = recast.print(declaration).code;
      mod.exports["handleError"] = builders.raw(
        `Sentry.handleErrorWithSentry(${userCode.replace(
          "handleError",
          "_handleError",
        )})`,
      );
      // because magicast doesn't overwrite the original function export, we need to remove it manually
      modAst.body = modAst.body.filter((node) => node !== modExport);
    } else if (declaration.type === "VariableDeclaration") {
      const declarations = declaration.declarations;
      for (const declaration of declarations) {
        if (
          declaration.type !== "VariableDeclarator" ||
          declaration.id.type !== "Identifier" ||
          declaration.id.name !== "handleError"
        ) {
          continue;
        }
        foundHandleError = true;
        const userCode = declaration.init;
        const stringifiedUserCode = userCode ? recast.print(userCode).code : "";
        // @ts-expect-error - we can just place a string here, magicast will convert it to a node
        declaration.init = `Sentry.handleErrorWithSentry(${stringifiedUserCode})`;
      }
    }
  }

  if (!foundHandleError) {
    mod.exports["handleError"] = builders.functionCall(
      "Sentry.handleErrorWithSentry",
    );
  }
}

function wrapHandle(mod: ProxifiedModule): void {
  const modAst = mod.exports.$ast as t.Program;
  const namedExports = modAst.body.filter(
    (node): node is t.ExportNamedDeclaration =>
      node.type === "ExportNamedDeclaration",
  );

  let foundHandle = false as boolean;

  for (const modExport of namedExports) {
    const declaration = modExport.declaration;
    if (!declaration) {
      continue;
    }
    if (declaration.type === "FunctionDeclaration") {
      if (declaration.id?.name !== "handle") {
        continue;
      }
      foundHandle = true;
      const userCode = recast.print(declaration).code;
      mod.exports["handle"] = builders.raw(
        `sequence(Sentry.sentryHandle(), ${userCode.replace(
          "handle",
          "_handle",
        )})`,
      );
      // because of an issue with magicast, we need to remove the original export
      modAst.body = modAst.body.filter((node) => node !== modExport);
    } else if (declaration.type === "VariableDeclaration") {
      const declarations = declaration.declarations;
      for (const declaration of declarations) {
        if (
          declaration.type !== "VariableDeclarator" ||
          declaration.id.type !== "Identifier" ||
          (declaration.id.name && declaration.id.name !== "handle")
        ) {
          continue;
        }
        const userCode = declaration.init;
        const stringifiedUserCode = userCode ? recast.print(userCode).code : "";
        // @ts-expect-error - we can just place a string here, magicast will convert it to a node
        declaration.init = `sequence(Sentry.sentryHandle(), ${stringifiedUserCode})`;
        foundHandle = true;
      }
    }
  }

  if (!foundHandle) {
    // can't use builders.functionCall here because it doesn't yet
    // support member expressions (Sentry.sentryHandle()) in args
    mod.exports["handle"] = builders.raw("sequence(Sentry.sentryHandle())");
  }

  try {
    mod.imports.$add({
      from: "@sveltejs/kit/hooks",
      imported: "sequence",
      local: "sequence",
    });
  } catch (error) {
    // It's possible sequence is already imported. in this case, magicast throws but that's fine.
    debug(error);
  }
}

/**
 * We want to insert the init call on top of the file but after all import statements
 */
function getInitCallInsertionIndex(originalModAST: t.Program): number {
  // We need to deep-copy here because reverse mutates in place
  const copiedBodyNodes = [...originalModAST.body];
  const lastImportDeclaration = copiedBodyNodes
    .reverse()
    .find((node) => node.type === "ImportDeclaration");

  const initCallInsertionIndex = lastImportDeclaration
    ? originalModAST.body.indexOf(lastImportDeclaration) + 1
    : 0;
  return initCallInsertionIndex;
}
