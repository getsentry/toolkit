/**
 * Edits of a Flutter project: adds the Sentry packages and plugin options to
 * `pubspec.yaml` and the SDK init to `main.dart`, as string edits that keep
 * the user's formatting, and writes the plugin's `sentry.properties`.
 */

import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import { reportCliError } from "../../error-reporting.js";
import { clack } from "../utils/clack/prompts.js";
import chalk from "chalk";
import {
  sentryImport,
  pubspecOptions,
  sentryProperties,
  initSnippet,
  sessionReplaySampleRate,
  sessionReplayOnErrorSampleRate,
} from "./templates.js";
import { featureSelectionPrompt } from "../utils/clack/index.js";

/**
 * Recursively finds a file per name in subfolders.
 * @param dir - The directory to start searching.
 * @param name - The name of the file including path extension.
 * @returns The path to the main.dart file or null if not found.
 */
export function findFile(dir: string, name: string): string | null {
  if (!existsSync(dir)) {
    return null;
  }
  const files: string[] = readdirSync(dir);

  for (const file of files) {
    const fullPath: string = path.join(dir, file);
    const stats: Stats = statSync(fullPath);

    if (stats.isDirectory()) {
      const result: string | null = findFile(fullPath, name);
      if (result) {
        return result;
      }
    } else if (file === name) {
      return fullPath;
    }
  }

  return null;
}

export function patchPubspec(
  pubspecFile: string | null,
  sentryDartFlutterVersion: string,
  sentryDartPluginVersion: string,
  project: string,
  org: string,
): boolean {
  try {
    if (!pubspecFile) {
      throw new Error("pubspec.yaml is not provided or invalid.");
    }

    let pubspecContent = readFileSync(pubspecFile, "utf8");

    if (!pubspecContent.includes("sentry_flutter:")) {
      pubspecContent = addToSection(
        pubspecContent,
        "dependencies",
        getDependenciesLocation(pubspecContent),
        `  sentry_flutter: ${sentryDartFlutterVersion}\n`,
      );

      clack.log.success(
        chalk.greenBright(
          `${chalk.bold("sentry_flutter")} added to pubspec.yaml`,
        ),
      );
    } else {
      clack.log.success(
        chalk.greenBright(
          `${chalk.bold("sentry_flutter")} is already included in pubspec.yaml`,
        ),
      );
    }

    if (!pubspecContent.includes("sentry_dart_plugin:")) {
      pubspecContent = addToSection(
        pubspecContent,
        "dev_dependencies",
        getDevDependenciesLocation(pubspecContent),
        `  sentry_dart_plugin: ${sentryDartPluginVersion}\n`,
      );

      clack.log.success(
        chalk.greenBright(
          `${chalk.bold("sentry_dart_plugin")} added to pubspec.yaml`,
        ),
      );
    } else {
      clack.log.success(
        chalk.greenBright(
          `${chalk.bold(
            "sentry_dart_plugin",
          )} is already included in pubspec.yaml`,
        ),
      );
    }

    if (!pubspecContent.includes("sentry:")) {
      pubspecContent += "\n";
      pubspecContent += pubspecOptions(project, org);

      clack.log.success(
        chalk.greenBright(
          `${chalk.bold("sentry plugin configuration")} added to pubspec.yaml`,
        ),
      );
    } else {
      clack.log.success(
        chalk.greenBright(
          `${chalk.bold(
            "sentry plugin configuration",
          )} is already included in pubspec.yaml`,
        ),
      );
    }

    writeFileSync(pubspecFile, pubspecContent, "utf8");

    return true;
  } catch (error) {
    clack.log.warn(`Failed to read/write ${chalk.cyan("pubspec.yaml")} file.`);
    reportCliError(error);
    return false;
  }
}

export function addProperties(pubspecFile: string | null, authToken: string) {
  try {
    if (!pubspecFile) {
      throw new Error("pubspec.yaml is not provided or invalid.");
    }

    const pubspecDir = path.dirname(pubspecFile);
    const sentryPropertiesFileName = "sentry.properties";
    const sentryPropertiesFile = path.join(
      pubspecDir,
      sentryPropertiesFileName,
    );
    const sentryPropertiesContent = sentryProperties(authToken);

    writeFileSync(sentryPropertiesFile, sentryPropertiesContent, "utf8");

    const gitignoreFile = path.join(pubspecDir, ".gitignore");
    if (existsSync(gitignoreFile)) {
      appendFileSync(gitignoreFile, `\n${sentryPropertiesFileName}\n`);
    } else {
      writeFileSync(gitignoreFile, `${sentryPropertiesFileName}\n`, "utf8");
    }
    return true;
  } catch (error) {
    clack.log.warn(`Failed to read/write ${chalk.cyan("pubspec.yaml")} file.`);
    reportCliError(error);
    return false;
  }
}

