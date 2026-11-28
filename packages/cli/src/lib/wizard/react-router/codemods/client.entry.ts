/**
 * Adds `Sentry.init` and the HydratedRouter error handler to a React Router
 * app's `entry.client` file.
 */

import recast from "recast";
import type { namedTypes as t } from "ast-types";
import type { ExpressionKind } from "ast-types/lib/gen/kinds";

import { clack } from "../../utils/clack/prompts.js";
import chalk from "chalk";

import { loadFile, writeFile } from "magicast";
import { hasSentryContent } from "../../utils/ast-utils.js";
import { getDataCollectionBlock } from "../templates.js";
import { getAfterImportsInsertionIndex } from "./utils.js";

// oxlint-disable-next-line max-params -- positional like the sentry-wizard original and its tests
export async function instrumentClientEntry(
  clientEntryPath: string,
  dsn: string,
  enableTracing: boolean,
  enableReplay: boolean,
  reduceDataCollection: boolean,
  useInstrumentationAPI = false,
  useOnError = false,
): Promise<void> {
  const clientEntryAst = await loadFile(clientEntryPath);

  const alreadyHasSentry = hasSentryContent(clientEntryAst.$ast as t.Program);

  if (!alreadyHasSentry) {
    clientEntryAst.imports.$add({
      from: "@sentry/react-router",
      imported: "*",
      local: "Sentry",
    });

    let initContent: string;

    if (useInstrumentationAPI && enableTracing) {
      const integrations = ["tracing"];
      if (enableReplay) {
        integrations.push("Sentry.replayIntegration()");
      }

      initContent = `
const tracing = Sentry.reactRouterTracingIntegration();

Sentry.init({
  dsn: "${dsn}",
${getDataCollectionBlock(reduceDataCollection)}
  integrations: [${integrations.join(", ")}],
  tracesSampleRate: 1.0,
  tracePropagationTargets: [/^\\//, /^https:\\/\\/yourserver\\.io\\/api/],${
    enableReplay
      ? "\n  replaysSessionSampleRate: 0.1,\n  replaysOnErrorSampleRate: 1.0,"
      : ""
  }
});`;
    } else {
      const integrations = [];
      if (enableTracing) {
        integrations.push("Sentry.reactRouterTracingIntegration()");
      }
      if (enableReplay) {
        integrations.push("Sentry.replayIntegration()");
      }

      initContent = `
Sentry.init({
  dsn: "${dsn}",
${getDataCollectionBlock(reduceDataCollection)}
  integrations: [${integrations.join(", ")}],
  tracesSampleRate: ${enableTracing ? "1.0" : "0"},${
    enableTracing
      ? "\n  tracePropagationTargets: [/^\\//, /^https:\\/\\/yourserver\\.io\\/api/],"
      : ""
  }${
    enableReplay
      ? "\n  replaysSessionSampleRate: 0.1,\n  replaysOnErrorSampleRate: 1.0,"
      : ""
  }
});`;
    }

    (clientEntryAst.$ast as t.Program).body.splice(
      getAfterImportsInsertionIndex(clientEntryAst.$ast as t.Program),
      0,
      ...recast.parse(initContent).program.body,
    );
  }

  const useInstrAPI = useInstrumentationAPI && enableTracing;
  const addInstrProp = useInstrAPI && !alreadyHasSentry;

  if (addInstrProp) {
    addInstrumentationPropsToHydratedRouter(clientEntryAst.$ast as t.Program);
  }

  if (useOnError) {
    addOnErrorToHydratedRouter(clientEntryAst.$ast as t.Program);
  }

  // Emit a single warning if HydratedRouter wasn't found for any prop we tried to add
  if (
    (addInstrProp || useOnError) &&
    !hasHydratedRouter(clientEntryAst.$ast as t.Program)
  ) {
    const props: string[] = [];
    if (useOnError) {
      props.push("onError={Sentry.sentryOnError}");
    }
    if (addInstrProp) {
      props.push("instrumentations={[tracing.clientInstrumentation]}");
    }
    clack.log.warn(
      `Could not find ${chalk.cyan(
        "HydratedRouter",
      )} component in your client entry file.\n` +
        `Manually add the following props:\n` +
        `  ${chalk.green(`<HydratedRouter ${props.join(" ")} />`)}`,
    );
  }

  await writeFile(clientEntryAst.$ast, clientEntryPath);
}

function hasHydratedRouter(ast: t.Program): boolean {
  let found = false;
  recast.visit(ast, {
    visitJSXElement(path) {
      const name = path.node.openingElement.name;
      if (name.type === "JSXIdentifier" && name.name === "HydratedRouter") {
        found = true;
        return false;
      }
      this.traverse(path);
      return undefined;
    },
  });
  return found;
}

function addPropToHydratedRouter(
  ast: t.Program,
  propName: string,
  propValue: ExpressionKind,
): boolean {
  let found = false;

  recast.visit(ast, {
    visitJSXElement(path) {
      const openingElement = path.node.openingElement;

      if (
        openingElement.name.type === "JSXIdentifier" &&
        openingElement.name.name === "HydratedRouter"
      ) {
        found = true;

        const hasProp = openingElement.attributes?.some(
          (attr) =>
            attr.type === "JSXAttribute" &&
            attr.name.type === "JSXIdentifier" &&
            attr.name.name === propName,
        );

        if (!hasProp) {
          const prop = recast.types.builders.jsxAttribute(
            recast.types.builders.jsxIdentifier(propName),
            recast.types.builders.jsxExpressionContainer(propValue),
          );

          if (!openingElement.attributes) {
            openingElement.attributes = [];
          }
          openingElement.attributes.push(prop);
        }

        return false;
      }

      this.traverse(path);
      return undefined;
    },
  });

  return found;
}

function addOnErrorToHydratedRouter(ast: t.Program): boolean {
  return addPropToHydratedRouter(
    ast,
    "onError",
    recast.types.builders.memberExpression(
      recast.types.builders.identifier("Sentry"),
      recast.types.builders.identifier("sentryOnError"),
    ),
  );
}

function addInstrumentationPropsToHydratedRouter(ast: t.Program): boolean {
  return addPropToHydratedRouter(
    ast,
    "instrumentations",
    recast.types.builders.arrayExpression([
      recast.types.builders.memberExpression(
        recast.types.builders.identifier("tracing"),
        recast.types.builders.identifier("clientInstrumentation"),
      ),
    ]),
  );
}
