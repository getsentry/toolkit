/** Daemon identity and process invocation regression coverage. */
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useTestConfigDir } from "../../helpers.js";
import {
  readLocalDaemonState,
  getRunningLocalDaemon,
  requestLocalDaemon,
  writeLocalDaemonState,
  runLocalDaemonForeground,
} from "../../../src/commands/local/daemon.js";
import {
  LOCAL_SESSION_SNAPSHOT_FILENAME,
  readLocalSessionSnapshot,
} from "../../../src/commands/local/session-snapshot.js";

const getConfigDir = useTestConfigDir("local-daemon-lifecycle-");
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Local daemon discovery", () => {
  test("rejects stale state when another service answers the public health endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      (globalThis as { __originalFetch: typeof fetch }).__originalFetch,
    );
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("owner exited"), { code: "ESRCH" });
    });
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

  test("preserves live daemon discovery after a failed probe and recovers on retry", async () => {
    const state = {
      host: "127.0.0.1",
      port: 8969,
      pid: process.pid,
      token: "live",
      version: 1,
    };
    await writeLocalDaemonState(getConfigDir(), state);
    const probe = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporarily unavailable"))
      // The busy daemon still answers health as a daemon.
      .mockResolvedValueOnce(
        new Response("OK", { headers: { "X-Sentry-Local-Mode": "daemon" } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sessions: [] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", probe);
    await expect(getRunningLocalDaemon()).rejects.toThrow("still running");
    await expect(readLocalDaemonState(getConfigDir())).resolves.toEqual(state);
    await expect(getRunningLocalDaemon()).resolves.toEqual(state);
  });

  test("preserves discovery when the process existence check is permission denied", async () => {
    const state = {
      host: "127.0.0.1",
      port: 8969,
      pid: 42,
      token: "protected",
      version: 1,
    };
    await writeLocalDaemonState(getConfigDir(), state);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unreachable")));
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("permission denied"), { code: "EPERM" });
    });
    await expect(getRunningLocalDaemon()).rejects.toThrow("still running");
    await expect(readLocalDaemonState(getConfigDir())).resolves.toEqual(state);
  });

  test("rediscovering a dead snapshot does not erase a replacement daemon", async () => {
    const stale = {
      host: "127.0.0.1",
      port: 8969,
      pid: 42,
      token: "old",
      version: 1,
    };
    const replacement = { ...stale, pid: process.pid, token: "replacement" };
    const realKill = process.kill;
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === stale.pid)
        throw Object.assign(new Error("owner exited"), { code: "ESRCH" });
      return realKill(pid, signal);
    });
    let finishProbe: ((response: Response) => void) | undefined;
    const probe = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishProbe = resolve;
          }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sessions: [] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", probe);
    await writeLocalDaemonState(getConfigDir(), stale);
    const pending = getRunningLocalDaemon();
    await expect.poll(() => probe.mock.calls.length).toBe(1);
    await writeLocalDaemonState(getConfigDir(), replacement);
    if (!finishProbe) throw new Error("Missing deferred probe");
    finishProbe(new Response("wrong service", { status: 404 }));
    await expect(pending).resolves.toEqual(replacement);
    await expect(readLocalDaemonState(getConfigDir())).resolves.toEqual(
      replacement,
    );
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

/** A loopback port nothing listens on. */
async function freePort(): Promise<number> {
  const reserve = createServer();
  await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve));
  const address = reserve.address();
  if (!address || typeof address === "string")
    throw new Error("Expected a TCP address");
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  return address.port;
}

/**
 * After an unclean exit, the recorded PID can belong to an unrelated live
 * process (common in containers). Here that process is the test runner, and
 * nothing listens on the recorded port (CLI-4TA).
 */
