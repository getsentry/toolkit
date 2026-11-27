/**
 * Run a shell command for a wizard step, such as `pod install`.
 *
 * Ported from sentry-wizard's `utils/bash.ts` without its `sentry-cli`
 * install and version checks: the wizard runs through `sentry`, so there is
 * no other CLI to find or install.
 */

import { exec } from "node:child_process";

/** Run `command` in a shell and resolve with its stdout. */
export function execute(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(stdout);
    });
  });
}
