/**
 * The running daemon's sessions, as shell completion reads them.
 *
 * Sessions live only in the daemon's memory, and `sentry __complete` makes
 * no network requests, so the daemon mirrors each session's ID, label, and
 * state to an owner-only file next to its discovery state. The file holds no
 * capabilities and no telemetry. It is ignored once the daemon that wrote it
 * has exited, and a stale entry only suggests a session the command then
 * reports as not found.
 *
 * Shell completion imports this module on every TAB press, so it loads
 * nothing the completion fast path has not loaded already.
 */

import { readFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../../lib/logger.js";
import type { LocalSession } from "./session-store.js";

export const LOCAL_SESSION_SNAPSHOT_FILENAME = "local-sessions.json";

/** What completion knows of a session. */
export type LocalSessionSnapshotEntry = Pick<
  LocalSession,
  "id" | "label" | "state" | "expiresAt"
>;

function snapshotPath(directory: string): string {
  return join(directory, LOCAL_SESSION_SNAPSHOT_FILENAME);
}

/**
 * Atomically replace the snapshot with `sessions`, written by daemon `pid`,
 * with owner-only access. Only the fields of
 * {@link LocalSessionSnapshotEntry} are written.
 */
export async function writeLocalSessionSnapshot(
  directory: string,
  pid: number,
  sessions: readonly LocalSession[],
): Promise<void> {
  const snapshot = {
    pid,
    sessions: sessions.map(({ id, label, state, expiresAt }) => ({
      id,
      label,
      state,
      expiresAt,
    })),
  };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = snapshotPath(directory);
  const temporaryPath = `${path}.${pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(snapshot)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  // `mode` does not apply to a file left over from an interrupted write
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
}

/** Remove the snapshot when the daemon shuts down. */
export async function removeLocalSessionSnapshot(
  directory: string,
): Promise<void> {
  await rm(snapshotPath(directory), { force: true });
}

/** Whether `pid` may name a running process: only `ESRCH` rules it out. */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function isEntry(value: unknown): value is LocalSessionSnapshotEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { id, label, state, expiresAt } = value as Record<string, unknown>;
  return (
    typeof id === "string" &&
    id !== "" &&
    typeof label === "string" &&
    (state === "open" || state === "retained") &&
    (expiresAt === undefined || typeof expiresAt === "number")
  );
}

/**
 * The sessions of the snapshot, if the daemon that wrote it is still
 * running, leaving out retained sessions past their expiry and malformed
 * entries. An absent, unreadable, or malformed file has none.
 */
export function readLocalSessionSnapshot(
  directory: string,
  now = Date.now(),
): LocalSessionSnapshotEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(snapshotPath(directory), "utf8"));
  } catch (error) {
    logger.debug("Could not read the Local session snapshot", error);
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) {
    return [];
  }
  const { pid, sessions } = parsed as Record<string, unknown>;
  if (
    !(Number.isInteger(pid) && (pid as number) > 0 && Array.isArray(sessions))
  ) {
    return [];
  }
  if (!isProcessRunning(pid as number)) {
    return [];
  }
  return sessions
    .filter(isEntry)
    .filter(
      ({ state, expiresAt }) =>
        state === "open" || expiresAt === undefined || expiresAt > now,
    );
}
