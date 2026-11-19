/**
 * Signal the app that a command such as `sentry local run` wraps, and tell
 * whether a Ctrl-C in the terminal already reached it, so it is not sent twice.
 */

import { type ChildProcess, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { logger } from "./logger.js";

const log = logger.withTag("child-signals");

/**
 * Whether a `/proc/<pid>/stat` line belongs to a process in the foreground
 * process group of its controlling terminal (its `pgrp` equals the
 * terminal's `tpgid`). A process with no terminal has `tpgid` -1.
 *
 * The command name in parentheses can hold spaces and `)`, so the fields are
 * read after the last `)`.
 *
 * @internal Exported for testing.
 */
export function isForegroundStat(stat: string): boolean {
  // After "pid (comm) ": state ppid pgrp session tty_nr tpgid ...
  const fields = stat
    .slice(stat.lastIndexOf(")") + 1)
    .trim()
    .split(/\s+/);
  const pgrp = Number(fields[2]);
  const tpgid = Number(fields[5]);
  return tpgid > 0 && pgrp === tpgid;
}

/** The `ps` fallback for {@link isForegroundStat} where there is no `/proc`. */
function isForegroundByPs(pid: number): boolean {
  const output = execFileSync("ps", ["-o", "pgid=,tpgid=", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1000,
  });
  const [pgid, tpgid] = output.trim().split(/\s+/).map(Number);
  return tpgid !== undefined && tpgid > 0 && pgid === tpgid;
}

/**
 * Whether a Ctrl-C in the terminal reached the process `pid` as well, because
 * it is in the terminal's foreground process group.
 *
 * Returns false when this can't be checked (no `/proc` and no `ps`), so the
 * caller falls back to forwarding the signal. Always false on Windows, where
 * the CLI keeps forwarding as before.
 *
 * @param pid - The child's pid; `undefined` when the spawn failed
 */
export function terminalSignalsProcess(
  pid: number | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (pid === undefined || platform === "win32") {
    return false;
  }
  try {
    if (platform === "linux") {
      return isForegroundStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
    }
    return isForegroundByPs(pid);
  } catch (error) {
    log.debug(`Could not read the process group of ${pid}`, error);
    return false;
  }
}

/**
 * Whether to start the wrapped app in its own process group.
 *
 * Outside a terminal's foreground group (agents, CI, `--verify` under a tool)
 * nothing signals the app's helpers for us, and a wrapper such as `go run`
 * ignores SIGINT, so signalling only the wrapper leaves the real app running.
 * Its own group lets the CLI signal the whole tree it started. In a terminal
 * the app stays in the foreground group, so Ctrl-C still reaches it once.
 * Windows has no process groups.
 */
export function startsOwnProcessGroup(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== "win32" && !terminalSignalsProcess(process.pid, platform);
}

/**
 * Send `signal` to the app: to its whole process group when it has its own
 * (the group id is the app's pid), otherwise to the app process only.
 */
export function signalApp(
  child: ChildProcess,
  signal: NodeJS.Signals,
  ownGroup: boolean,
): void {
  const pid = child.pid;
  if (!ownGroup || pid === undefined || pid <= 1) {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    log.debug(`Could not send ${signal} to process group ${pid}`, error);
  }
}

/** Whether any process is left in the app's own process group `pid`. */
export function appIsRunning(pid: number): boolean {
  if (pid <= 1) {
    return false;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    // EPERM: the group exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
