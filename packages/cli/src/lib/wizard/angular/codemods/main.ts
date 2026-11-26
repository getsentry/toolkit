/**
 * Codemod for the Angular application entry (`src/main.ts`): imports
 * `@sentry/angular` and inserts `Sentry.init()` after the imports.
 */

import type { namedTypes as t } from "ast-types";
import {
  builders,
  generateCode,
  type Proxified,
  type ProxifiedModule,
} from "magicast";
import { getDataCollectionSnippet } from "../../utils/data-collection.js";

/** Add the Sentry import and `Sentry.init()` call to the entry module. */
export function updateAppEntryMod(
  originalAppModuleMod: ProxifiedModule,
  dsn: string,
  selectedFeatures: {
    performance: boolean;
    replay: boolean;
  },
  reduceDataCollection: boolean,
): ProxifiedModule {
  originalAppModuleMod.imports.$add({
    from: "@sentry/angular",
    imported: "*",
    local: "Sentry",
  });

  insertInitCall(
    originalAppModuleMod,
    dsn,
    selectedFeatures,
    reduceDataCollection,
  );

  return originalAppModuleMod;
}

/** Insert `Sentry.init()` with the selected features after the last import. */
function insertInitCall(
  originalAppModuleMod: ProxifiedModule,
  dsn: string,
  selectedFeatures: {
    performance: boolean;
    replay: boolean;
  },
  reduceDataCollection: boolean,
): void {
  const initCallArgs = getInitCallArgs(dsn, selectedFeatures);
  const initCall = builders.functionCall("Sentry.init", initCallArgs);
  const originalAppModuleModAst = originalAppModuleMod.$ast as t.Program;

  const initCallInsertionIndex = getAfterImportsInsertionIndex(
    originalAppModuleModAst,
  );
  const generatedInitCode = generateCode(initCall).code;
  // Magicast can't express comments inside an options object, so splice the
  // commented `dataCollection` preset into the generated code before the
  // closing `})`.
  const initCode = reduceDataCollection
    ? generatedInitCode.replace(
        /\n\}\)$/,
        `,\n${getDataCollectionSnippet("    ")}\n})`,
      )
    : generatedInitCode;

  // magicast's proxied AST turns a code string into its statement node.
  originalAppModuleModAst.body.splice(
    initCallInsertionIndex,
    0,
    initCode as unknown as (typeof originalAppModuleModAst.body)[number],
  );
}

type InitCallArgs = Record<
  string,
  string | number | boolean | Array<Proxified> | Record<string, boolean>
>;

/** The options object of `Sentry.init()` for the selected features. */
export function getInitCallArgs(
  dsn: string,
  selectedFeatures: {
    performance: boolean;
    replay: boolean;
  },
): InitCallArgs {
  const initCallArgs: InitCallArgs = {
    dsn,
  };

  if (selectedFeatures.replay || selectedFeatures.performance) {
    const integrations: Proxified[] = [];
    initCallArgs["integrations"] = integrations;

    if (selectedFeatures.performance) {
      integrations.push(
        builders.functionCall("Sentry.browserTracingIntegration"),
      );
      initCallArgs["tracesSampleRate"] = 1.0;
    }

    if (selectedFeatures.replay) {
      integrations.push(builders.functionCall("Sentry.replayIntegration"));

      initCallArgs["replaysSessionSampleRate"] = 0.1;
      initCallArgs["replaysOnErrorSampleRate"] = 1.0;
    }
  }

  return initCallArgs;
}

/**
 * We want to insert the handleError function just after all imports
 */
function getAfterImportsInsertionIndex(
  originalEntryServerModAST: t.Program,
): number {
  for (let x = originalEntryServerModAST.body.length - 1; x >= 0; x--) {
    if (originalEntryServerModAST.body[x]?.type === "ImportDeclaration") {
      return x + 1;
    }
  }

  return 0;
}
