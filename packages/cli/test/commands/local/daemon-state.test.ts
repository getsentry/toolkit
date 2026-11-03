import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  readLocalDaemonState,
  removeLocalDaemonState,
  writeLocalDaemonState,
} from "../../../src/commands/local/daemon.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Local daemon state", () => {
  test("stores daemon discovery and the control capability in a private state file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sentry-local-state-"));
    directories.push(directory);
    const state = {
      host: "127.0.0.1",
      port: 8969,
      pid: 42,
      token: "secret",
      version: 1,
    };

    await writeLocalDaemonState(directory, state);

    await expect(readLocalDaemonState(directory)).resolves.toEqual(state);
    await removeLocalDaemonState(directory);
    await expect(readLocalDaemonState(directory)).resolves.toBeUndefined();
  });
});
