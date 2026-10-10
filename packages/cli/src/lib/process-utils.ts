/**
 * Small OS-process helpers shared across modules.
 *
 * Kept as a dependency-free leaf module so lean, hot-path callers (e.g. the
 * SQLite adapter, loaded on every command) can reuse process liveness checks
 * without pulling in the heavier graphs of modules like `binary.ts`.
 */

/**
 * Check if a process with the given PID is still running.
 *
 * On Unix, `process.kill(pid, 0)` sends no signal but performs error checking:
 * - ESRCH: process does not exist (not running).
 * - EPERM: process exists but we lack permission to signal it (IS running).
 *
 * @param pid Process ID to probe.
 * @returns `true` if a process with this PID currently exists.
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 just checks if the process exists.
    return true;
  } catch (error) {
    // EPERM means the process exists but we can't signal it (different user).
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      return true;
    }
    // ESRCH or any other error means the process is not running.
    return false;
  }
}