describe("Local daemon discovery after PID reuse", () => {
  const ownerPath = () => join(getConfigDir(), "local-control-plane.owner");
  const statePath = () => join(getConfigDir(), "local-control-plane.json");
  // Explicit mtimes keep the lock-age checks independent of timestamp precision.
  const earlier = () => new Date(Date.now() - 60_000);
  const reusedState = async () => ({
    host: "127.0.0.1",
    port: await freePort(),
    pid: process.pid,
    token: "stale",
    version: 1,
  });

  test("clears discovery when the recorded port refuses connections", async () => {
    vi.stubGlobal(
      "fetch",
      (globalThis as { __originalFetch: typeof fetch }).__originalFetch,
    );
    await writeLocalDaemonState(getConfigDir(), await reusedState());
    await expect(getRunningLocalDaemon()).resolves.toBeUndefined();
    await expect(readLocalDaemonState(getConfigDir())).resolves.toBeUndefined();
  });

  test("also clears an owner lock that the same stale daemon wrote first", async () => {
    vi.stubGlobal(
      "fetch",
      (globalThis as { __originalFetch: typeof fetch }).__originalFetch,
    );
    await mkdir(getConfigDir(), { recursive: true });
    await writeFile(ownerPath(), String(process.pid));
    await writeLocalDaemonState(getConfigDir(), await reusedState());
    await utimes(ownerPath(), earlier(), earlier());
    await expect(getRunningLocalDaemon()).resolves.toBeUndefined();
    await expect(readLocalDaemonState(getConfigDir())).resolves.toBeUndefined();
    await expect(readFile(ownerPath(), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("preserves an owner lock newer than discovery, a daemon starting up", async () => {
    vi.stubGlobal(
      "fetch",
      (globalThis as { __originalFetch: typeof fetch }).__originalFetch,
    );
    const state = await reusedState();
    await writeLocalDaemonState(getConfigDir(), state);
    await writeFile(ownerPath(), String(process.pid));
    await utimes(statePath(), earlier(), earlier());
    await expect(getRunningLocalDaemon()).resolves.toBeUndefined();
    await expect(readLocalDaemonState(getConfigDir())).resolves.toEqual(state);
    expect(await readFile(ownerPath(), "utf8")).toBe(String(process.pid));
  });

  test("preserves discovery that another live owner is about to replace", async () => {
    vi.stubGlobal(
      "fetch",
      (globalThis as { __originalFetch: typeof fetch }).__originalFetch,
    );
    const state = await reusedState();
    await mkdir(getConfigDir(), { recursive: true });
    await writeFile(ownerPath(), String(process.ppid));
    await writeLocalDaemonState(getConfigDir(), state);
    await expect(getRunningLocalDaemon()).resolves.toBeUndefined();
    await expect(readLocalDaemonState(getConfigDir())).resolves.toEqual(state);
    expect(await readFile(ownerPath(), "utf8")).toBe(String(process.ppid));
  });

  test("finds a daemon that replaces discovery during the stale recheck", async () => {
    const originalFetch = (globalThis as { __originalFetch: typeof fetch })
      .__originalFetch;
    const server = createServer((request, response) => {
      response.statusCode =
        request.headers.authorization === "Bearer replacement" ? 200 : 401;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ sessions: [] }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected a TCP address");
    const replacement = {
      host: "127.0.0.1",
      port: address.port,
      pid: process.pid,
      token: "replacement",
      version: 1,
    };
    let calls = 0;
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      // The replacement lands after the first probe, before the recheck.
      calls += 1;
      if (calls === 2) await writeLocalDaemonState(getConfigDir(), replacement);
      return await originalFetch(...args);
    });
    try {
      await writeLocalDaemonState(getConfigDir(), await reusedState());
      await expect(getRunningLocalDaemon()).resolves.toEqual(replacement);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });

  test("uses a daemon that answers the stale recheck", async () => {
    const originalFetch = (globalThis as { __originalFetch: typeof fetch })
      .__originalFetch;
    let calls = 0;
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      calls += 1;
      if (calls === 1) return await originalFetch(...args);
      return Response.json({ sessions: [] });
    });
    const state = await reusedState();
    await writeLocalDaemonState(getConfigDir(), state);
    await expect(getRunningLocalDaemon()).resolves.toEqual(state);
    await expect(readLocalDaemonState(getConfigDir())).resolves.toEqual(state);
  });

  test("names both files to delete when a live daemon does not answer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    await writeLocalDaemonState(getConfigDir(), await reusedState());
    await expect(getRunningLocalDaemon()).rejects.toMatchObject({
      name: "CliError",
      message: expect.stringContaining(
        `delete ${statePath()} and ${ownerPath()}, then retry`,
      ),
    });
  });

  test.each([
    ["clears discovery when a non-daemon server holds the port", {}],
    [
      "keeps discovery when a busy daemon answers health",
      { "X-Sentry-Local-Mode": "daemon" },
    ],
  ])("%s", async (name, healthHeaders) => {
    vi.stubGlobal(
      "fetch",
      (globalThis as { __originalFetch: typeof fetch }).__originalFetch,
    );
    // Like a foreground `sentry local serve`: it rejects the daemon token.
    const server = createServer((request, response) => {
      if (request.url === "/health") response.writeHead(200, healthHeaders);
      else response.statusCode = 401;
      response.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected a TCP address");
    const state = { ...(await reusedState()), port: address.port };
    try {
      await writeLocalDaemonState(getConfigDir(), state);
      if (name.startsWith("clears")) {
        await expect(getRunningLocalDaemon()).resolves.toBeUndefined();
        await expect(
          readLocalDaemonState(getConfigDir()),
        ).resolves.toBeUndefined();
      } else {
        await expect(getRunningLocalDaemon()).rejects.toMatchObject({
          name: "CliError",
        });
        await expect(readLocalDaemonState(getConfigDir())).resolves.toEqual(
          state,
        );
      }
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });
});

/** Poll `read` until it returns a value `done` accepts. */
async function eventually<T>(
  read: () => T | Promise<T>,
  done: (value: T) => boolean,
): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for the Local daemon");
}

test("mirrors its sessions to the completion snapshot and removes it on shutdown", async () => {
  vi.stubGlobal(
    "fetch",
    (globalThis as { __originalFetch: typeof fetch }).__originalFetch,
  );
  const running = runLocalDaemonForeground({
    host: "127.0.0.1",
    port: await freePort(),
  });
  const state = await eventually(
    () => readLocalDaemonState(getConfigDir()),
    (value) => value !== undefined,
  );
  if (!state) throw new Error("Expected daemon discovery state");

  const created = await requestLocalDaemon(state, "/sessions", {
    body: JSON.stringify({ cwd: "/work/web", label: "web" }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const { id } = (await created.json()) as { id: string };
  await eventually(
    () => readLocalSessionSnapshot(),
    (sessions) => sessions.length === 1,
  );
  expect(readLocalSessionSnapshot()).toEqual([
    { id, label: "web", state: "open" },
  ]);

  await requestLocalDaemon(state, `/sessions/${id}/close`, { method: "POST" });
  await eventually(
    () => readLocalSessionSnapshot(),
    (sessions) => sessions[0]?.state === "retained",
  );

  await requestLocalDaemon(state, "/daemon/stop", { method: "POST" });
  await running;
  await expect(
    readFile(join(getConfigDir(), LOCAL_SESSION_SNAPSHOT_FILENAME)),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("closes the listener when discovery persistence fails", async () => {
  const port = await freePort();
  await mkdir(join(getConfigDir(), "local-control-plane.json"));
  await expect(
    runLocalDaemonForeground({ host: "127.0.0.1", port }),
  ).rejects.toThrow();
  const replacement = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      replacement.once("error", reject);
      replacement.listen(port, "127.0.0.1", resolve);
    });
  } finally {
    await new Promise<void>((resolve) => replacement.close(() => resolve()));
  }
});
