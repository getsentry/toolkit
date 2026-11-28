/**
 * Git checks the wizards run before they change a project's files.
 */

import { execSync } from "node:child_process";
import { debug } from "./debug.js";

/**
 * Checks if the current working directory is a git repository.
 *
 * @param opts.cwd The directory of the project. If undefined, the current process working directory will be used.
 *
 * @returns true if the current working directory is a git repository, false otherwise.
 */
export function isInGitRepo(opts: { cwd: string | undefined }) {
  try {
    execSync("git rev-parse --is-inside-work-tree", {
      stdio: "ignore",
      cwd: opts.cwd,
    });
    return true;
  } catch (error) {
    debug(error);
    return false;
  }
}

/**
 * Returns the exact paths of uncommitted or untracked files.
 *
 * Uses `git status --porcelain=v1 -z` so paths are NUL-terminated and verbatim,
 * preserving spaces and unusual characters. Pass results as argv entries to a
 * non-shell child process; do not interpolate them into a shell string.
 *
 * @param opts.cwd The project directory. Defaults to the current working directory.
 */
export function getUncommittedOrUntrackedFilePaths(opts?: {
  cwd: string | undefined;
}): string[] {
  try {
    const gitStatus = execSync("git status --porcelain=v1 -z", {
      // we only care about stdout
      stdio: ["ignore", "pipe", "ignore"],
      cwd: opts?.cwd,
    }).toString();

    const fields = gitStatus.split("\0");
    const files: string[] = [];

    for (let i = 0; i < fields.length; i++) {
      const entry = fields[i];
      if (!entry) {
        continue;
      }

      // Entry is `XY <path>`. Renames/copies (R/C) store the source in the
      // next field, which we skip.
      const status = entry.slice(0, 2);
      const filePath = entry.slice(3);

      if (status[0] === "R" || status[0] === "C") {
        i++;
      }

      if (filePath) {
        files.push(filePath);
      }
    }

    return files;
  } catch (error) {
    debug(error);
    return [];
  }
}
