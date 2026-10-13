/** Daemon identity and process invocation regression coverage. */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useTestConfigDir } from "../../helpers.js";
import {
  getRunningLocalDaemon,
  writeLocalDaemonState,
  runLocalDaemonForeground,
} from "../../../src/commands/local/daemon.js";

const getConfigDir = useTestConfigDir("local-daemon-lifecycle-");
afterEach(() => vi.unstubAllGlobals());

describe("Local daemon discovery", () => {
  test("rejects stale state when another service answers the public health endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      (globalThis as { __originalFetch: typeof fetch }).__originalFetch,
    );
    const server = createServer((request, response) => {
      response.statusCode = request.url === "/health" ? 200 : 404;
      response.end("OK");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected a TCP address");
    try {
      await writeLocalDaemonState(getConfigDir(), {
        host: "127.0.0.1",
        port: address.port,
        pid: process.pid,
        token: "stale",
        version: 1,
      });
      await expect(getRunningLocalDaemon()).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    }
  });

  test("rejects non-loopback discovery without making a request", async () => {
    const mock = vi.fn();
    vi.stubGlobal("fetch", mock);
    await writeLocalDaemonState(getConfigDir(), {
      host: "example.com",
      port: 8969,
      pid: process.pid,
      token: "secret",
      version: 1,
    });
    await expect(getRunningLocalDaemon()).resolves.toBeUndefined();
    expect(mock).not.toHaveBeenCalled();
  });

  test("rejects port zero in foreground mode", async () => {
    await expect(
      runLocalDaemonForeground({ host: "127.0.0.1", port: 0 }),
    ).rejects.toThrow("non-zero");
  });
});

test("closes the listener when discovery persistence fails", async () => {
  const reserve = createServer();
  await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve));
  const address = reserve.address();
  if (!address || typeof address === "string")
    throw new Error("Expected a TCP address");
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  await mkdir(join(getConfigDir(), "local-control-plane.json"));
  await expect(
    runLocalDaemonForeground({ host: "127.0.0.1", port: address.port }),
  ).rejects.toThrow();
  const replacement = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      replacement.once("error", reject);
      replacement.listen(address.port, "127.0.0.1", resolve);
    });
  } finally {
    await new Promise<void>((resolve) => replacement.close(() => resolve()));
  }
});