export async function patchMain(
  mainFile: string | null,
  dsn: string,
): Promise<boolean> {
  // No main.dart is an expected project state: the caller shows the
  // snippet to add by hand.
  if (!mainFile) {
    return false;
  }
  try {
    let mainContent = readFileSync(mainFile, "utf8");
    if (
      /import\s+['"]package[:]sentry_flutter\/sentry_flutter\.dart['"];?/i.test(
        mainContent,
      )
    ) {
      // sentry is already configured
      clack.log.success(
        chalk.greenBright(
          `${chalk.bold("main.dart")} already has Sentry configured.`,
        ),
      );
      return true;
    }

    const selectedFeatures = await featureSelectionPrompt([
      {
        id: "tracing",
        prompt: `Do you want to enable ${chalk.bold(
          "Tracing",
        )} to track the performance of your application?`,
        enabledHint: "recommended",
      },
      {
        id: "replay",
        prompt: `Do you want to enable ${chalk.bold(
          "Session Replay",
        )} to record user interactions and debug issues?`,
        enabledHint: "recommended",
      },
    ] as const);
    mainContent = patchMainContent(dsn, mainContent, selectedFeatures);
    if (!mainContent.includes("SentryFlutter.init(")) {
      // No `runApp(...);` to wrap: the caller shows the snippet to add by hand.
      return false;
    }

    if (selectedFeatures.replay) {
      clack.log.info(
        `Session Replay will be enabled with default settings (replaysSessionSampleRate: ${sessionReplaySampleRate}, replaysOnErrorSampleRate: ${sessionReplayOnErrorSampleRate}).`,
      );
      clack.log.message(
        "By default, all text content, images, and webviews will be masked for privacy. You can customize this in your code later.",
      );
    }

    writeFileSync(mainFile, mainContent, "utf8");

    clack.log.success(
      chalk.greenBright(
        `Patched ${chalk.bold(
          "main.dart",
        )} with the Sentry setup and test error snippet.`,
      ),
    );

    return true;
  } catch (error) {
    clack.log.warn(`Failed to read/write ${chalk.cyan("main.dart")} file.`);
    reportCliError(error);
    return false;
  }
}

export function patchMainContent(
  dsn: string,
  mainContent: string,
  selectedFeatures: {
    tracing: boolean;
    replay: boolean;
  },
): string {
  const importIndex = getLastImportLineLocation(mainContent);
  mainContent =
    mainContent.slice(0, importIndex) +
    sentryImport +
    mainContent.slice(importIndex);

  mainContent = arrowMainToBlock(mainContent);

  mainContent = replaceRunAppCalls(mainContent, (runAppArgs) =>
    initSnippet(dsn, selectedFeatures, runAppArgs),
  );

  // Make the `main` function async if it's not already
  mainContent = mainContent.replace(
    /(?:Future<void>|void)\s+main\s*\(([^)]*)\)\s*\{/g,
    "Future<void> main($1) async {",
  );

  return mainContent;
}

/**
 * Rewrite an expression-bodied `main` (`void main() => runApp(...);`) as a
 * block, so the init snippet's statements fit in it.
 */
function arrowMainToBlock(source: string): string {
  const arrowMain =
    /(?:Future<void>|void)\s+main\s*\(([^)]*)\)\s*(?:async\s*)?=>/.exec(source);
  if (!arrowMain) {
    return source;
  }
  const bodyStart = arrowMain.index + arrowMain[0].length;
  const bodyEnd = scanCode(
    source,
    bodyStart,
    (char, depth) => char === ";" && depth === 0,
  );
  if (bodyEnd === -1) {
    return source;
  }
  const params = arrowMain[1] ?? "";
  const body = source.slice(bodyStart, bodyEnd).trim();
  return `${source.slice(0, arrowMain.index)}Future<void> main(${params}) async {\n  ${body};\n}${source.slice(bodyEnd + 1)}`;
}

