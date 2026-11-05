import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { reportLingeringHandles } from "../../src/lib/lingering-handles.js";
import { logger, setLogLevel } from "../../src/lib/logger.js";

const originalLevel = logger.level;
let stderr: string;

beforeEach(() => {
  vi.useFakeTimers();
  stderr = "";
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setLogLevel(originalLevel);
});

describe("reportLingeringHandles", () => {
  test("at debug level, lists the resources still alive after the delay", () => {
    setLogLevel(4);
    vi.spyOn(process, "getActiveResourcesInfo").mockReturnValue([
      "TCPSocketWrap",
      "Timeout",
    ]);

    reportLingeringHandles(1000);
    expect(stderr).toBe("");
    vi.advanceTimersByTime(1000);

    expect(stderr).toContain("Still running 1000ms after the command finished");
    expect(stderr).toContain("TCPSocketWrap, Timeout");
  });

  test("below debug level, arms no timer", () => {
    setLogLevel(3);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    reportLingeringHandles();

    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });
});
