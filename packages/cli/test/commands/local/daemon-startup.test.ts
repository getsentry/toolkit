/**
 * Startup joins a live foreground owner while authenticated discovery is
 * pending, and reports a port that another server holds.
 */
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
  runLocalDaemonForeground,
  writeLocalDaemonState,
} from "../../../src/commands/local/daemon.js";
import {
  EXIT,
  PORT_IN_USE_FIELD,
  ValidationError,
} from "../../../src/lib/errors.js";

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
      // Like a real daemon, the foreground owner identifies itself on /health.
      response.setHeader("X-Sentry-Local-Mode", "daemon");
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

async function expectStartupLockReleased(): Promise<void> {
  await expect(
    readFile(join(getConfigDir(), "local-control-plane.lock"), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });
}

test("fails fast with a port-in-use error when a foreground `local serve` holds the port (CLI-4R9)", async () => {
  vi.stubGlobal(
    "fetch",
    (globalThis as { __originalFetch: typeof fetch }).__originalFetch,
  );
  const server = createServer((_request, response) => {
    response.setHeader("X-Powered-By", "spotlight-by-sentry");
    response.end("OK");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP address");
  const { port } = address;
  try {
    await expect(
      ensureLocalDaemon({ host: "127.0.0.1", port }),
    ).rejects.toMatchObject({
      name: "ValidationError",
      field: PORT_IN_USE_FIELD,
      message: expect.stringContaining(`Port ${port} is already in use`),
    });
    expect(spawn).not.toHaveBeenCalled();
    await expectStartupLockReleased();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("reports a port-in-use error when the daemon child exits with a validation status", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new TypeError("fetch failed")),
  );
  vi.mocked(spawn).mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(() => true),
      unref: vi.fn(),
    }) as unknown as ChildProcess;
    queueMicrotask(() => child.emit("exit", EXIT.VALIDATION, null));
    return child;
  });
  await expect(
    ensureLocalDaemon({ host: "127.0.0.1", port: 8969 }),
  ).rejects.toMatchObject({
    name: "ValidationError",
    field: PORT_IN_USE_FIELD,
    message: expect.stringContaining("Port 8969 is already in use"),
  });
  await expectStartupLockReleased();
});

test("names the foreground command, with its host, when the daemon child exits otherwise", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new TypeError("fetch failed")),
  );
  vi.mocked(spawn).mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(() => true),
      unref: vi.fn(),
    }) as unknown as ChildProcess;
    queueMicrotask(() => child.emit("exit", EXIT.GENERAL, null));
    return child;
  });
  await expect(
    ensureLocalDaemon({ host: "127.0.0.1", port: 8969 }),
  ).rejects.toMatchObject({
    name: "CliError",
    message: expect.stringContaining(
      "local daemon start --foreground --host 127.0.0.1 --port 8969",
    ),
  });
  await expectStartupLockReleased();
});

// Startup maps a child exit of EXIT.VALIDATION to a busy port, so the
// foreground daemon's other startup failures must not be ValidationErrors.
test.each([{ host: "example.com" }, { port: 0 }])(
  "keeps foreground startup failure %o out of the port-in-use exit status",
  async (options) => {
    const error = await runLocalDaemonForeground(options).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ValidationError);
  },
);
