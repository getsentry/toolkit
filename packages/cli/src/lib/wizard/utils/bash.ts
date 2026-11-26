/**
 * Runs a shell command for a wizard, such as `./gradlew` to check that the
 * changed build still works.
 */

import { exec } from "node:child_process";

/** Run `command` in a shell and resolve its stdout; reject when it fails. */
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
