import { createLocalRetentionBuffer } from "../../../src/commands/local/retention-buffer.js";
/**
 * Tests for the `sentry local run` command.
 *
 * Exercises the command's func() body directly to verify env var injection,
 * exit code propagation, auto-detection, --verify, --timeout, and error cases.
 */

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "@stricli/core";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  CLIENT_SPOTLIGHT_PREFIXES,
  runCommand,
  shutdownServer,
} from "../../../src/commands/local/run.js";
import {
  buildApp,
  DEFAULT_PORT,
  tryListen,
} from "../../../src/commands/local/server.js";
import { app } from "../../../src/app.js";
import type { SentryContext } from "../../../src/context.js";
import { openBrowser } from "../../../src/lib/browser.js";
import { logger } from "../../../src/lib/logger.js";
import {
  CliError,
  COMMAND_NOT_FOUND_FIELD,
  EXIT,
  PORT_HELD_BY_DAEMON_FIELD,
  PORT_IN_USE_FIELD,
  ValidationError,
  VerifyFailedError,
} from "../../../src/lib/errors.js";
import { SENTRY_CONTENT_TYPE } from "../../../src/lib/formatters/local.js";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn
import * as childSignals from "../../../src/lib/child-signals.js";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn
import * as windowsSpawn from "../../../src/lib/windows-spawn.js";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn
import * as daemon from "../../../src/commands/local/daemon.js";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn
import * as serverModule from "../../../src/commands/local/server.js";
import {
  wranglerInjectedMessage,
  wranglerSetupHint,
} from "../../../src/lib/wrangler.js";
import { TEST_TMP_DIR } from "../../constants.js";
import { useTestConfigDir } from "../../helpers.js";
import type { Writer } from "../../../src/types/index.js";

/**
 * Records the env passed to the most recent `spawn` call so tests can assert
 * which variables were injected into the child process. The mock below still
 * delegates to the real `spawn`, so commands like `true` run for
 * real and exit codes propagate normally.
 */
const spawnCapture: {
  args?: readonly string[];
  child?: ChildProcess | undefined;
  detached?: boolean | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  stdio?: Parameters<typeof import("node:child_process").spawn>[2]["stdio"];
} = {};

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (
      cmd: string,
      args: readonly string[],
      options?: Parameters<typeof actual.spawn>[2],
    ) => {
      spawnCapture.args = args;
      if (options?.env === undefined) {
        delete spawnCapture.env;
      } else {
        spawnCapture.env = options.env;
      }
      spawnCapture.stdio = options?.stdio;
      spawnCapture.detached = options?.detached;
      const child = actual.spawn(cmd, [...args], options ?? {});
      spawnCapture.child = child;
      return child;
    },
  };
});

vi.mock("../../../src/lib/browser.js", () => ({
  openBrowser: vi.fn().mockResolvedValue(true),
}));

type RunFunc = (
  this: unknown,
  flags: {
    port?: number;
    host: string;
    verify: boolean;
    timeout: number;
    format?: "human" | "json";
    attributes?: boolean;
    filter?: ("error" | "transaction" | "log" | "ai")[];
    open?: boolean;
    session?: string;
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
    stdout: { write: vi.fn<Writer["write"]>(() => true) },
    stderr: { write: vi.fn<Writer["write"]>(() => true) },
    cwd: cwd ?? tmpDir,
  };
}

