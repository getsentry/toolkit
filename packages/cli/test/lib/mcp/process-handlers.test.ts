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
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
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
});