/**
 * Replace each `runApp(...);` statement with `replace(<its arguments>)`,
 * matching the call's own closing parenthesis.
 */
function replaceRunAppCalls(
  source: string,
  replace: (runAppArgs: string) => string,
): string {
  const runAppCall = /\brunApp\s*\(/g;
  let result = "";
  let cursor = 0;
  for (
    let match = runAppCall.exec(source);
    match;
    match = runAppCall.exec(source)
  ) {
    const open = match.index + match[0].length - 1;
    const close = scanCode(
      source,
      open,
      (char, depth) => char === ")" && depth === 0,
    );
    if (close === -1) {
      break;
    }
    const semicolon = /^\s*;/.exec(source.slice(close + 1));
    if (!semicolon) {
      continue;
    }
    result +=
      source.slice(cursor, match.index) +
      replace(source.slice(open + 1, close));
    cursor = close + 1 + semicolon[0].length;
    runAppCall.lastIndex = cursor;
  }
  return result + source.slice(cursor);
}

/**
 * Index of the first character from `start` where `stop(char, depth)` holds,
 * where `depth` counts open brackets after `char`. Skips strings and comments.
 * Returns -1 when there is none, or when a bracket closes below `start`'s level.
 */
function scanCode(
  source: string,
  start: number,
  stop: (char: string, depth: number) => boolean,
): number {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const char = source.charAt(i);
    if (char === "'" || char === '"') {
      i = endOfString(source, i);
      continue;
    }
    if (source.startsWith("//", i)) {
      i = source.indexOf("\n", i);
      if (i === -1) {
        return -1;
      }
      continue;
    }
    if (source.startsWith("/*", i)) {
      i = source.indexOf("*/", i);
      if (i === -1) {
        return -1;
      }
      i += 1;
      continue;
    }
    if ("([{".includes(char)) {
      depth++;
    } else if (")]}".includes(char)) {
      depth--;
    }
    if (stop(char, depth)) {
      return i;
    }
    if (depth < 0) {
      return -1;
    }
  }
  return -1;
}

/** Index of the closing quote of the Dart string starting at `start`. */
function endOfString(source: string, start: number): number {
  const quote = source.charAt(start);
  const delimiter = source.startsWith(quote.repeat(3), start)
    ? quote.repeat(3)
    : quote;
  for (let i = start + delimiter.length; i < source.length; i++) {
    if (source.charAt(i) === "\\") {
      i++;
    } else if (source.startsWith(delimiter, i)) {
      return i + delimiter.length - 1;
    }
  }
  return source.length;
}

export function getLastImportLineLocation(sourceCode: string): number {
  const importRegex = /import\s+['"].*['"].*;/gim;
  return Math.max(0, getLastReqExpLocation(sourceCode, importRegex));
}

/** Offset of the line after the `dependencies:` header, or -1 without one. */
export function getDependenciesLocation(sourceCode: string): number {
  const dependencyRegex = /^dependencies:[ \t]*(?:#[^\r\n]*)?\r?$/gim;
  return getLastReqExpLocation(sourceCode, dependencyRegex);
}

/** Offset of the line after the `dev_dependencies:` header, or -1 without one. */
export function getDevDependenciesLocation(sourceCode: string): number {
  const dependencyRegex = /^dev_dependencies:[ \t]*(?:#[^\r\n]*)?\r?$/gim;
  return getLastReqExpLocation(sourceCode, dependencyRegex);
}

// Helper

/**
 * Insert `entry` at `index`, the start of the `section` body, or append the
 * section with `entry` when `index` is -1 (the pubspec has no such section).
 */
function addToSection(
  content: string,
  section: string,
  index: number,
  entry: string,
): string {
  if (index === -1) {
    const separator = content.endsWith("\n") || content === "" ? "" : "\n";
    return `${content}${separator}\n${section}:\n${entry}`;
  }
  if (index > content.length) {
    return `${content}\n${entry}`;
  }
  return content.slice(0, index) + entry + content.slice(index);
}

function getLastReqExpLocation(sourceCode: string, regExp: RegExp): number {
  let match = regExp.exec(sourceCode);
  let importIndex = -1;
  while (match) {
    importIndex = match.index + match[0].length + 1;
    match = regExp.exec(sourceCode);
  }
  return importIndex;
}
