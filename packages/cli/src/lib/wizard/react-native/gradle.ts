/**
 * Add the Sentry Gradle plugin to a React Native Android app's
 * `build.gradle`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { reportCliError } from "../../error-reporting.js";
import { clack } from "../utils/clack/prompts.js";

const applyFrom = `apply from: new File(["node", "--print", "require.resolve('@sentry/react-native/package.json')"].execute().text.trim(), "../sentry.gradle")`;

export function doesAppBuildGradleIncludeRNSentryGradlePlugin(
  content: string,
): boolean {
  return content.includes("sentry.gradle");
}

export function addRNSentryGradlePlugin(content: string): string {
  return content.replace(/^android {/m, (match) => `${applyFrom}\n${match}`);
}

export function writeAppBuildGradle(path: string, newContent: string): void {
  try {
    const currentContent = readFileSync(path, "utf-8");
    if (newContent === currentContent) {
      clack.log.info(`No changes to ${path}.`);
      return;
    }

    writeFileSync(path, newContent, "utf-8");
  } catch (error) {
    clack.log.error(`Error while writing ${path}`);
    reportCliError(new Error("Error while writing app/build.gradle"));
  }
}
