/**
 * Find the first file that matches a glob, such as the iOS project or the
 * Android app's `build.gradle`.
 */

import { globSync } from "tinyglobby";
import { reportCliError } from "../../error-reporting.js";
import { clack } from "../utils/clack/prompts.js";

export const XCODE_PROJECT = "ios/*.xcodeproj/project.pbxproj";
export const APP_BUILD_GRADLE = "**/app/build.gradle";

const IGNORE_PATTERNS = ["node_modules/**", "ios/Pods/**", "**/Pods/**"];
export function getFirstMatchedPath(pattern: string): string | undefined {
  try {
    const matches = globSync(pattern, {
      ignore: IGNORE_PATTERNS,
    });

    return matches[0];
  } catch (error) {
    clack.log.error(`Error while matching path pattern "${pattern}"`);
    reportCliError(new Error(`Error while matching path pattern "${pattern}"`));
    return undefined;
  }
}
