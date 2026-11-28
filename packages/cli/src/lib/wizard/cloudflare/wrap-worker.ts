/**
 * Wrap the default export of a Cloudflare Worker with `Sentry.withSentry()`.
 */

import type { namedTypes as t } from "ast-types";
import type { ExpressionKind } from "ast-types/lib/gen/kinds.js";
import chalk from "chalk";
import { loadFile, writeFile } from "magicast";
import recast from "recast";

import { hasSentryContent } from "../utils/ast-utils.js";
import { clack } from "../utils/clack/prompts.js";
import {
  DATA_COLLECTION_COMMENT_LINES,
  DATA_COLLECTION_PII_PRESET,
} from "../utils/data-collection.js";

const b = recast.types.builders;

/**
 * Wraps a Cloudflare Worker's default export with Sentry.withSentry()
 *
 * Before:
 * ```
 * export default {
 *   async fetch(request, env, ctx) { ... }
 * } satisfies ExportedHandler<Env>;
 * ```
 *
 * After:
 * ```
 * import * as Sentry from '@sentry/cloudflare';
 *
 * export default Sentry.withSentry(
 *   (env) => ({
 *     dsn: 'your-dsn',
 *     tracesSampleRate: 1,
 *   }),
 *   {
 *     async fetch(request, env, ctx) { ... }
 *   } satisfies ExportedHandler<Env>
 * );
 * ```
 *
 * @param workerFilePath - Path to the worker file to wrap
 * @param dsn - Sentry DSN for initialization
 * @param selectedFeatures - Feature flags for optional Sentry features
 * @param reduceDataCollection - Whether to add the PII-reducing `dataCollection` preset
 */
export async function wrapWorkerWithSentry(
  workerFilePath: string,
  dsn: string,
  selectedFeatures: {
    performance: boolean;
  },
  reduceDataCollection: boolean,
): Promise<void> {
  const workerAst = await loadFile(workerFilePath);

  if (hasSentryContent(workerAst.$ast as t.Program)) {
    clack.log.warn(
      `Sentry is already configured in ${chalk.cyan(
        workerFilePath,
      )}. Skipping wrapping with Sentry.`,
    );
    return;
  }

  workerAst.imports.$add({
    from: "@sentry/cloudflare",
    imported: "*",
    local: "Sentry",
  });

  recast.visit(workerAst.$ast, {
    visitExportDefaultDeclaration(path) {
      const originalDeclaration = path.node.declaration as ExpressionKind;
      const sentryConfig = createSentryConfigFunction(
        dsn,
        selectedFeatures,
        reduceDataCollection,
      );
      const wrappedExport = b.callExpression(
        b.memberExpression(b.identifier("Sentry"), b.identifier("withSentry")),
        [sentryConfig, originalDeclaration],
      );

      path.node.declaration = wrappedExport;

      return false;
    },
  });

  await writeFile(workerAst.$ast, workerFilePath);
}

/**
 * Creates the Sentry config function: (env) => ({ dsn: '...', ... })
 */
function createSentryConfigFunction(
  dsn: string,
  selectedFeatures: {
    performance: boolean;
  },
  reduceDataCollection: boolean,
): t.ArrowFunctionExpression {
  const configProperties: t.ObjectProperty[] = [
    b.objectProperty(b.identifier("dsn"), b.stringLiteral(dsn)),
  ];

  if (selectedFeatures.performance) {
    const tracesSampleRateProperty = b.objectProperty(
      b.identifier("tracesSampleRate"),
      b.numericLiteral(1),
    );

    tracesSampleRateProperty.comments = [
      b.commentLine(
        " Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.",
        true,
        false,
      ),
    ];

    configProperties.push(tracesSampleRateProperty);
  }

  if (reduceDataCollection) {
    const dataCollectionProperty = b.objectProperty(
      b.identifier("dataCollection"),
      literalValueToAst(DATA_COLLECTION_PII_PRESET),
    );

    dataCollectionProperty.comments = DATA_COLLECTION_COMMENT_LINES.map(
      (line) => b.commentLine(` ${line}`, true, false),
    );

    configProperties.push(dataCollectionProperty);
  }

  const configObject = b.objectExpression(configProperties);

  return b.arrowFunctionExpression([b.identifier("env")], configObject);
}

/**
 * Converts a plain JSON-like value (booleans, strings, arrays, objects) into
 * the equivalent AST expression.
 */
function literalValueToAst(value: unknown): ExpressionKind {
  if (typeof value === "boolean") {
    return b.booleanLiteral(value);
  }
  if (typeof value === "string") {
    return b.stringLiteral(value);
  }
  if (Array.isArray(value)) {
    return b.arrayExpression(value.map(literalValueToAst));
  }

  if (typeof value !== "object" || value === null) {
    throw new TypeError(
      `Unsupported value in a Sentry option: ${String(value)}`,
    );
  }

  return b.objectExpression(
    Object.entries(value).map(([key, entryValue]) =>
      b.objectProperty(b.identifier(key), literalValueToAst(entryValue)),
    ),
  );
}
