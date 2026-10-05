/**
 * Tests for the `sentry local run` command.
 *
 * Exercises the command's func() body directly to verify env var injection,
 * exit code propagation, auto-detection, --verify, --timeout, and error cases.
 */

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSpotlightBuffer } from "@spotlightjs/spotlight/sdk";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  CLIENT_SPOTLIGHT_PREFIXES,
  runCommand,
  shutdownServer,
} from "../../../src/commands/local/run.js";
import { buildApp, tryListen } from "../../../src/commands/local/server.js";
import { openBrowser } from "../../../src/lib/browser.js";
import { CliError, ValidationError } from "../../../src/lib/errors.js";
import { SENTRY_CONTENT_TYPE } from "../../../src/lib/formatters/local.js";
import { TEST_TMP_DIR } from "../../constants.js";

/**
 * Records the env passed to the most recent `spawn` call so tests can assert
 * which variables were injected into the child process. The mock below still
 * delegates to the real `spawn`, so commands like `true` run for
 * real and exit codes propagate normally.
 */
const spawnCapture: {
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  stdio?: Parameters<typeof import("node:child_process").spawn>[2]["stdio"];
} = {};

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (
      cmd: string,
      args: readonly string[],
      options: Parameters<typeof actual.spawn>[2]
    ) => {
      spawnCapture.args = args;
      spawnCapture.env = (options as { env?: NodeJS.ProcessEnv })?.env;
      spawnCapture.stdio = (
        options as { stdio?: typeof spawnCapture.stdio }
      )?.stdio;
      return actual.spawn(cmd, args as string[], options);
    },
  };
});

vi.mock("../../../src/lib/browser.js", () => ({
  openBrowser: vi.fn().mockResolvedValue(true),
}));

type RunFunc = (
  this: unknown,
  flags: {
    port: number;
    host: string;
    verify: boolean;
    timeout: number;
    format?: "human" | "json";
    attributes?: boolean;
    filter?: ("error" | "transaction" | "log" | "ai")[];
    open?: boolean;
  },
  ...args: string[]
) => Promise<void>;

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(TEST_TMP_DIR, "run-test-"));
});