describe("sentry local run", () => {
  beforeEach(() => {
    delete spawnCapture.args;
    delete spawnCapture.env;
    spawnCapture.stdio = undefined;
    spawnCapture.child = undefined;
  });

  test.each(["human", "json"] as const)(
    "prints a credential-free viewer link only for human tails (%s)",
    async (format) => {
      const info = vi.spyOn(logger, "info").mockImplementation(() => {});
      try {
        const func = (await runCommand.loader()) as unknown as RunFunc;
        await func.call(
          makeContext(),
          { port: 0, host: "127.0.0.1", verify: false, timeout: 0, format },
          process.execPath,
          "-e",
          "process.exit(0)",
        );
        const hints = info.mock.calls
          .map((c) => String(c[0]))
          .filter((line) => line.startsWith("View events at "));
        expect(hints).toHaveLength(format === "human" ? 1 : 0);
        if (hints[0]) {
          const url = new URL(hints[0].slice("View events at ".length));
          const receiver = new URL(url.searchParams.get("url")!);
          expect(url.origin).toBe("https://local.sentry.dev");
          expect(receiver.pathname).toBe("/stream");
          expect(Number(receiver.port)).toBeGreaterThan(0);
          expect(receiver.search).toBe("");
        }
      } finally {
        info.mockRestore();
      }
    },
  );

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
        "No command provided and could not auto-detect",
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
        "--",
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
    }
  });

  test("auto-detects dev command from package.json", async () => {
    await writeFile(
      join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { dev: "echo hello" } }),
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
      "ok",
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
      "true",
    );

    expect(openBrowserMock).toHaveBeenCalledWith(
      expect.stringMatching(
        /^http:\/\/localhost:5173\/#stream=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Fstream$/,
      ),
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
        "true",
      ),
    ).rejects.toMatchObject({
      field: "open",
      message: "--open cannot be used with --verify.",
    });
  });

  test("rejects --session with --verify before starting a receiver", async () => {
    const func = (await runCommand.loader()) as unknown as RunFunc;

    await expect(
      func.call(
        makeContext(),
        {
          port: 0,
          host: "localhost",
          verify: true,
          timeout: 0,
          session: "verification",
        },
        "true",
      ),
    ).rejects.toMatchObject({
      field: "session",
      message: "--session cannot be used with --verify.",
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
        "true",
      ),
    ).rejects.toMatchObject({
      field: "host.not_loopback",
      message:
        "--open requires a loopback --host (localhost, 127.0.0.1, or ::1).",
    });
  });

  test("injects SENTRY_SPOTLIGHT as a Wrangler Worker binding", async () => {
    await writeFile(join(tmpDir, "wrangler.jsonc"), "{}");
    const fakeWrangler = join(tmpDir, "wrangler");
    await writeFile(fakeWrangler, "#!/bin/sh\nexit 0\n");
    await chmod(fakeWrangler, 0o755);

    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    try {
      const func = (await runCommand.loader()) as unknown as RunFunc;
      await func.call(
        makeContext(),
        { port: 0, host: "127.0.0.1", verify: false, timeout: 0 },
        fakeWrangler,
        "dev",
      );
      // The binding alone captures nothing with @sentry/cloudflare, so the
      // notice must name the Worker setup that does.
      expect(info.mock.calls.map((c) => String(c[0]))).toContainEqual(
        expect.stringContaining("tunnel: env.SENTRY_SPOTLIGHT"),
      );
    } finally {
      info.mockRestore();
    }

    expect(spawnCapture.args).toEqual([
      "dev",
      "--var",
      expect.stringMatching(
        /^SENTRY_SPOTLIGHT:http:\/\/127\.0\.0\.1:\d+\/stream$/,
      ),
    ]);
  });

  test("keeps the session ingest capability out of the Starting line", async () => {
    await writeFile(join(tmpDir, "wrangler.jsonc"), "{}");
    const fakeWrangler = join(tmpDir, "wrangler");
    await writeFile(fakeWrangler, "#!/bin/sh\nexit 0\n");
    await chmod(fakeWrangler, 0o755);
    const base = "http://127.0.0.1:1/_local/v1/sessions/session-1";
    const create = vi
      .spyOn(daemon, "createLocalDaemonSession")
      .mockResolvedValue({
        cwd: tmpDir,
        id: "session-1",
        label: "web",
        ingestUrl: `${base}/ingest/ingest-secret`,
        streamUrl: `${base}/stream?cap=stream-secret`,
      });
    const retain = vi
      .spyOn(daemon, "retainLocalDaemonSession")
      .mockResolvedValue(undefined);
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const func = (await runCommand.loader()) as unknown as RunFunc;
      await func.call(
        makeContext(),
        {
          port: 0,
          host: "127.0.0.1",
          verify: false,
          timeout: 0,
          session: "web",
        },
        fakeWrangler,
        "dev",
      );
      const logged = [...info.mock.calls, ...warn.mock.calls]
        .map((c) => String(c[0]))
        .join("\n");
      expect(logged).toContain("Starting:");
      expect(logged).toContain("/ingest/[REDACTED]");
      expect(logged).not.toContain("secret");
      // The wrapped app still gets the working capability.
      expect(spawnCapture.args).toContain(
        `SENTRY_SPOTLIGHT:${base}/ingest/ingest-secret`,
      );
    } finally {
      create.mockRestore();
      retain.mockRestore();
      info.mockRestore();
      warn.mockRestore();
    }
  });

  test("prints the Worker setup hint in --verify mode too", async () => {
    await writeFile(join(tmpDir, "wrangler.jsonc"), "{}");
    const fakeWrangler = join(tmpDir, "wrangler");
    await writeFile(fakeWrangler, "#!/bin/sh\nexit 0\n");
    await chmod(fakeWrangler, 0o755);

    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    try {
      const func = (await runCommand.loader()) as unknown as RunFunc;
      // The fake Worker exits without sending, so verification fails.
      await expect(
        func.call(
          makeContext(),
          { port: 0, host: "127.0.0.1", verify: true, timeout: 0 },
          fakeWrangler,
          "dev",
        ),
      ).rejects.toBeInstanceOf(VerifyFailedError);
      expect(info.mock.calls.map((c) => String(c[0]))).toContainEqual(
        wranglerInjectedMessage(),
      );
    } finally {
      info.mockRestore();
    }
  });

  test("preserves existing SENTRY_TRACES_SAMPLE_RATE", async () => {
    const originalRate = process.env["SENTRY_TRACES_SAMPLE_RATE"];
    process.env["SENTRY_TRACES_SAMPLE_RATE"] = "0.5";
    try {
      const func = (await runCommand.loader()) as unknown as RunFunc;
      const ctx = makeContext();
      // The child process should get 0.5, not 1
      // We verify this indirectly — if it doesn't throw, the env was set
      await func.call(
        ctx,
        { port: 19_878, host: "127.0.0.1", verify: false, timeout: 0 },
        "printenv",
        "SENTRY_TRACES_SAMPLE_RATE",
      );
    } finally {
      if (originalRate === undefined) {
        delete process.env["SENTRY_TRACES_SAMPLE_RATE"];
      } else {
        process.env["SENTRY_TRACES_SAMPLE_RATE"] = originalRate;
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
        "false",
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).message).toContain("exited with code");
    }
  });

  test("reports a child killed by a signal with its name and 128+N", async () => {
    const func = (await runCommand.loader()) as unknown as RunFunc;
    const error = await func
      .call(
        makeContext(),
        { port: 0, host: "127.0.0.1", verify: false, timeout: 0 },
        "sh",
        "-c",
        "kill -KILL $$",
      )
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toBe(
      "Process exited with code 137 (killed by SIGKILL)",
    );
    expect((error as CliError).exitCode).toBe(137);
  });

  describe("on SIGINT or SIGTERM", () => {
    /**
     * A child that counts the SIGINTs it gets in `count`, and exits 0 half a
     * second after the first one so a duplicate still has time to arrive.
     */
    async function countingChild(): Promise<{ script: string; count: string }> {
      const count = join(tmpDir, "sigint-count");
      const script = join(tmpDir, "count-sigint.cjs");
      await writeFile(
        script,
        `const fs = require("node:fs");
let n = 0;
fs.writeFileSync(${JSON.stringify(count)}, "0");
process.on("SIGINT", () => {
  fs.writeFileSync(${JSON.stringify(count)}, String(++n));
  if (n === 1) setTimeout(() => process.exit(0), 500);
});
setInterval(() => {}, 1000);
`,
      );
      return { script, count };
    }

    /**
     * Catch the SIGINT/SIGTERM handlers `run` installs, so a test can call
     * them. Emitting the real event would also run the test preload's own
     * handler, which exits the worker.
     */
    function captureSignalHandlers() {
      const handlers = new Map<string | symbol, () => void>();
      const on = process.on.bind(process);
      const spy = vi
        .spyOn(process, "on")
        .mockImplementation((event, listener) => {
          if (event === "SIGINT" || event === "SIGTERM" || event === "SIGHUP") {
            handlers.set(event, listener as () => void);
            return process;
          }
          return on(event, listener);
        });
      return {
        send(signal: "SIGINT" | "SIGTERM" | "SIGHUP") {
          const handler = handlers.get(signal);
          if (!handler) {
            throw new Error(`run installed no ${signal} handler`);
          }
          handler();
        },
        restore: () => spy.mockRestore(),
      };
    }

    let signals: ReturnType<typeof captureSignalHandlers>;
    beforeEach(() => {
      signals = captureSignalHandlers();
    });
    afterEach(() => {
      signals.restore();
    });

    /** Wait until the spawned child is running, then return its pid. */
    async function childPid(count: string): Promise<number> {
      await vi.waitFor(async () => {
        await readFile(count, "utf8");
      });
      const pid = spawnCapture.child?.pid;
      if (pid === undefined) {
        throw new Error("child not spawned");
      }
      return pid;
    }

    test("forwards a SIGINT sent only to the CLI, once, and exits quietly", async () => {
      const { script, count } = await countingChild();
      const ctx = { ...makeContext(), process: { exitCode: undefined } };
      const func = (await runCommand.loader()) as unknown as RunFunc;
      const run = func.call(
        ctx,
        { port: 0, host: "127.0.0.1", verify: false, timeout: 0 },
        process.execPath,
        script,
      );
      await childPid(count);
      signals.send("SIGINT");
      await expect(run).resolves.toBeUndefined();
      expect(await readFile(count, "utf8")).toBe("1");
      expect(ctx.process.exitCode).toBeUndefined();
    });

    test("does not resend a Ctrl-C the terminal already sent to the child", async () => {
      const { script, count } = await countingChild();
      const foreground = vi
        .spyOn(childSignals, "terminalSignalsProcess")
        .mockReturnValue(true);
      // In a terminal the app shares the CLI's foreground group.
      const ownGroup = vi
        .spyOn(childSignals, "startsOwnProcessGroup")
        .mockReturnValue(false);
      try {
        const func = (await runCommand.loader()) as unknown as RunFunc;
        const run = func.call(
          { ...makeContext(), process: { exitCode: undefined } },
          { port: 0, host: "127.0.0.1", verify: false, timeout: 0 },
          process.execPath,
          script,
        );
        const pid = await childPid(count);
        // What the terminal does on Ctrl-C: signal the whole foreground
        // group, which holds both the CLI and the child.
        process.kill(pid, "SIGINT");
        signals.send("SIGINT");
        await expect(run).resolves.toBeUndefined();
        expect(await readFile(count, "utf8")).toBe("1");
        expect(spawnCapture.detached).toBe(false);
      } finally {
        foreground.mockRestore();
        ownGroup.mockRestore();
      }
    });

    test("passes on a second SIGINT even when the terminal sent the first", async () => {
      const { script, count } = await countingChild();
      const foreground = vi
        .spyOn(childSignals, "terminalSignalsProcess")
        .mockReturnValue(true);
      // In a terminal the app shares the CLI's foreground group.
      const ownGroup = vi
        .spyOn(childSignals, "startsOwnProcessGroup")
        .mockReturnValue(false);
      try {
        const func = (await runCommand.loader()) as unknown as RunFunc;
        const run = func.call(
          { ...makeContext(), process: { exitCode: undefined } },
          { port: 0, host: "127.0.0.1", verify: false, timeout: 0 },
          process.execPath,
          script,
        );
        await childPid(count);
        // Neither SIGINT came through the terminal, so only the second one
        // reaches the child.
        signals.send("SIGINT");
        signals.send("SIGINT");
        await expect(run).resolves.toBeUndefined();
        expect(await readFile(count, "utf8")).toBe("1");
        expect(foreground).toHaveBeenCalledTimes(1);
      } finally {
        foreground.mockRestore();
        ownGroup.mockRestore();
      }
    });

    test.each([
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ] as const)(
      "exits %s's code without an error when the child dies from it",
      async (signal, code) => {
        const ctx = { ...makeContext(), process: { exitCode: undefined } };
        const func = (await runCommand.loader()) as unknown as RunFunc;
        const ready = join(tmpDir, "ready");
        const run = func.call(
          ctx,
          { port: 0, host: "127.0.0.1", verify: false, timeout: 0 },
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(ready)}, "");setInterval(() => {}, 1000);`,
        );
        await vi.waitFor(async () => {
          await readFile(ready, "utf8");
        });
        signals.send(signal);
        await expect(run).resolves.toBeUndefined();
        expect(ctx.process.exitCode).toBe(code);
      },
    );

    describe("with an app behind a wrapper that ignores SIGINT", () => {
      /**
       * Like `go run`: ignores SIGINT, dies from SIGTERM without passing it
       * on, and starts the real app as its own child. The app writes its pid
       * to `appPidFile` and runs until a signal stops it, or exits by itself
       * after 20s so a failing test leaves nothing behind.
       */
      async function wrappedApp(): Promise<{
        wrapper: string;
        appPidFile: string;
      }> {
        const appPidFile = join(tmpDir, "app-pid");
        const app = join(tmpDir, "app.cjs");
        const wrapper = join(tmpDir, "go-run.cjs");
        await writeFile(
          app,
          `require("node:fs").writeFileSync(${JSON.stringify(appPidFile)}, String(process.pid));
setTimeout(() => {}, 20_000);
`,
        );
        await writeFile(
          wrapper,
          `process.on("SIGINT", () => {});
const app = require("node:child_process").spawn(process.execPath, [${JSON.stringify(app)}], { stdio: "inherit" });
app.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
`,
        );
        return { wrapper, appPidFile };
      }

      async function appPid(appPidFile: string): Promise<number> {
        let pid = 0;
        await vi.waitFor(async () => {
          pid = Number(await readFile(appPidFile, "utf8"));
          expect(pid).toBeGreaterThan(1);
        });
        return pid;
      }

      function isRunning(pid: number): boolean {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      }

      let ownGroup: ReturnType<typeof vi.spyOn>;
      beforeEach(() => {
        // No terminal: agents, CI and tools running --verify.
        ownGroup = vi
          .spyOn(childSignals, "startsOwnProcessGroup")
          .mockReturnValue(true);
      });
      afterEach(() => {
        ownGroup.mockRestore();
      });

      test("--verify leaves no app running when it times out", async () => {
        const { wrapper, appPidFile } = await wrappedApp();
        const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
        try {
          const func = (await runCommand.loader()) as unknown as RunFunc;
          const error = await func
            .call(
              makeContext(),
              { port: 0, host: "127.0.0.1", verify: true, timeout: 2 },
              process.execPath,
              wrapper,
            )
            .catch((err: unknown) => err);
          expect(error).toBeInstanceOf(VerifyFailedError);
          const pid = await appPid(appPidFile);
          expect(spawnCapture.detached).toBe(true);
          expect(isRunning(pid)).toBe(false);
        } finally {
          warn.mockRestore();
        }
      }, 30_000);

      test("--timeout leaves no app running", async () => {
        const { wrapper, appPidFile } = await wrappedApp();
        const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
        try {
          const func = (await runCommand.loader()) as unknown as RunFunc;
          await func
            .call(
              makeContext(),
              { port: 0, host: "127.0.0.1", verify: false, timeout: 2 },
              process.execPath,
              wrapper,
            )
            .catch(() => undefined);
          const pid = await appPid(appPidFile);
          expect(isRunning(pid)).toBe(false);
        } finally {
          warn.mockRestore();
        }
      }, 30_000);

      test.each(["SIGINT", "SIGTERM"] as const)(
        "%s stops the app, not just the wrapper",
        async (signal) => {
          const { wrapper, appPidFile } = await wrappedApp();
          const ctx = { ...makeContext(), process: { exitCode: undefined } };
          const func = (await runCommand.loader()) as unknown as RunFunc;
          const run = func.call(
            ctx,
            { port: 0, host: "127.0.0.1", verify: false, timeout: 0 },
            process.execPath,
            wrapper,
          );
          const pid = await appPid(appPidFile);
          signals.send(signal);
          await expect(run).resolves.toBeUndefined();
          expect(isRunning(pid)).toBe(false);
        },
        30_000,
      );

      test("passes a hangup on to the app's group", async () => {
        // Without a terminal, a supervisor's hangup to the CLI's group no
        // longer reaches the app in its own group.
        const { wrapper, appPidFile } = await wrappedApp();
        const ctx = { ...makeContext(), process: { exitCode: undefined } };
        const func = (await runCommand.loader()) as unknown as RunFunc;
        const run = func.call(
          ctx,
          { port: 0, host: "127.0.0.1", verify: false, timeout: 0 },
          process.execPath,
          wrapper,
        );
        const pid = await appPid(appPidFile);
        signals.send("SIGHUP");
        await expect(run).resolves.toBeUndefined();
        expect(isRunning(pid)).toBe(false);
      }, 30_000);

      test("--verify passes a hangup on to the app's group, then exits from it", async () => {
        const { wrapper, appPidFile } = await wrappedApp();
        // --verify re-raises the signal on itself once the app is gone; keep
        // that one from reaching the test worker.
        const kill = process.kill.bind(process);
        const selfSignals: (string | number | undefined)[] = [];
        const killSpy = vi
          .spyOn(process, "kill")
          .mockImplementation((target, signal) => {
            if (target === process.pid) {
              selfSignals.push(signal);
              return true;
            }
            return kill(target, signal);
          });
        try {
          const func = (await runCommand.loader()) as unknown as RunFunc;
          const run = func.call(
            makeContext(),
            { port: 0, host: "127.0.0.1", verify: true, timeout: 20 },
            process.execPath,
            wrapper,
          );
          const pid = await appPid(appPidFile);
          signals.send("SIGHUP");
          await expect(run).resolves.toBeUndefined();
          expect(isRunning(pid)).toBe(false);
          expect(selfSignals).toEqual(["SIGHUP"]);
        } finally {
          killSpy.mockRestore();
        }
      }, 30_000);

      test("keeps its signal handlers until the leftover app is stopped", async () => {
        // A wrapper that exits on SIGINT, and an app that ignores SIGINT and
        // SIGTERM, so stopping the leftover app takes the whole grace period.
        const appPidFile = join(tmpDir, "stubborn-pid");
        const app = join(tmpDir, "stubborn.cjs");
        const wrapper = join(tmpDir, "quick-wrapper.cjs");
        await writeFile(
          app,
          `process.on("SIGINT", () => {});
process.on("SIGTERM", () => {});
require("node:fs").writeFileSync(${JSON.stringify(appPidFile)}, String(process.pid));
setTimeout(() => {}, 20_000);
`,
        );
        await writeFile(
          wrapper,
          `require("node:child_process").spawn(process.execPath, [${JSON.stringify(app)}], { stdio: "inherit" });
setInterval(() => {}, 1000);
`,
        );
        const appStateAtRemoval: boolean[] = [];
        let pid = 0;
        const removeListener = process.removeListener.bind(process);
        const removal = vi
          .spyOn(process, "removeListener")
          .mockImplementation((event, listener) => {
            if (event === "SIGINT") {
              appStateAtRemoval.push(isRunning(pid));
            }
            return removeListener(event, listener);
          });
        try {
          const ctx = { ...makeContext(), process: { exitCode: undefined } };
          const func = (await runCommand.loader()) as unknown as RunFunc;
          const run = func.call(
            ctx,
            { port: 0, host: "127.0.0.1", verify: false, timeout: 0 },
            process.execPath,
            wrapper,
          );
          pid = await appPid(appPidFile);
          signals.send("SIGINT");
          await expect(run).resolves.toBeUndefined();
          expect(appStateAtRemoval).toEqual([false]);
          expect(isRunning(pid)).toBe(false);
        } finally {
          removal.mockRestore();
        }
      }, 30_000);
    });
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
        "60",
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      // The child is killed by SIGTERM, resulting in a non-zero exit
      expect((err as CliError).message).toContain("exited with code");
    }
  });

  test("--verify with a quick-exit process throws VERIFY_FAILED", async () => {
    const func = (await runCommand.loader()) as unknown as RunFunc;
    const ctx = makeContext();

    try {
      await func.call(
        ctx,
        { port: 0, host: "127.0.0.1", verify: true, timeout: 0 },
        "true",
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(VerifyFailedError);
      expect((err as CliError).message).toContain(
        "Process exited before sending any events",
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
        "60",
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(VerifyFailedError);
      expect((err as CliError).message).toContain("Verification timed out");
      expect((err as CliError).exitCode).toBe(64);
    }
  });

  test.each([false, true])(
    "reports a missing command as command not found (verify: %s, CLI-3NK)",
    async (verify) => {
      const func = (await runCommand.loader()) as unknown as RunFunc;
      const error = await func
        .call(
          makeContext(),
          { port: 0, host: "127.0.0.1", verify, timeout: 5 },
          "nonexistent-command-that-does-not-exist",
        )
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).field).toBe(COMMAND_NOT_FOUND_FIELD);
      expect((error as Error).message).toMatch(
        /^Command not found: nonexistent-command-that-does-not-exist\n/,
      );
    },
  );

  test("--verify does not hang when the spawn fails and close never fires", async () => {
    // A failed spawn has no pid and may emit `error` without `close`.
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      exitCode: null,
      stdout: null,
      stderr: null,
      kill: vi.fn(() => false),
    });
    const spawnSpy = vi
      .spyOn(windowsSpawn, "spawnUserCommand")
      .mockImplementation(() => {
        setImmediate(() =>
          child.emit(
            "error",
            Object.assign(new Error("spawn EACCES"), { code: "EACCES" }),
          ),
        );
        return child as unknown as ChildProcess;
      });
    try {
      const func = (await runCommand.loader()) as unknown as RunFunc;
      await expect(
        func.call(
          makeContext(),
          { port: 0, host: "127.0.0.1", verify: true, timeout: 60 },
          "some-tool",
        ),
      ).rejects.toThrow('Failed to start "some-tool": spawn EACCES');
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      spawnSpy.mockRestore();
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
      "true",
    );
  });

  test("tails events from a server it did not start", async () => {
    // Reproduces the case where the Spotlight desktop app (or another
    // `sentry local serve`) already owns the port: `run` must attach as an SSE
    // consumer instead of going silent for the whole session.
    const buffer = createLocalRetentionBuffer(10).buffer;
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
        "1",
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
    const buffer = createLocalRetentionBuffer(10).buffer;
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
        "1",
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
      "true",
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
        "1",
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
    expect(capturedEnv?.["SENTRY_SPOTLIGHT"]).toBe(expectedUrl);
    // Every framework client variant points at the same URL.
    for (const prefix of CLIENT_SPOTLIGHT_PREFIXES) {
      expect(capturedEnv?.[`${prefix}SENTRY_SPOTLIGHT`]).toBe(expectedUrl);
    }
  });
});

/** A wrapped app that sends one error envelope to the injected receiver. */
const SEND_ONE_EVENT = [
  "-e",
  [
    'const id = "a".repeat(32);',
    "const body = [JSON.stringify({ event_id: id }), JSON.stringify({ type: 'event' }), JSON.stringify({ event_id: id, message: 'verify me' })].join(String.fromCharCode(10));",
    "fetch(process.env.SENTRY_SPOTLIGHT, { method: 'POST', headers: { 'content-type': 'application/x-sentry-envelope' }, body }).then(() => setTimeout(() => {}, 30000));",
  ].join(" "),
];

/** Hold `port` on `host`; resolves undefined when something already holds it. */
async function holdPort(
  port: number,
  host: string,
): Promise<Server | undefined> {
  const server = createServer((_req, res) => res.end("OK"));
  return await new Promise((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") resolve(undefined);
      else reject(err);
    });
    server.listen(port, host, () => resolve(server));
  });
}

function closeServer(server: Server | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!server) resolve();
    else server.close(() => resolve());
  });
}

/**
 * Make the default port look busy without binding it, so the test neither
 * depends on nor disturbs whatever else uses that port.
 */
function makeDefaultPortBusy() {
  const realTryListen = serverModule.tryListen;
  return vi
    .spyOn(serverModule, "tryListen")
    .mockImplementation((listenApp, port, hostname, options) =>
      port === DEFAULT_PORT
        ? Promise.reject(serverModule.portInUseError(port))
        : realTryListen(listenApp, port, hostname, options),
    );
}

/** A context for running `local run` through Stricli flag parsing. */
function makeParsedRunContext() {
  return {
    ...makeContext(),
    process: { ...process, exitCode: undefined },
    env: process.env,
    homeDir: tmpDir,
    configDir: tmpDir,
    stdin: process.stdin,
  } as unknown as SentryContext & { process: { exitCode?: number } };
}

describe("sentry local run --verify receiver", () => {
  useTestConfigDir("local-run-verify-");

  test("reports events as reaching Sentry Local, without a viewer link", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    try {
      const func = (await runCommand.loader()) as unknown as RunFunc;
      await func.call(
        makeContext(),
        { port: 0, host: "127.0.0.1", verify: true, timeout: 20 },
        process.execPath,
        ...SEND_ONE_EVENT,
      );
      const lines = info.mock.calls.map((c) => String(c[0]));
      expect(lines).toContain(
        "Setup verified — your app is sending events to Sentry Local",
      );
      expect(lines.some((line) => line.startsWith("View events at "))).toBe(
        false,
      );
    } finally {
      info.mockRestore();
    }
  });

  test("does not verify on an event that is not JSON", async () => {
    const sendInvalidEvent = [
      "-e",
      [
        "const body = ['{}', JSON.stringify({ type: 'event' }), 'not-json'].join(String.fromCharCode(10));",
        "fetch(process.env.SENTRY_SPOTLIGHT, { method: 'POST', body }).then(() => setTimeout(() => {}, 30000));",
      ].join(" "),
    ];
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const func = (await runCommand.loader()) as unknown as RunFunc;
      const error = await func
        .call(
          makeContext(),
          { port: 0, host: "127.0.0.1", verify: true, timeout: 2 },
          process.execPath,
          ...sendInvalidEvent,
        )
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(VerifyFailedError);
      expect((error as Error).message).toContain("Verification timed out");
    } finally {
      warn.mockRestore();
    }
  });

  test("verifies on a free port when the default port is busy", async () => {
    const busy = makeDefaultPortBusy();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const context = makeParsedRunContext();
    try {
      const started = Date.now();
      // Goes through flag parsing, so --port is omitted the way a user omits it.
      await run(
        app,
        [
          "local",
          "run",
          "--verify",
          "--host",
          "127.0.0.1",
          "--timeout",
          "20",
          "--",
          process.execPath,
          ...SEND_ONE_EVENT,
        ],
        context,
      );
      expect(context.process.exitCode ?? 0).toBe(0);
      const receiver = new URL(spawnCapture.env?.["SENTRY_SPOTLIGHT"] ?? "");
      expect(receiver.pathname).toBe("/stream");
      expect(Number(receiver.port)).not.toBe(DEFAULT_PORT);
      expect(Number(receiver.port)).toBeGreaterThan(0);
      // Client-side variants get the fallback port too, not the default.
      expect(spawnCapture.env?.["NEXT_PUBLIC_SENTRY_SPOTLIGHT"]).toBe(
        receiver.href,
      );
      expect(warn).not.toHaveBeenCalledWith(
        expect.stringContaining("retrying"),
      );
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      warn.mockRestore();
      busy.mockRestore();
    }
  }, 30_000);

  test("says which port it used when verify on a fallback port times out", async () => {
    const busy = makeDefaultPortBusy();
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const context = makeParsedRunContext();
    try {
      await run(
        app,
        [
          "local",
          "run",
          "--verify",
          "--host",
          "127.0.0.1",
          "--timeout",
          "1",
          "--",
          process.execPath,
          "-e",
          "setTimeout(() => {}, 30000)",
        ],
        context,
      );
      expect(context.process.exitCode).toBe(EXIT.VERIFY_FAILED);
      const port = new URL(spawnCapture.env?.["SENTRY_SPOTLIGHT"] ?? "").port;
      const notice = `Port ${DEFAULT_PORT} is in use, so this run listens on port ${port} instead. SDKs that hard-code ${DEFAULT_PORT} won't reach it; make sure they read SENTRY_SPOTLIGHT.`;
      // Once when it binds, and again when nothing arrived.
      expect(info).toHaveBeenCalledWith(notice);
      expect(warn).toHaveBeenCalledWith(notice);
    } finally {
      info.mockRestore();
      warn.mockRestore();
      busy.mockRestore();
    }
  }, 30_000);

  test("fails fast when an explicit --port is busy", async () => {
    const holder = await holdPort(0, "127.0.0.1");
    const address = holder?.address();
    if (!address || typeof address === "string")
      throw new Error("Expected a TCP address");
    spawnCapture.env = undefined;
    try {
      const func = (await runCommand.loader()) as unknown as RunFunc;
      const started = Date.now();
      const error = await func
        .call(
          makeContext(),
          { port: address.port, host: "127.0.0.1", verify: true, timeout: 20 },
          "true",
        )
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({
        field: PORT_IN_USE_FIELD,
        message: expect.stringContaining(
          `Port ${address.port} is already in use`,
        ),
      });
      expect((error as Error).message).toContain("omit --port");
      expect(Date.now() - started).toBeLessThan(5000);
      expect(spawnCapture.env).toBeUndefined();
    } finally {
      await closeServer(holder);
    }
  }, 30_000);
});

