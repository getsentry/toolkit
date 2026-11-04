import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { scheduleForceExit } from "../../src/lib/force-exit.js";

const originalPlatform = process.platform;
const originalNodeEnv = process.env.NODE_ENV;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

beforeEach(() => {
  setPlatform("linux");
  process.env.NODE_ENV = "test";
});

afterEach(() => {
  vi.restoreAllMocks();
  setPlatform(originalPlatform);
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
});

/** Let the `.then()` on the flush promise run. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("force-exit safety net", () => {
  test("schedules an unref'd 100ms timer on macOS outside tests", async () => {
    const unref = vi.fn();
    const timeout = { unref } as unknown as ReturnType<typeof setTimeout>;
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue(timeout);
    setPlatform("darwin");
    process.env.NODE_ENV = "production";

    scheduleForceExit();
    await settle();

    expect(setTimeoutSpy).toHaveBeenCalledOnce();
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 100);
    expect(unref).toHaveBeenCalledOnce();
  });

  test("does nothing outside macOS when the flush settles", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    process.env.NODE_ENV = "production";

    scheduleForceExit(Promise.resolve(true));
    await settle();

    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test("exits on every platform when the flush times out", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    process.env.NODE_ENV = "production";
    process.exitCode = 10;

    scheduleForceExit(Promise.resolve(false));
    await settle();
    process.exitCode = undefined;

    expect(exitSpy).toHaveBeenCalledWith(10);
  });

  test("does nothing in the test environment even on macOS", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    setPlatform("darwin");
    process.env.NODE_ENV = "test";

    scheduleForceExit(Promise.resolve(false));
    await settle();

    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
