/**
 * Add `Sentry.init` to a React Native app's entry file and wrap its root
 * component with `Sentry.wrap`.
 */

import { clack } from "../utils/clack/prompts.js";
import { reportCliError } from "../../error-reporting.js";
import chalk from "chalk";
import path from "node:path";
import { cwd } from "node:process";
import { readFileSync, writeFileSync } from "node:fs";
import { Sentry } from "../telemetry.js";

import { traceStep } from "../telemetry.js";
import {
  makeCodeSnippet,
  showCopyPasteInstructions,
} from "../utils/clack/index.js";
import { getFirstMatchedPath } from "./glob.js";
import { RN_SDK_PACKAGE } from "./react-native-wizard.js";
import { preserveTrailingNewline } from "../utils/ast-utils.js";

import { generateCode, type ProxifiedModule, parseModule } from "magicast";
import recast from "recast";
import type { namedTypes as t } from "ast-types";

const n = recast.types.namedTypes;
const b = recast.types.builders;

export const sessionReplaySampleRate = 0.1;
export const sessionReplayOnErrorSampleRate = 1.0;

export async function addSentryInit({
  dsn,
  enableSessionReplay = false,
  enableFeedbackWidget = false,
  enableLogs = false,
}: {
  dsn: string;
  enableSessionReplay?: boolean | undefined;
  enableFeedbackWidget?: boolean | undefined;
  enableLogs?: boolean | undefined;
}) {
  const jsPath = getMainAppFilePath();
  Sentry.setTag("app-js-file-status", jsPath ? "found" : "not-found");
  if (!jsPath) {
    clack.log.warn(
      `Could not find main App file. Place the following code snippet close to the Apps Root component.`,
    );
    reportCliError(new Error("Could not find main App file."));
    await showCopyPasteInstructions({
      filename: "App.js or _layout.tsx",
      codeSnippet: getSentryInitColoredCodeSnippet(
        dsn,
        enableSessionReplay,
        enableFeedbackWidget,
        enableLogs,
      ),
      hint: "This ensures the Sentry SDK is ready to capture errors.",
    });
    return;
  }
  const jsRelativePath = path.relative(cwd(), jsPath);

  const js = readFileSync(jsPath, "utf-8");
  const includesSentry = doesJsCodeIncludeSdkSentryImport(js, {
    sdkPackageName: RN_SDK_PACKAGE,
  });
  if (includesSentry) {
    Sentry.setTag("app-js-file-status", "already-includes-sentry");
    clack.log.warn(
      `${chalk.cyan(
        jsRelativePath,
      )} already includes Sentry. We wont't add it again.`,
    );
    return;
  }

  const newContent = addSentryInitWithSdkImport(js, {
    dsn,
    enableSessionReplay,
    enableFeedbackWidget,
    enableLogs,
  });
  if (newContent === js) {
    Sentry.setTag("app-js-file-status", "no-import-found");
    clack.log.warn(
      `Could not find an import in ${chalk.cyan(jsRelativePath)}. Place the following code snippet close to the Apps Root component.`,
    );
    await showCopyPasteInstructions({
      filename: jsRelativePath,
      codeSnippet: getSentryInitColoredCodeSnippet(
        dsn,
        enableSessionReplay,
        enableFeedbackWidget,
        enableLogs,
      ),
      hint: "This ensures the Sentry SDK is ready to capture errors.",
    });
    return;
  }

  traceStep("add-sentry-init", () => {
    try {
      writeFileSync(jsPath, newContent, "utf-8");
      clack.log.success(
        `Added ${chalk.cyan("Sentry.init")} to ${chalk.cyan(jsRelativePath)}.`,
      );
    } catch (error) {
      clack.log.error(`Error while writing ${jsPath}`);
      reportCliError(new Error("Error while writing app.js"));
    }
  });

  Sentry.setTag("app-js-file-status", "added-sentry-init");
  clack.log.success(
    chalk.green(`${chalk.cyan(jsRelativePath)} changes saved.`),
  );
}

export function addSentryInitWithSdkImport(
  js: string,
  {
    dsn,
    enableSessionReplay = false,
    enableFeedbackWidget = false,
    enableLogs = false,
  }: {
    dsn: string;
    enableSessionReplay?: boolean | undefined;
    enableFeedbackWidget?: boolean | undefined;
    enableLogs?: boolean | undefined;
  },
): string {
  return js.replace(
    // The last import statement: one ending in `;`, or a line-start import
    // whose module specifier ends the line (no semicolon).
    /^([^]*)(import\s+[^;]*?;$|^import\s(?:[^;]*?\sfrom\s*)?['"][^'"\n]+['"][ \t]*$)/m,
    (match: string) => `${match}
${getSentryInitPlainTextSnippet(
  dsn,
  enableSessionReplay,
  enableFeedbackWidget,
  enableLogs,
)}`,
  );
}

