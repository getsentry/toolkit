/**
 * Finds the app's main activity source file and patches it with the Sentry
 * import and a test error snippet.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { reportCliError } from "../../error-reporting.js";
import { clack } from "../utils/clack/prompts.js";
import chalk from "chalk";
import {
  sentryImport,
  sentryImportKt,
  testErrorSnippet,
  testErrorSnippetKt,
} from "./templates.js";
import { findFile } from "../../dsn/fs-utils.js";

/**
 * Looks in src/main/java or src/main/kotlin for the specified {@link packageName} and
 * {@link activityName} by concatenating them. For example:
 *
 * src/
 *   main/
 *     java/ or kotlin/
 *       my.package.name/
 *         ui/
 *           MainActivity.kt
 *
 * src/main/java can contain both .java and .kt sources, whilst src/main/kotlin only .kt
 *
 * @param appDir
 * @param packageName
 * @param activityName
 * @returns path to the Main Activity
 */
export async function findActivitySourceFile(
  appDir: string,
  packageName: string,
  activityName: string,
): Promise<string | undefined> {
  const javaSrcDir = path.join(appDir, "src", "main", "java");
  let possibleActivityPath;
  // A name that starts with a dot or has no dot is relative to the package
  // (Android prefixes the package name); otherwise it is fully qualified.
  const packageNameParts =
    activityName.startsWith(".") || !activityName.includes(".")
      ? packageName.split(".")
      : [];
  const activityNameParts = activityName.split(".");

  if (existsSync(javaSrcDir)) {
    possibleActivityPath = await findFile(
      path.join(javaSrcDir, ...packageNameParts, ...activityNameParts),
      [".kt", ".java"],
    );
  }

  if (!possibleActivityPath || !existsSync(possibleActivityPath)) {
    const kotlinSrcDir = path.join(appDir, "src", "main", "kotlin");
    if (existsSync(kotlinSrcDir)) {
      possibleActivityPath = await findFile(
        path.join(kotlinSrcDir, ...packageNameParts, ...activityNameParts),
        [".kt"],
      );
    }
  }
  return possibleActivityPath;
}

/**
 * Patches Main Activity with the test error code snippet by the specified path {@link activityFile}.
 * Finds activity's `onCreate` method, adds the snippet and necessary imports.
 *
 * ```kotlin
 * import something
 * import something.something
 * import io.sentry.Sentry <-- this is added by us
 *
 * override fun onCreate(savedInstanceState: Bundle?) {
 *   super.onCreate(savedInstanceState)
 *   // the snippet goes here <--
 *   doSomething()
 * }
 * ```
 *
 * @param activityFile
 * @returns true if successfully patched, false otherwise
 */
export function patchMainActivity(activityFile: string | undefined): boolean {
  if (!activityFile || !existsSync(activityFile)) {
    clack.log.warn("No main activity source file found in filesystem.");
    reportCliError(new Error("No main activity source file"));
    return false;
  }

  const activityContent = readFileSync(activityFile, "utf8");

  if (/import\s+io\.sentry\.Sentry;?/i.test(activityContent)) {
    // sentry is already configured
    clack.log.success(
      chalk.greenBright(
        `${chalk.bold(
          "Main Activity",
        )} is already patched with test error snippet.`,
      ),
    );
    return true;
  }

  const importIndex = getLastImportLineLocation(activityContent);

  let newActivityContent;
  if (activityFile.endsWith(".kt")) {
    newActivityContent =
      activityContent.slice(0, importIndex) +
      sentryImportKt +
      activityContent.slice(importIndex);
  } else {
    newActivityContent =
      activityContent.slice(0, importIndex) +
      sentryImport +
      activityContent.slice(importIndex);
  }

  const onCreateMatch = /super\.onCreate\(.*?\);?/i.exec(newActivityContent);
  if (!onCreateMatch) {
    clack.log.warn("No onCreate method found in main activity.");
    reportCliError(new Error("No onCreate method"));
    return false;
  }

  const onCreateIndex = onCreateMatch.index + onCreateMatch[0].length;
  if (activityFile.endsWith(".kt")) {
    newActivityContent =
      newActivityContent.slice(0, onCreateIndex) +
      testErrorSnippetKt +
      newActivityContent.slice(onCreateIndex);
  } else {
    newActivityContent =
      newActivityContent.slice(0, onCreateIndex) +
      testErrorSnippet +
      newActivityContent.slice(onCreateIndex);
  }
  writeFileSync(activityFile, newActivityContent, "utf8");

  clack.log.success(
    chalk.greenBright(
      `Patched ${chalk.bold(
        "Main Activity",
      )} with the Sentry test error snippet.`,
    ),
  );

  return true;
}

/**
 * Returns the string index of the last import statement in the given code file.
 * Works for both Java and Kotlin import statements.
 *
 * @param sourceCode
 * @returns the insert index, or 0 if none found.
 */
export function getLastImportLineLocation(sourceCode: string): number {
  const importRegex = /import(?:\sstatic)?\s+[\w.*]+(?: as [\w.]+)?;?/gim;

  let importsMatch = importRegex.exec(sourceCode);
  let importIndex = 0;
  while (importsMatch) {
    importIndex = importsMatch.index + importsMatch[0].length + 1;
    importsMatch = importRegex.exec(sourceCode);
  }
  return importIndex;
}
