/**
 * Local session arguments complete from the snapshot the running daemon
 * keeps in the config directory, since `__complete` cannot ask the daemon.
 */

import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { writeLocalSessionSnapshot } from "../../src/commands/local/session-snapshot.js";
import type { LocalSession } from "../../src/commands/local/session-store.js";
import { getCompletions } from "../../src/lib/complete.js";
import { useTestConfigDir } from "../helpers.js";

const getConfigDir = useTestConfigDir("test-complete-local-session-");

const WEB = "0190a6e1-0000-7000-8000-00000000000a";
const API = "0190a6e1-0000-7000-8000-00000000000b";
const API_RETRY = "0190a6e1-0000-7000-8000-00000000000c";
const SPACED = "0190a6e1-0000-7000-8000-00000000000d";

function session(
  id: string,
  label: string,
  state: LocalSession["state"] = "open",
): LocalSession {
  return {
    id,
    label,
    state,
    cwd: "/work",
    createdAt: 1000,
    lastActivityAt: 1000,
    maxEnvelopes: 100,
    ...(state === "retained" && { expiresAt: Date.now() + 60_000 }),
  };
}

function writeSessions(pid = process.pid) {
  return writeLocalSessionSnapshot(getConfigDir(), pid, [
    session(WEB, "web"),
    session(API, "api"),
    session(API_RETRY, "api", "retained"),
    session(SPACED, "my app"),
  ]);
}

describe("getCompletions: Local sessions", () => {
  test("session IDs by label and state, then labels only one session has", async () => {
    await writeSessions();
    expect(await getCompletions(["local", "session", "view"], "")).toEqual([
      { value: WEB, description: "web (open)" },
      { value: API, description: "api (open)" },
      { value: API_RETRY, description: "api (retained)" },
      { value: SPACED, description: "my app (open)" },
      { value: "web", description: `open session ${WEB}` },
    ]);
    expect(
      (await getCompletions(["local", "event", "list"], "w")).map(
        (c) => c.value,
      ),
    ).toEqual(["web"]);
    expect(
      (await getCompletions(["local", "session", "close"], WEB)).map(
        (c) => c.value,
      ),
    ).toEqual([WEB]);
  });

  test("the telemetry ID after the session completes nothing", async () => {
    await writeSessions();
    expect(
      (await getCompletions(["local", "envelope", "view"], "")).length,
    ).toBeGreaterThan(0);
    expect(
      await getCompletions(["local", "envelope", "view", WEB], ""),
    ).toEqual([]);
    expect(await getCompletions(["local", "event", "view", "web"], "")).toEqual(
      [],
    );
  });

  test("nothing without a running daemon", async () => {
    expect(await getCompletions(["local", "session", "view"], "")).toEqual([]);
    const { pid } = spawnSync(process.execPath, ["-e", ""]);
    await writeSessions(pid);
    expect(await getCompletions(["local", "session", "view"], "")).toEqual([]);
  });
});