export function doesJsCodeIncludeSdkSentryImport(
  js: string,
  { sdkPackageName }: { sdkPackageName: string },
): boolean {
  return !!js.match(sdkPackageName);
}

export function getSentryInitColoredCodeSnippet(
  dsn: string,
  enableSessionReplay = false,
  enableFeedbackWidget = false,
  enableLogs = false,
) {
  return makeCodeSnippet(true, (_unchanged, plus, _minus) => {
    return plus(
      getSentryInitPlainTextSnippet(
        dsn,
        enableSessionReplay,
        enableFeedbackWidget,
        enableLogs,
      ),
    );
  });
}

export function getSentryInitPlainTextSnippet(
  dsn: string,
  enableSessionReplay = false,
  enableFeedbackWidget = false,
  enableLogs = false,
) {
  return `import * as Sentry from '@sentry/react-native';

Sentry.init({
  dsn: '${dsn}',

  // Adds more context data to events (IP address, cookies, user, etc.)
  // For more information, visit: https://docs.sentry.io/platforms/react-native/data-management/data-collected/
  sendDefaultPii: true,

  // Enable Logs
  enableLogs: ${enableLogs ? "true" : "false"},
${
  enableSessionReplay
    ? `
  // Configure Session Replay
  replaysSessionSampleRate: ${sessionReplaySampleRate},
  replaysOnErrorSampleRate: ${sessionReplayOnErrorSampleRate},
`
    : ""
}${getSentryIntegrationsPlainTextSnippet(
    enableSessionReplay,
    enableFeedbackWidget,
  )}
  // uncomment the line below to enable Spotlight (https://spotlightjs.com)
  // spotlight: __DEV__,
});`;
}

export function getSentryIntegrationsPlainTextSnippet(
  enableSessionReplay = false,
  enableFeedbackWidget = false,
) {
  if (!enableSessionReplay && !enableFeedbackWidget) {
    return "";
  }
  return `  integrations: [${
    enableSessionReplay ? "Sentry.mobileReplayIntegration()" : ""
  }${enableSessionReplay && enableFeedbackWidget ? ", " : ""}${
    enableFeedbackWidget ? "Sentry.feedbackIntegration()" : ""
  }],
`;
}

function getMainAppFilePath(): string | undefined {
  const prefixGlob = "{.,./src,./app}";
  const suffixGlob = "@(j|t|cj|mj)s?(x)";
  const universalGlob = `@(App|_layout).${suffixGlob}`;
  const jsFileGlob = `${prefixGlob}/+(${universalGlob})`;
  const jsPath = traceStep("find-app-js-file", () =>
    getFirstMatchedPath(jsFileGlob),
  );
  return jsPath;
}

/**
 * This step should be executed after `addSentryInit`
 */
export async function wrapRootComponent() {
  const showInstructions = () =>
    showCopyPasteInstructions({
      filename: "App.js or _layout.tsx",
      codeSnippet: getSentryWrapColoredCodeSnippet(),
    });

  const jsPath = getMainAppFilePath();
  Sentry.setTag("app-js-file-status", jsPath ? "found" : "not-found");
  if (!jsPath) {
    clack.log.warn(
      `Could not find main App file. Please wrap your App's Root component.`,
    );
    await showInstructions();
    return;
  }

  const jsRelativePath = path.relative(cwd(), jsPath);

  const js = readFileSync(jsPath, "utf-8");

  const mod = parseModule(js);
  const result = checkAndWrapRootComponent(mod);

  if (result === SentryWrapResult.AlreadyWrapped) {
    Sentry.setTag("app-js-file-status", "already-includes-sentry-wrap");
    clack.log.warn(
      `${chalk.cyan(
        jsRelativePath,
      )} already includes Sentry.wrap. We wont't add it again.`,
    );
    return;
  }

  if (result === SentryWrapResult.NotFound) {
    clack.log.warn(
      `Could not find your App's Root component. Please wrap your App's Root component manually.`,
    );
    await showInstructions();
    return;
  }

  traceStep("add-sentry-wrap", () => {
    try {
      const code = preserveTrailingNewline(js, generateCode(mod.$ast).code);
      writeFileSync(jsPath, code, "utf-8");
      clack.log.success(
        `Added ${chalk.cyan("Sentry.wrap")} to ${chalk.cyan(jsRelativePath)}.`,
      );
    } catch (error) {
      clack.log.error(`Error while writing ${jsPath}`);
      reportCliError(new Error("Error while writing app.js"));
      return;
    }
  });

  Sentry.setTag("app-js-file-status", "added-sentry-wrap");
  clack.log.success(
    chalk.green(`${chalk.cyan(jsRelativePath)} changes saved.`),
  );
}

