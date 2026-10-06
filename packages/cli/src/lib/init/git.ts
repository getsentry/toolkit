/**
 * Git Safety Checks for Init Wizard
 *
 * Pre-flight checks to verify the user is in a git repo with a clean
 * working tree before the init wizard starts modifying files.
 *
 * Low-level git primitives live in `src/lib/git.ts`. This module
 * re-exports them for backward compatibility and adds the interactive
 * `checkGitStatus` orchestrator. All UI I/O is routed through the
 * injected `WizardUI` so the same code drives `InkUI` (interactive)
 * and `LoggingUI` (CI / npm) paths.
 */

import {
  getUncommittedFiles,
  isInsideGitWorkTree as isInsideWorkTree,
} from "../git.js";
import type { WizardUI } from "./ui/types.js";
import { isCancelled } from "./ui/types.js";

/** Maximum number of uncommitted files to display before truncating. */
const MAX_DISPLAYED_FILES = 5;

/**
 * Check if the current directory is inside a git work tree.
 * Thin wrapper that adapts the `{cwd}` object signature expected by the init wizard.
 */
export function isInsideGitWorkTree(opts: { cwd: string }): boolean {
  return isInsideWorkTree(opts.cwd);
}

/**
 * Get uncommitted or untracked files formatted for display.
 * Thin wrapper that adapts the `{cwd}` object signature expected by the init wizard.
 */
export function getUncommittedOrUntrackedFiles(opts: {
  cwd: string;
}): string[] {
  return getUncommittedFiles(opts.cwd);
}

/**
 * Checks git status and prompts the user if there are concerns.
 * Returns `true` to continue, `false` to abort.
 */
export async function checkGitStatus(opts: {
  cwd: string;
  yes: boolean;
  ui: WizardUI;
}): Promise<boolean> {
  const { cwd, yes, ui } = opts;

  if (!isInsideGitWorkTree({ cwd })) {
    if (yes) {
      ui.log.warn(
        "You are not inside a git repository. Unable to revert changes if something goes wrong."
      );
      return true;
    }
    const proceed = await ui.confirm({
      message:
        "You are not inside a git repository. Unable to revert changes if something goes wrong. Continue?",
    });
    if (isCancelled(proceed)) {
      return false;
    }
    return Boolean(proceed);
  }

  const uncommitted = getUncommittedOrUntrackedFiles({ cwd });
  if (uncommitted.length > 0) {
    const displayed = uncommitted.slice(0, MAX_DISPLAYED_FILES);
    const remaining = uncommitted.length - displayed.length;
    if (remaining > 0) {
      displayed.push(`  + ${remaining} more uncommitted files`);
    }
    const fileList = displayed.join("\n");
    if (yes) {
      ui.log.warn(
        `You have uncommitted or untracked files:\n${fileList}\nProceeding anyway (--yes).`
      );
      return true;
    }
    ui.log.warn(`You have uncommitted or untracked files:\n${fileList}`);
    const proceed = await ui.confirm({
      message: "Continue with uncommitted changes?",
    });
    if (isCancelled(proceed)) {
      return false;
    }
    return Boolean(proceed);
  }

  return true;
}
