/**
 * Insert the Sentry SDK init snippet into a Swift or Objective-C app's entry
 * point (the `@main` App, AppDelegate, or `main`).
 */

import { Sentry } from "../telemetry.js";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { getObjcSnippet, getSwiftSnippet } from "./templates.js";
import { clack } from "../utils/clack/prompts.js";
import { debug } from "../utils/debug.js";

const swiftAppLaunchRegex =
  /(func\s+application\s*\(\s*_\s+application:\s*[^,]+,\s*didFinishLaunchingWithOptions[^,]+:\s*[^)]+\s*\)\s+->\s+Bool\s+{)|func\s+applicationDidFinishLaunching\s*\(\s*_\s+aNotification:\s+Notification\s*\)\s*{/im;
const objcAppLaunchRegex =
  /-\s*\(\s*BOOL\s*\)\s*application:\s*\(\s*UIApplication\s*\*\s*\)\s*application\s+didFinishLaunchingWithOptions:\s*\(\s*NSDictionary\s*\*\s*\)\s*launchOptions\s*{/im;
const swiftUIRegex = /@main\s+struct[^:]+:\s*(SwiftUI\.)?App\s*{/im;
const swiftUIInitRegex = /\binit\s*\(\s*\)\s*\{/m;

function isAppDelegateFile(filePath: string): boolean {
  debug("Checking if " + filePath + " is an AppDelegate file");
  const appLaunchRegex = filePath.toLowerCase().endsWith(".swift")
    ? swiftAppLaunchRegex
    : objcAppLaunchRegex;

  const fileContent = readFileSync(filePath, "utf8");
  return appLaunchRegex.test(fileContent) || swiftUIRegex.test(fileContent);
}

function findAppDidFinishLaunchingWithOptionsInDirectory(
  dir: string,
): string | null {
  debug("Searching for AppDelegate in directory: " + dir);
  const files = readdirSync(dir);
  const filePaths = files.map((f) => path.join(dir, f));
  return findAppDidFinishLaunchingWithOptions(filePaths);
}

function findAppDidFinishLaunchingWithOptions(files: string[]): string | null {
  debug(`Searching for AppDelegate in ${files.length} files`);

  // Iterate over subdirectories after iterating over files,
  // because the AppDelegate is usually in the top level
  const dirs: string[] = [];
  for (const filePath of files) {
    debug("Checking file: " + filePath);
    if (
      filePath.endsWith(".swift") ||
      filePath.endsWith(".m") ||
      filePath.endsWith(".mm")
    ) {
      if (existsSync(filePath) && isAppDelegateFile(filePath)) {
        debug("Found AppDelegate in " + filePath);
        return filePath;
      }
    } else if (
      !path.basename(filePath).startsWith(".") &&
      !filePath.endsWith(".xcodeproj") &&
      !filePath.endsWith(".xcassets") &&
      existsSync(filePath) &&
      lstatSync(filePath).isDirectory()
    ) {
      dirs.push(filePath);
    }
  }

  for (const dr of dirs) {
    const result = findAppDidFinishLaunchingWithOptionsInDirectory(dr);
    if (result) {
      debug("Found AppDelegate in " + dr);
      return result;
    }
  }
  return null;
}

export function addCodeSnippetToProject(
  files: string[],
  dsn: string,
  enableLogs: boolean,
): boolean {
  const appDelegate = findAppDidFinishLaunchingWithOptions(files);
  if (!appDelegate) {
    return false;
  }

  const fileContent = readFileSync(appDelegate, "utf8");
  const isSwift = appDelegate.toLowerCase().endsWith(".swift");
  const appLaunchRegex = isSwift ? swiftAppLaunchRegex : objcAppLaunchRegex;
  const importStatement = isSwift ? "import Sentry\n" : "@import Sentry;\n";
  const checkForSentryInit = isSwift ? "SentrySDK.start" : "[SentrySDK start";
  let codeSnippet = isSwift
    ? getSwiftSnippet(dsn, enableLogs)
    : getObjcSnippet(dsn, enableLogs);

  Sentry.setTag("code-language", isSwift ? "swift" : "objc");
  Sentry.setTag(
    "ui-engine",
    swiftUIRegex.test(fileContent) ? "swiftui" : "uikit",
  );

  if (fileContent.includes(checkForSentryInit)) {
    //already initialized
    clack.log.info(
      "Sentry is already initialized in your AppDelegate. Skipping adding the code snippet.",
    );
    return true;
  }

  let match = appLaunchRegex.exec(fileContent);
  if (!match) {
    const swiftUIMatch = swiftUIRegex.exec(fileContent);
    if (!swiftUIMatch) {
      // This branch is not reached, because we already checked for SwiftUI in isAppDelegateFile
      return false;
    }

    const afterStructContent = fileContent.slice(swiftUIMatch.index);
    const bodyMatch = /var\s+body\s*:/m.exec(afterStructContent);
    const searchRange = bodyMatch
      ? afterStructContent.slice(0, bodyMatch.index)
      : afterStructContent;

    const initMatch = swiftUIInitRegex.exec(searchRange);

    if (initMatch) {
      match = {
        index: swiftUIMatch.index + initMatch.index,
        0: initMatch[0],
      } as RegExpExecArray;
    } else {
      match = swiftUIMatch;
      codeSnippet = `    init() {\n${codeSnippet}    }`;
    }
  }

  const insertIndex = match.index + match[0].length;
  let newFileContent =
    fileContent.slice(0, insertIndex) +
    "\n" +
    codeSnippet +
    fileContent.slice(insertIndex);

  if (newFileContent.indexOf(importStatement) < 0) {
    const firstImport = /^[ \t]*import +\w+.*$/m.exec(newFileContent);
    if (firstImport) {
      const importIndex = firstImport.index + firstImport[0].length;
      newFileContent =
        newFileContent.slice(0, importIndex) +
        "\n" +
        importStatement +
        newFileContent.slice(importIndex);
    } else {
      newFileContent = importStatement + newFileContent;
    }
  }

  writeFileSync(appDelegate, newFileContent, "utf8");

  clack.log.step("Added Sentry initialization code snippet to " + appDelegate);
  return true;
}

/**
 * Exported for testing purposes, but should not be used in other modules.
 */
export let exportForTesting: {
  isAppDelegateFile: typeof isAppDelegateFile;
  findAppDidFinishLaunchingWithOptionsInDirectory: typeof findAppDidFinishLaunchingWithOptionsInDirectory;
  findAppDidFinishLaunchingWithOptions: typeof findAppDidFinishLaunchingWithOptions;
};
if (process.env["NODE_ENV"] === "test") {
  exportForTesting = {
    isAppDelegateFile,
    findAppDidFinishLaunchingWithOptionsInDirectory,
    findAppDidFinishLaunchingWithOptions,
  };
}
