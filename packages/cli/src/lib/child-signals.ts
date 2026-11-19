/**
 * Signal the app that a command such as `sentry local run` wraps, and tell
 * whether a Ctrl-C in the terminal already reached it, so it is not sent twice.
 */

import { type ChildProcess, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { logger } from "./logger.js";

const log = logger.withTag("child-signals");

/** A process's group and its controlling terminal's foreground group. */
type TerminalGroups = {
  pgrp: number;
  /** -1 (or 0 from BSD `ps`) when the process has no controlling terminal. */
  tpgid: number;
};

/**
 * Read `pgrp` and `tpgid` from a `/proc/<pid>/stat` line.
 *
 * The command name in parentheses can hold spaces and `)`, so the fields are
 * read after the last `)`.
 */
function parseStatGroups(stat: string): TerminalGroups {
  // After "pid (comm) ": state ppid pgrp session tty_nr tpgid ...
  const fields = stat
    .slice(stat.lastIndexOf(")") + 1)
    .trim()
    .split(/\s+/);
  return { pgrp: Number(fields[2]), tpgid: Number(fields[5]) };
}

function isForeground({ pgrp, tpgid }: TerminalGroups): boolean {
  return tpgid > 0 && pgrp === tpgid;
}

/**
 * Whether a `/proc/<pid>/stat` line belongs to a process in the foreground
 * process group of its controlling terminal (its `pgrp` equals the
 * terminal's `tpgid`). A process with no terminal has `tpgid` -1.
 *
 * @internal Exported for testing.
 */
export function isForegroundStat(stat: string): boolean {
  return isForeground(parseStatGroups(stat));
}

/**
 * The process groups of `pid`, from `/proc` on Linux and `ps` elsewhere, or
 * `undefined` when neither can tell.
 */
function readTerminalGroups(
  pid: number,
  platform: NodeJS.Platform,
): TerminalGroups | undefined {
  try {
    if (platform === "linux") {
      return parseStatGroups(readFileSync(`/proc/${pid}/stat`, "utf8"));
    }
    const output = execFileSync(
      "ps",
      ["-o", "pgid=,tpgid=", "-p", String(pid)],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1000,
      },
    );
    const [pgrp = Number.NaN, tpgid = Number.NaN] = output
      .trim()
      .split(/\s+/)
      .map(Number);
    return { pgrp, tpgid };
  } catch (error) {
    log.debug(`Could not read the process group of ${pid}`, error);
    return undefined;
  }
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
  const groups = readTerminalGroups(pid, platform);
  return groups !== undefined && isForeground(groups);
}

/**
 * Whether to start the wrapped app in its own process group.
 *
 * With no controlling terminal (agents, CI, `--verify` under a tool) nothing
 * signals the app's helpers for us, and a wrapper such as `go run` ignores
 * SIGINT, so signalling only the wrapper leaves the real app running. Its own
 * group lets the CLI signal the whole tree it started.
 *
 * Node starts that group in a new session, which leaves the terminal, so a
 * CLI with a terminal keeps the app beside it: in the foreground Ctrl-C still
 * reaches the app once, and as a background job the app still gets SIGHUP
 * when the terminal closes. When the terminal can't be read, the app also
 * stays beside the CLI. Windows has no process groups.
 *
 * @param pid - The CLI's pid; a parameter for testing
 */
export function startsOwnProcessGroup(
  platform: NodeJS.Platform = process.platform,
  pid: number = process.pid,
): boolean {
  if (platform === "win32") {
    return false;
  }
  const groups = readTerminalGroups(pid, platform);
  return groups !== undefined && groups.tpgid <= 0;
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
