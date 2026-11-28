/**
 * Add the Sentry init snippet to the app target's source files, or print it
 * for the user to paste when no entry point is found.
 */

import { clack } from "../utils/clack/prompts.js";
import { Sentry } from "../telemetry.js";
import chalk from "chalk";
import { traceStep } from "../telemetry.js";
import { debug } from "../utils/debug.js";
import { addCodeSnippetToProject } from "./code-tools.js";
import { XcodeProject } from "./xcode-manager.js";

export function injectCodeSnippet({
  project,
  target,
  dsn,
  enableLogs,
}: {
  project: XcodeProject;
  target: string;
  dsn: string;
  enableLogs: boolean;
}) {
  debug(
    `Injecting code snippet into project at path: ${chalk.cyan(
      project.baseDir,
    )}`,
  );
  const codeAdded = traceStep("Add code snippet", () => {
    const files = project.getSourceFilesForTarget(target);
    if (files === undefined || files.length == 0) {
      debug("No files found for target: " + target);
      Sentry.setTag("snippet-candidate-files-not-found", true);
      return false;
    }

    debug(`Adding code snippet to ${files.length} candidate files`);
    return addCodeSnippetToProject(files, dsn, enableLogs);
  });
  Sentry.setTag("Snippet-Added", codeAdded);
  debug(`Snippet added: ${chalk.cyan(codeAdded.toString())}`);

  if (!codeAdded) {
    clack.log.warn(
      "Added the Sentry dependency to your project but could not add the Sentry code snippet. Please add the code snippet manually by following the docs: https://docs.sentry.io/platforms/apple/guides/ios/#configure",
    );
  }
}