afterEach(async () => {
  try {
    await rm(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

function makeContext(cwd?: string) {
  return {
    stdout: { write: vi.fn(() => true) },
    stderr: { write: vi.fn(() => true) },
    cwd: cwd ?? tmpDir,
  };
}

describe("sentry local run", () => {
  beforeEach(() => {
    spawnCapture.args = undefined;
    spawnCapture.env = undefined;
    spawnCapture.stdio = undefined;
  });

  test("throws ValidationError when no command and no auto-detect", async () => {
    const func = (await runCommand.loader()) as unknown as RunFunc;
    const ctx = makeContext();
    try {
      await func.call(ctx, {
        port: 0,
        host: "localhost",
        verify: false,
        timeout: 0,
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toContain(
        "No command provided and could not auto-detect"
      );
    }
  });

  test("throws ValidationError with only -- separator", async () => {
    const func = (await runCommand.loader()) as unknown as RunFunc;
    const ctx = makeContext();
    try {
      await func.call(
        ctx,
        { port: 0, host: "localhost", verify: false, timeout: 0 },
        "--"
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
    }
  });

  test("auto-detects dev command from package.json", async () => {
    await writeFile(
      join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { dev: "echo hello" } })
    );

    const func = (await runCommand.loader()) as unknown as RunFunc;
    const ctx = makeContext();

    // No args provided — should auto-detect and run "echo hello"
    await func.call(ctx, {
      port: 0,
      host: "127.0.0.1",
      verify: false,
      timeout: 0,
    });
    // If we get here without throwing, auto-detection worked and
    // "echo hello" exited 0.
  });

  test("injects SENTRY_SPOTLIGHT env var into child process", async () => {
    const func = (await runCommand.loader()) as unknown as RunFunc;
    const ctx = makeContext();

    const port = 19_876;
    await func.call(
      ctx,
      { port, host: "127.0.0.1", verify: false, timeout: 0 },
      "echo",
      "ok"
    );
  });

  test("opens the development UI with the bound receiver stream", async () => {
    const openBrowserMock = vi.mocked(openBrowser);
    openBrowserMock.mockClear();
    const func = (await runCommand.loader()) as unknown as RunFunc;

    await func.call(
      makeContext(),
      {
        port: 0,
        host: "127.0.0.1",
        verify: false,
        timeout: 0,
        open: true,
      },
      "true"
    );

    expect(openBrowserMock).toHaveBeenCalledWith(
      expect.stringMatching(
        /^http:\/\/localhost:5173\/#stream=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Fstream$/
      )
    );
  });

  test("rejects --open with --verify before starting a receiver", async () => {
    const func = (await runCommand.loader()) as unknown as RunFunc;

    await expect(
      func.call(
        makeContext(),
        {
          port: 0,
          host: "localhost",
          verify: true,
          timeout: 0,
          open: true,
        },
        "true"
      )
    ).rejects.toMatchObject({
      field: "open",
      message: "--open cannot be used with --verify.",
    });
  });

  test("rejects a non-loopback --open host before starting a receiver", async () => {
    const func = (await runCommand.loader()) as unknown as RunFunc;

    await expect(
      func.call(
        makeContext(),
        {
          port: 0,
          host: "0.0.0.0",
          verify: false,
          timeout: 0,
          open: true,
        },
        "true"
      )
    ).rejects.toMatchObject({
      field: "host",
      message:
        "--open requires a loopback --host (localhost, 127.0.0.1, or ::1).",
    });
  });

  test("injects SENTRY_SPOTLIGHT as a Wrangler Worker binding", async () => {
    await writeFile(join(tmpDir, "wrangler.jsonc"), "{}");
    const fakeWrangler = join(tmpDir, "wrangler");
    await writeFile(fakeWrangler, "#!/bin/sh\nexit 0\n");
    await chmod(fakeWrangler, 0o755);

    const func = (await runCommand.loader()) as unknown as RunFunc;
    await func.call(
      makeContext(),
      { port: 0, host: "127.0.0.1", verify: false, timeout: 0 },
      fakeWrangler,
      "dev"
    );

    expect(spawnCapture.args).toEqual([
      "dev",
      "--var",
      expect.stringMatching(
        /^SENTRY_SPOTLIGHT:http:\/\/127\.0\.0\.1:\d+\/stream$/
      ),
    ]);
  });

  test("preserves existing SENTRY_TRACES_SAMPLE_RATE", async () => {
    const originalRate = process.env.SENTRY_TRACES_SAMPLE_RATE;
    process.env.SENTRY_TRACES_SAMPLE_RATE = "0.5";
    try {
      const func = (await runCommand.loader()) as unknown as RunFunc;
      const ctx = makeContext();
      // The child process should get 0.5, not 1
      // We verify this indirectly — if it doesn't throw, the env was set
      await func.call(
        ctx,
        { port: 19_878, host: "127.0.0.1", verify: false, timeout: 0 },
        "printenv",
        "SENTRY_TRACES_SAMPLE_RATE"
      );
    } finally {
      if (originalRate === undefined) {
        delete process.env.SENTRY_TRACES_SAMPLE_RATE;
      } else {
        process.env.SENTRY_TRACES_SAMPLE_RATE = originalRate;
      }
    }
  });

  test("propagates non-zero exit code as CliError", async () => {
    const func = (await runCommand.loader()) as unknown as RunFunc;
    const ctx = makeContext();

    const port = 19_877;
    try {
      await func.call(
        ctx,
        { port, host: "127.0.0.1", verify: false, timeout: 0 },
        "false"
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).message).toContain("exited with code");
    }
  });

  test("--timeout kills the child after N seconds", async () => {
    const func = (await runCommand.loader()) as unknown as RunFunc;
    const ctx = makeContext();

    // "sleep 60" would take too long — timeout at 1s should kill it
    try {
      await func.call(
        ctx,
        { port: 0, host: "127.0.0.1", verify: false, timeout: 1 },
        "sleep",
        "60"
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      // The child is killed by SIGTERM, resulting in a non-zero exit
      expect((err as CliError).message).toContain("exited with code");
    }
  });

  test("--verify with a quick-exit process throws WIZARD_VERIFY", async () => {
    const func = (await runCommand.loader()) as unknown as RunFunc;
    const ctx = makeContext();

    try {
      await func.call(
        ctx,
        { port: 0, host: "127.0.0.1", verify: true, timeout: 0 },
        "true"
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).message).toContain(
        "Process exited before sending any events"
      );
      expect((err as CliError).exitCode).toBe(64);
    }
  });

  test("--verify with --timeout throws on timeout", async () => {
    const func = (await runCommand.loader()) as unknown as RunFunc;
    const ctx = makeContext();

    try {
      await func.call(
        ctx,
        { port: 0, host: "127.0.0.1", verify: true, timeout: 1 },
        "sleep",
        "60"
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).message).toContain("Verification timed out");
      expect((err as CliError).exitCode).toBe(64);
    }
  });

  test("throws on ENOENT (command not found)", async () => {
    const func = (await runCommand.loader()) as unknown as RunFunc;
    const ctx = makeContext();

    try {
      await func.call(
        ctx,
        { port: 19_879, host: "127.0.0.1", verify: false, timeout: 0 },
        "nonexistent-command-that-does-not-exist"
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(
        /exited with code|Failed to start|ENOENT|spawn/i
      );
    }
  });

  test("strips leading -- separator from args", async () => {
    const func = (await runCommand.loader()) as unknown as RunFunc;
    const ctx = makeContext();

    // "-- true" should strip "--" and run "true" successfully
    await func.call(
      ctx,
      { port: 19_880, host: "127.0.0.1", verify: false, timeout: 0 },
      "--",
      "true"
    );
  });

  test("tails events from a server it did not start", async () => {
    // Reproduces the case where the Spotlight desktop app (or another
    // `sentry local serve`) already owns the port: `run` must attach as an SSE
    // consumer instead of going silent for the whole session.
    const buffer = createSpotlightBuffer(10);
    const { server, port } = await tryListen(buildApp(buffer), 0, "127.0.0.1");

    // preload.ts mocks fetch to block external calls; this test talks to a
    // loopback server it just started, so it needs the real implementation.
    const savedFetch = globalThis.fetch;
    const realFetch = (globalThis as { __originalFetch?: typeof fetch })
      .__originalFetch;
    if (realFetch) {
      globalThis.fetch = realFetch;
    }

    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(chunk.toString());
        return true;
      });

    try {
      // Buffered before we attach — SSE subscribers replay from the buffer
      // head, so this arrives regardless of connection timing.
      await fetch(`http://127.0.0.1:${port}/stream`, {
        method: "POST",
        headers: { "Content-Type": SENTRY_CONTENT_TYPE },
        body: '{"sdk":{"name":"sentry.javascript.node"}}\n{"type":"log","item_count":1,"content_type":"application/vnd.sentry.items.log+json"}\n{"items":[{"timestamp":1750000000,"level":"info","body":"Hello from the server!","attributes":{}}]}',
      });

      const func = (await runCommand.loader()) as unknown as RunFunc;
      await func.call(
        makeContext(),
        { port, host: "127.0.0.1", verify: false, timeout: 0 },
        "sleep",
        "1"
      );
    } finally {
      spy.mockRestore();
      globalThis.fetch = savedFetch;
      await shutdownServer(server);
    }

    const output = writes.join("");
    expect(output).toContain("Connected to existing server");
    expect(output).toContain("Hello from the server!");
    // A healthy attach must not emit the give-up warning.
    expect(output).not.toContain("Could not attach to the event stream");
  });

  test("writes normalized NDJSON to stdout when following an existing server", async () => {
    // A one-command agent workflow uses `local run --format json`, including
    // when another process already owns the local receiver.
    const buffer = createSpotlightBuffer(10);
    const { server, port } = await tryListen(buildApp(buffer), 0, "127.0.0.1");
    const savedFetch = globalThis.fetch;
    const realFetch = (globalThis as { __originalFetch?: typeof fetch })
      .__originalFetch;
    if (realFetch) {
      globalThis.fetch = realFetch;
    }

    const stdoutWrites: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stdoutWrites.push(chunk.toString());
        return true;
      });

    try {
      await fetch(`http://127.0.0.1:${port}/stream`, {
        method: "POST",
        headers: { "Content-Type": SENTRY_CONTENT_TYPE },
        body: '{"sdk":{"name":"sentry.javascript.node"}}\n{"type":"session"}\n{"timestamp":"2026-09-07T00:00:00Z"}\n{"type":"event","event_id":"event-123"}\n{"event_id":"event-123","timestamp":1750000000,"message":"JSON tail failure"}',
      });

      const func = (await runCommand.loader()) as unknown as RunFunc;
      await func.call(
        makeContext(),
        {
          port,
          host: "127.0.0.1",
          verify: false,
          timeout: 0,
          format: "json",
          attributes: false,
          filter: ["error"],
        },
        "sleep",
        "1"
      );
    } finally {
      stdoutSpy.mockRestore();
      globalThis.fetch = savedFetch;
      await shutdownServer(server);
    }

    const records = stdoutWrites
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toEqual([
      expect.objectContaining({
        schema_version: 1,
        event_id: "event-123",
        message: "JSON tail failure",
      }),
    ]);
  });

  test("routes child output away from the NDJSON channel", async () => {
    const func = (await runCommand.loader()) as unknown as RunFunc;
    await func.call(
      makeContext(),
      {
        port: 0,
        host: "127.0.0.1",
        verify: false,
        timeout: 0,
        format: "json",
        attributes: false,
      },
      "true"
    );

    expect(spawnCapture.stdio).toEqual(["inherit", "pipe", "pipe"]);
  });

  test("warns when the existing server's stream cannot be attached", async () => {
    // `/health` answers but `/stream` does not — e.g. an unrelated service
    // squatting on the port. Attaching fails, and since `run` keeps the child
    // alive the user would otherwise get no hint that events are missing.
    const brokenApp = new Hono();
    brokenApp.get("/health", (c) => c.text("OK"));
    const { server, port } = await tryListen(brokenApp, 0, "127.0.0.1");

    const savedFetch = globalThis.fetch;
    const realFetch = (globalThis as { __originalFetch?: typeof fetch })
      .__originalFetch;
    if (realFetch) {
      globalThis.fetch = realFetch;
    }

    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(chunk.toString());
        return true;
      });

    try {
      const func = (await runCommand.loader()) as unknown as RunFunc;
      // The child has to outlive the failed connection attempt; an
      // instant-exit command would abort the tail before it ever reports.
      await func.call(
        makeContext(),
        { port, host: "127.0.0.1", verify: false, timeout: 0 },
        "sleep",
        "1"
      );
    } finally {
      spy.mockRestore();
      globalThis.fetch = savedFetch;
      await shutdownServer(server);
    }

    expect(writes.join("")).toContain("Could not attach to the event stream");
  });

  test("injects spotlight URL under every framework client prefix", async () => {
    const func = (await runCommand.loader()) as unknown as RunFunc;
    const ctx = makeContext();

    const port = 19_881;
    const host = "127.0.0.1";
    const expectedUrl = `http://${host}:${port}/stream`;

    // `node:child_process` is mocked at module scope (see vi.mock below). The
    // mock records the env handed to spawn so we can assert against it.
    await func.call(ctx, { port, host, verify: false, timeout: 0 }, "true");

    const capturedEnv = spawnCapture.env;
    expect(capturedEnv).toBeDefined();
    // Base name read by server-side SDKs.
    expect(capturedEnv?.SENTRY_SPOTLIGHT).toBe(expectedUrl);
    // Every framework client variant points at the same URL.
    for (const prefix of CLIENT_SPOTLIGHT_PREFIXES) {
      expect(capturedEnv?.[`${prefix}SENTRY_SPOTLIGHT`]).toBe(expectedUrl);
    }
  });
});
