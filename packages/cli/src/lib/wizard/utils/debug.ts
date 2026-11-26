/**
 * Debug output of the setup wizards, shown with `sentry wizard --debug`.
 */

import chalk from "chalk";
import { clack } from "./clack/prompts.js";

let debugEnabled = false;

/** Render one debug argument: strings as-is, errors with their stack. */
function prepareMessage(msg: unknown): string {
  if (typeof msg === "string") {
    return msg;
  }
  if (msg instanceof Error) {
    return msg.stack ?? msg.message;
  }
  return JSON.stringify(msg, null, "\t");
}

/** Log `args` in the wizard's output when `--debug` is on. */
export function debug(...args: unknown[]): void {
  if (!debugEnabled) {
    return;
  }
  clack.log.info(chalk.dim(args.map((a) => prepareMessage(a)).join(" ")));
}

/** Turn on {@link debug} output for the rest of the run. */
export function enableDebugLogs(): void {
  debugEnabled = true;
}