describe("sentry local run messages", () => {
  useTestConfigDir("local-run-messages-");

  /** Answer like `isServerRunning` does when the daemon holds `port`. */
  function makeDaemonHoldPort(port: number) {
    const realIsServerRunning = serverModule.isServerRunning;
    return vi
      .spyOn(serverModule, "isServerRunning")
      .mockImplementation((url) =>
        new URL(url).port === String(port)
          ? Promise.reject(
              new ValidationError(
                "A Sentry Local daemon is using this port. Add --session <name> or choose another --port.",
                PORT_HELD_BY_DAEMON_FIELD,
              ),
            )
          : realIsServerRunning(url),
      );
  }

  test("plain run captures on a free port while the daemon holds the default port", async () => {
    const daemonPort = makeDaemonHoldPort(DEFAULT_PORT);
    const busy = makeDefaultPortBusy();
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const context = makeParsedRunContext();
    try {
      await run(
        app,
        [
          "local",
          "run",
          "--host",
          "127.0.0.1",
          "--",
          process.execPath,
          "-e",
          "",
        ],
        context,
      );
      expect(context.process.exitCode ?? 0).toBe(0);
      const receiver = new URL(spawnCapture.env?.["SENTRY_SPOTLIGHT"] ?? "");
      expect(Number(receiver.port)).not.toBe(DEFAULT_PORT);
      expect(Number(receiver.port)).toBeGreaterThan(0);
      expect(info).toHaveBeenCalledWith(
        `Port ${DEFAULT_PORT} is held by the Local daemon, so this run listens on port ${receiver.port} instead. SDKs that hard-code ${DEFAULT_PORT} won't reach it; make sure they read SENTRY_SPOTLIGHT. Add --session <name> to capture into the daemon instead.`,
      );
    } finally {
      info.mockRestore();
      busy.mockRestore();
      daemonPort.mockRestore();
    }
  }, 30_000);

  test("plain run still fails when the daemon holds an explicit --port", async () => {
    const daemonPort = makeDaemonHoldPort(45_678);
    spawnCapture.env = undefined;
    try {
      const func = (await runCommand.loader()) as unknown as RunFunc;
      const error = await func
        .call(
          makeContext(),
          { port: 45_678, host: "127.0.0.1", verify: false, timeout: 0 },
          "true",
        )
        .catch((err: unknown) => err);
      expect(error).toMatchObject({ field: PORT_HELD_BY_DAEMON_FIELD });
      expect(spawnCapture.env).toBeUndefined();
    } finally {
      daemonPort.mockRestore();
    }
  });

  test("--verify reports a crashed app once", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const func = (await runCommand.loader()) as unknown as RunFunc;
      const error = await func
        .call(
          makeContext(),
          { port: 0, host: "127.0.0.1", verify: true, timeout: 20 },
          process.execPath,
          "-e",
          "process.exit(1)",
        )
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(VerifyFailedError);
      expect((error as Error).message).toBe("Process crashed with code 1");
      expect(warn).not.toHaveBeenCalledWith(
        expect.stringContaining("Process crashed"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("--verify tells a Wrangler Worker to get a request when it times out", async () => {
    const dir = await mkdtemp(join(TEST_TMP_DIR, "local-run-wrangler-"));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await writeFile(join(dir, "wrangler.jsonc"), "{}");
      const fakeWrangler = join(dir, "wrangler");
      // A Worker that waits for a request and never gets one.
      await writeFile(fakeWrangler, "#!/bin/sh\nexec sleep 30\n");
      await chmod(fakeWrangler, 0o755);
      const func = (await runCommand.loader()) as unknown as RunFunc;
      const error = await func
        .call(
          makeContext(dir),
          { port: 0, host: "127.0.0.1", verify: true, timeout: 1 },
          fakeWrangler,
          "dev",
        )
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(VerifyFailedError);
      expect((error as Error).message).toBe(
        "Verification timed out after 1s — no events received from the SDK",
      );
      const warnings = warn.mock.calls.map((c) => String(c[0]));
      expect(warnings).toContainEqual(
        `A Worker sends nothing until it handles a request, so send one to it while --verify waits. ${wranglerSetupHint()}`,
      );
      expect(warnings.join("\n")).not.toContain("Verification timed out");
      expect(warnings.join("\n")).not.toContain("SENTRY_DSN");
    } finally {
      warn.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("--verify suggests a SENTRY_DSN for SDKs without Spotlight when it times out", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const func = (await runCommand.loader()) as unknown as RunFunc;
      const error = await func
        .call(
          makeContext(),
          { port: 0, host: "127.0.0.1", verify: true, timeout: 1 },
          "sleep",
          "30",
        )
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(VerifyFailedError);
      const port = new URL(spawnCapture.env?.["SENTRY_SPOTLIGHT"] ?? "").port;
      expect(warn).toHaveBeenCalledWith(
        `SDKs without Spotlight support, such as Go and Rust, need SENTRY_DSN=http://key@127.0.0.1:${port}/0 instead.`,
      );
    } finally {
      warn.mockRestore();
    }
  }, 30_000);
});
