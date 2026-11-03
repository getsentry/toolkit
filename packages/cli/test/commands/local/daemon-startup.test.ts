/** Startup joins a live foreground owner while authenticated discovery is pending. */
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { useTestConfigDir } from "../../helpers.js";
import {
  ensureLocalDaemon,
  writeLocalDaemonState,
} from "../../../src/commands/local/daemon.js";

vi.mock("node:child_process", async (importOriginal) => {
  const cp = await importOriginal<typeof import("node:child_process")>();
  return { ...cp, spawn: vi.fn() };
});
const getConfigDir = useTestConfigDir("local-foreground-startup-");
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(spawn).mockReset();
});

test.each(["before startup", "after spawn"])(
  "joins live foreground ownership appearing %s without surfacing the losing child's exit",
  async (stage) => {
    vi.stubGlobal(
      "fetch",
      (globalThis as { __originalFetch: typeof fetch }).__originalFetch,
    );
    const server = createServer((request, response) => {
      response.statusCode =
        request.url === "/_local/v1/sessions" &&
        request.headers.authorization === "Bearer foreground-token"
          ? 200
          : 401;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ sessions: [] }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected TCP address");
    const directory = getConfigDir();
    const owner = join(directory, "local-control-plane.owner");
    const state = {
      host: "127.0.0.1",
      port: address.port,
      pid: process.pid,
      token: "foreground-token",
      version: 1,
    };
    let publishing: Promise<void> | undefined;
    const beginForeground = () => {
      writeFileSync(owner, String(process.pid));
      publishing = sleep(300).then(() =>
        writeLocalDaemonState(directory, state),
      );
    };
    if (stage === "before startup") beginForeground();
    vi.mocked(spawn).mockImplementation(() => {
      if (stage === "after spawn") beginForeground();
      const child = Object.assign(new EventEmitter(), {
        kill: vi.fn(() => true),
        unref: vi.fn(),
      }) as unknown as ChildProcess;
      queueMicrotask(() => child.emit("exit", 1, null));
      return child;
    });
    try {
      await expect(
        ensureLocalDaemon({ host: "127.0.0.1", port: address.port }),
      ).resolves.toEqual(state);
      expect(await readFile(owner, "utf8")).toBe(String(process.pid));
      await expect(
        readFile(join(directory, "local-control-plane.lock"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await publishing;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  },
);
