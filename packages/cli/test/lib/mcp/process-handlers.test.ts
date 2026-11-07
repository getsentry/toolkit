import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const sentry = vi.hoisted(() => ({
  flush: vi.fn((_timeout?: number) => Promise.resolve(true)),
}));

vi.mock("@sentry/node", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/node")>()),
  captureException: vi.fn(),
  flush: sentry.flush,
}));

const { installProcessHandlers } =
  await import("../../../src/lib/mcp/server.js");
const { installStreamErrorHandlers } =
  await import("../../../src/lib/stream-errors.js");
const { logger } = await import("../../../src/lib/logger.js");

type Handler = (...args: unknown[]) => void;

const handlers = new Map<string, Handler>();
let exit: ReturnType<typeof vi.spyOn>;

/** Let pending flush promises and their `.finally` callbacks run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  // The fatal path arms a real-exit backstop timer; keep it from firing.
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  handlers.clear();
  // Capture the handlers instead of attaching them to the test process.
  vi.spyOn(process, "on").mockImplementation(((
    event: string,
    handler: Handler,
  ) => {
    handlers.set(event, handler);
    return process;
  }) as typeof process.on);
  exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as typeof process.exit);
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
  vi.spyOn(logger, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  process.exitCode = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  sentry.flush.mockImplementation(() => Promise.resolve(true));
});

describe("installProcessHandlers", () => {
  test("a signal during a fatal error's flush keeps the failing exit code", async () => {
    const pending = Promise.withResolvers<boolean>();
    sentry.flush.mockImplementation(() => pending.promise);
    const exitAfterError = installProcessHandlers();

    exitAfterError(new Error("boom"), "Server error:");
    handlers.get("SIGTERM")?.();
    pending.resolve(true);
    await settle();

    expect(exit).not.toHaveBeenCalledWith(0);
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("a signal alone shuts down cleanly", async () => {
    installProcessHandlers();

    handlers.get("SIGINT")?.();
    await settle();
    expect(exit).toHaveBeenCalledWith(0);
  });

  test("a signal shuts down cleanly when stderr is already closed", async () => {
    vi.mocked(logger.info).mockImplementation(() => {
      throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    });
    installProcessHandlers();

    handlers.get("SIGTERM")?.();
    await settle();
    expect(exit).toHaveBeenCalledWith(0);
  });

  test("a fatal error exits non-zero when its report hits a closed stderr", async () => {
    // The code each exit would end the process with: its argument, or
    // `process.exitCode` when it has none.
    const codes: unknown[] = [];
    exit.mockImplementation(((code?: number) => {
      codes.push(code ?? process.exitCode ?? 0);
    }) as typeof process.exit);
    let stderrError: Handler | undefined;
    vi.spyOn(process.stderr, "on").mockImplementation(((
      event: string,
      handler: Handler,
    ) => {
      if (event === "error") {
        stderrError = handler;
      }
      return process.stderr;
    }) as typeof process.stderr.on);
    vi.spyOn(process.stdout, "on").mockImplementation(
      (() => process.stdout) as typeof process.stdout.on,
    );
    installStreamErrorHandlers();
    const exitAfterError = installProcessHandlers();
    // The client closed its pipes: writing the report raises EPIPE.
    vi.mocked(logger.error).mockImplementation(() => {
      stderrError?.(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    });

    exitAfterError(new Error("boom"), "Server error:");
    await settle();

    expect(codes[0]).toBe(1);
    expect(codes).not.toContain(0);
  });
});