/** The outcome of {@link checkAndWrapRootComponent}. */
export const SentryWrapResult = {
  NotFound: "RootComponentNotFound",
  AlreadyWrapped: "AlreadyWrapped",
  Success: "Success",
} as const;

/** One of the {@link SentryWrapResult} values. */
export type SentryWrapResult =
  (typeof SentryWrapResult)[keyof typeof SentryWrapResult];

export function checkAndWrapRootComponent(
  mod: ProxifiedModule,
): SentryWrapResult {
  if (doesContainSentryWrap(mod.$ast as t.Program)) {
    return SentryWrapResult.AlreadyWrapped;
  }

  const defaultExport = getDefaultExport(mod.$ast as t.Program);
  if (!defaultExport) {
    return SentryWrapResult.NotFound;
  }

  const wrappedConfig = wrapWithSentry(defaultExport);

  const replacedDefaultExport = replaceDefaultExport(
    mod.$ast as t.Program,
    wrappedConfig,
  );

  if (!replacedDefaultExport) {
    return SentryWrapResult.NotFound;
  }

  return SentryWrapResult.Success;
}

export function getDefaultExport(
  program: t.Program,
):
  | t.Identifier
  | t.CallExpression
  | t.ObjectExpression
  | t.FunctionDeclaration
  | t.ArrowFunctionExpression
  | t.ClassDeclaration
  | undefined {
  for (const node of program.body) {
    if (
      n.ExportDefaultDeclaration.check(node) &&
      (n.Identifier.check(node.declaration) ||
        n.CallExpression.check(node.declaration) ||
        n.ObjectExpression.check(node.declaration) ||
        n.FunctionDeclaration.check(node.declaration) ||
        n.ArrowFunctionExpression.check(node.declaration) ||
        n.ClassDeclaration.check(node.declaration))
    ) {
      Sentry.setTag("app-js-file-status", "default-export");
      return node.declaration;
    }
  }

  Sentry.setTag("app-js-file-status", "default-export-not-found");
  return undefined;
}

export function wrapWithSentry(
  configObj:
    | t.Identifier
    | t.CallExpression
    | t.ObjectExpression
    | t.FunctionDeclaration
    | t.ArrowFunctionExpression
    | t.ClassDeclaration,
): t.CallExpression {
  if (n.FunctionDeclaration.check(configObj)) {
    return b.callExpression(
      b.memberExpression(b.identifier("Sentry"), b.identifier("wrap")),
      [
        b.functionExpression.from({
          id: configObj.id ?? null,
          params: configObj.params,
          body: configObj.body,
          generator: configObj.generator ?? false,
          async: configObj.async ?? false,
        }),
      ],
    );
  }

  if (n.ArrowFunctionExpression.check(configObj)) {
    return b.callExpression(
      b.memberExpression(b.identifier("Sentry"), b.identifier("wrap")),
      [configObj],
    );
  }

  if (n.ClassDeclaration.check(configObj)) {
    return b.callExpression(
      b.memberExpression(b.identifier("Sentry"), b.identifier("wrap")),
      [
        b.classExpression.from({
          id: configObj.id ?? null,
          superClass: configObj.superClass ?? null,
          body: configObj.body,
          decorators: configObj.decorators ?? null,
        }),
      ],
    );
  }

  return b.callExpression(
    b.memberExpression(b.identifier("Sentry"), b.identifier("wrap")),
    [configObj],
  );
}

export function replaceDefaultExport(
  program: t.Program,
  wrappedDefaultExport: t.CallExpression,
): boolean {
  for (const node of program.body) {
    if (n.ExportDefaultDeclaration.check(node)) {
      node.declaration = wrappedDefaultExport;
      return true;
    }
  }
  return false;
}

export function doesContainSentryWrap(program: t.Program): boolean {
  for (const node of program.body) {
    if (n.ExportDefaultDeclaration.check(node)) {
      const declaration = node.declaration;
      if (n.CallExpression.check(declaration)) {
        const callExpr = declaration;
        if (n.MemberExpression.check(callExpr.callee)) {
          const callee = callExpr.callee;
          if (
            n.Identifier.check(callee.object) &&
            callee.object.name === "Sentry" &&
            n.Identifier.check(callee.property) &&
            callee.property.name === "wrap"
          ) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

function getSentryWrapColoredCodeSnippet() {
  return makeCodeSnippet(true, (_unchanged, plus, _minus) => {
    return plus(`import * as Sentry from '@sentry/react-native';

export default Sentry.wrap(App);`);
  });
}
