/**
 * Process-tree cleanup shared by the post-init verification paths.
 *
 * Verification children (dev servers, `flutter doctor`, `npx expo doctor`)
 * start descendants, so signaling only the direct child can leave them running.
 */

import { type ChildProcess, spawnSync } from "node:child_process";
import { logger } from "../logger.js";

/** Maximum time for a Windows taskkill invocation to complete. */
const WINDOWS_TREE_KILL_TIMEOUT_MS = 1000;

/** Signal the POSIX process group or force-terminate the Windows process tree. */
export function terminateProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
): boolean {
  const pid = child.pid;
  if (pid === undefined) {
    return false;
  }

  try {
    if (process.platform === "win32") {
      // Verification children are disposable. Force the complete tree in one
      // bounded call because Windows cannot reliably reproduce POSIX process-
      // group signaling or discover descendants after their parent exits.
      const args = ["/PID", String(pid), "/T", "/F"];
      const taskkill = spawnSync("taskkill", args, {
        stdio: "ignore",
        timeout: WINDOWS_TREE_KILL_TIMEOUT_MS,
        windowsHide: true,
      });
      if (taskkill.error) {
        logger.debug(
          `Failed to terminate Windows verification process tree while handling ${signal}`,
          taskkill.error,
        );
        return false;
      }
      if (taskkill.status !== 0) {
        logger.debug(
          `taskkill exited with status ${taskkill.status} while handling ${signal} for the verification process tree`,
        );
        return false;
      }
      return true;
    }
    // Verification children are spawned detached on POSIX, making their PID
    // the process-group ID. A negative PID signals the whole group, including
    // shell pipelines, concurrently tasks, and framework watchers.
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      logger.debug(`Failed to signal verification process tree with ${signal}`);
    }
    return false;
  }
}

/** Fall back to signaling only the direct child process. */
export function signalDirectChild(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  try {
    child.kill(signal);
  } catch {
    logger.debug(`Verification child exited before receiving ${signal}`);
  }
}
