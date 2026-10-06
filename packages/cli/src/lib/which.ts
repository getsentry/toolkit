/**
 * Cross-platform executable lookup utility.
 *
 * Provides a `whichSync` function that finds an executable in the system PATH,
 * replacing direct `Bun.which()` calls so the same code works under both
 * Bun and the Node.js npm distribution.
 */

import { execFileSync } from "node:child_process";

/** Matches CRLF or LF line endings. Used to split `where.exe` output on Windows. */
const NEWLINE_RE = /\r?\n/;

/**
 * Synchronously find the full path to a command in the system PATH.
 *
 * On Unix, delegates to `sh -c 'command -v "$1"' -- <command>` so the
 * command name is never interpolated into the shell string (safe from
 * injection). On Windows, uses `where.exe` via `execFileSync` (no shell).
 *
 * Returns the first match or `null` when the command is not found.
 *
 * @param command - The executable name to look up
 * @param opts - Optional overrides; set `PATH` to search a custom path string
 * @returns Absolute path to the executable, or `null` if not found
 */
export function whichSync(
  command: string,
  opts?: { PATH?: string }
): string | null {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const isWindows = process.platform === "win32";
    // If a custom PATH is provided, override it in the subprocess env.
    // Use !== undefined (not truthy) so empty-string PATH is respected.
    const env =
      opts?.PATH !== undefined
        ? { ...process.env, PATH: opts.PATH }
        : undefined;

    let stdout: string;
    if (isWindows) {
      // execFileSync bypasses the shell entirely — no injection risk
      stdout = execFileSync("where.exe", [command], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
        env,
      });
    } else {
      // Pass command as a positional arg ($1) so it's never interpolated
      // into the shell string. `command -v` is a POSIX builtin — works
      // even when PATH is overridden to a restricted set of directories.
      // Use absolute /bin/sh so the shell itself is found regardless of PATH.
      stdout = execFileSync(
        "/bin/sh",
        ["-c", 'command -v "$1"', "--", command],
        {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "ignore"],
          env,
        }
      );
    }

    return stdout.trim().split(NEWLINE_RE)[0] || null;
  } catch {
    return null;
  }
}
