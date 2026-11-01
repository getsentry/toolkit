/** The session snapshot the Local daemon keeps for shell completion. */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  LOCAL_SESSION_SNAPSHOT_FILENAME,
  readLocalSessionSnapshot,
  removeLocalSessionSnapshot,
  writeLocalSessionSnapshot,
} from "../../../src/commands/local/session-snapshot.js";
import {
  createLocalSessionStore,
  type LocalSession,
} from "../../../src/commands/local/session-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function snapshotDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sentry-local-sessions-"));
  directories.push(directory);
  return directory;
}

/** The PID of a process that has exited. */
function exitedPid(): number {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  if (!pid) throw new Error("Expected a child PID");
  return pid;
}

const SESSION: LocalSession = {
  id: "0190a6e1-0000-7000-8000-000000000001",
  label: "web",
  cwd: "/work/web",
  createdAt: 1000,
  lastActivityAt: 2000,
  state: "open",
  maxEnvelopes: 100,
};

describe("Local session snapshot", () => {
  test("holds only IDs, labels, and states, in an owner-only file", async () => {
    const directory = await snapshotDirectory();
    const store = createLocalSessionStore();
    const session = store.create({ label: "web", cwd: "/work/web" });
    const capabilities = store.getCapabilities(session.id);
    // A caller passing the stored session still writes no capability
    await writeLocalSessionSnapshot(directory, process.pid, [
      { ...session, ...capabilities } as LocalSession,
    ]);

    const path = join(directory, LOCAL_SESSION_SNAPSHOT_FILENAME);
    const text = await readFile(path, "utf8");
    expect(text).not.toContain(capabilities.ingest);
    expect(text).not.toContain(capabilities.stream);
    expect(text).not.toContain("/work/web");
    if (process.platform !== "win32") {
      // oxlint-disable-next-line no-bitwise -- verifying permission bits
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    expect(readLocalSessionSnapshot(directory)).toEqual([
      { id: session.id, label: "web", state: "open" },
    ]);

    await removeLocalSessionSnapshot(directory);
    expect(readLocalSessionSnapshot(directory)).toEqual([]);
  });

  test("is ignored once the daemon that wrote it has exited", async () => {
    const directory = await snapshotDirectory();
    await writeLocalSessionSnapshot(directory, exitedPid(), [SESSION]);
    expect(readLocalSessionSnapshot(directory)).toEqual([]);
  });

  test("leaves out retained sessions past their expiry", async () => {
    const directory = await snapshotDirectory();
    await writeLocalSessionSnapshot(directory, process.pid, [
      SESSION,
      { ...SESSION, id: "kept", state: "retained", expiresAt: 5000 },
      { ...SESSION, id: "expired", state: "retained", expiresAt: 4000 },
    ]);
    expect(
      readLocalSessionSnapshot(directory, 4000).map(({ id }) => id),
    ).toEqual([SESSION.id, "kept"]);
  });

  test("an absent or malformed file, or malformed entries, complete nothing", async () => {
    const directory = await snapshotDirectory();
    const path = join(directory, LOCAL_SESSION_SNAPSHOT_FILENAME);
    expect(readLocalSessionSnapshot(directory)).toEqual([]);
    for (const content of [
      "not json",
      "null",
      "[]",
      JSON.stringify({ pid: "1", sessions: [] }),
      JSON.stringify({ pid: process.pid, sessions: {} }),
    ]) {
      await writeFile(path, content);
      expect(readLocalSessionSnapshot(directory)).toEqual([]);
    }
    await writeFile(
      path,
      JSON.stringify({
        pid: process.pid,
        sessions: [
          null,
          { id: "", label: "empty", state: "open" },
          { id: "a", label: 1, state: "open" },
          { id: "b", label: "web", state: "closed" },
          { id: "c", label: "web", state: "retained", expiresAt: "later" },
          { id: "d", label: "web", state: "open" },
        ],
      }),
    );
    expect(readLocalSessionSnapshot(directory)).toEqual([
      { id: "d", label: "web", state: "open" },
    ]);
  });
});
