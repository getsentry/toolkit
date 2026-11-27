/**
 * Helpers shared by the Remix wizard steps: detecting Sentry code,
 * Hydrogen apps, and where to insert new statements.
 */

import type { namedTypes as t } from "ast-types";

import path from "node:path";

import { clack } from "../utils/clack/prompts.js";
import chalk from "chalk";
import {
  type PackageDotJson,
  hasPackageInstalled,
} from "../utils/package-json.js";

export const POSSIBLE_SERVER_INSTRUMENTATION_PATHS = [
  "./instrumentation",
  "./instrumentation.server",
];

export function hasSentryContent(
  fileName: string,
  fileContent: string,
  expectedContent = "@sentry/remix",
): boolean {
  const includesContent = fileContent.includes(expectedContent);

  if (includesContent) {
    clack.log.warn(
      `File ${chalk.cyan(
        path.basename(fileName),
      )} already contains ${expectedContent}.
Skipping adding Sentry functionality to ${chalk.cyan(
        path.basename(fileName),
      )}.`,
    );
  }

  return includesContent;
}

export function serverHasInstrumentationImport(
  serverFileName: string,
  serverFileContent: string,
): boolean {
  const includesServerInstrumentationImport =
    POSSIBLE_SERVER_INSTRUMENTATION_PATHS.some((path) =>
      serverFileContent.includes(path),
    );

  if (includesServerInstrumentationImport) {
    clack.log.warn(
      `File ${chalk.cyan(
        path.basename(serverFileName),
      )} already contains instrumentation import.
Skipping adding instrumentation functionality to ${chalk.cyan(
        path.basename(serverFileName),
      )}.`,
    );
  }

  return includesServerInstrumentationImport;
}

/**
 * We want to insert the init call on top of the file, before any other imports.
 */
export function getBeforeImportsInsertionIndex(
  originalHooksModAST: t.Program,
): number {
  for (let x = 0; x < originalHooksModAST.body.length - 1; x++) {
    const node = originalHooksModAST.body[x];
    if (
      node?.type === "ImportDeclaration" &&
      node.source.value === "@sentry/remix"
    ) {
      return x + 1;
    }
  }

  return 0;
}

/**
 * We want to insert the handleError function just after all imports
 */
export function getAfterImportsInsertionIndex(
  originalEntryServerModAST: t.Program,
): number {
  for (let x = originalEntryServerModAST.body.length - 1; x >= 0; x--) {
    if (originalEntryServerModAST.body[x]?.type === "ImportDeclaration") {
      return x + 1;
    }
  }

  return 0;
}

export function isHydrogenApp(packageJson: PackageDotJson): boolean {
  return hasPackageInstalled("@shopify/hydrogen", packageJson);
}
