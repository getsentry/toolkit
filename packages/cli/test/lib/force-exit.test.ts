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

describe("force-exit safety net", () => {
  test("schedules an unref'd 100ms timer on macOS outside tests", () => {
    const unref = vi.fn();
    const timeout = { unref } as unknown as ReturnType<typeof setTimeout>;
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue(timeout);
    setPlatform("darwin");
    process.env.NODE_ENV = "production";

    scheduleForceExit();

    expect(setTimeoutSpy).toHaveBeenCalledOnce();
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 100);
    expect(unref).toHaveBeenCalledOnce();
  });

  test("does nothing outside macOS", () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    process.env.NODE_ENV = "production";

    scheduleForceExit();

    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  test("does nothing in the test environment even on macOS", () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    setPlatform("darwin");
    process.env.NODE_ENV = "test";

    scheduleForceExit();

    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });
});
