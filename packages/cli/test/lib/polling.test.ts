import { afterEach, describe, expect, test, vi } from "vitest";
import {
  abortableSleep,
  parsePollInterval,
  withProgress,
} from "../../src/lib/polling.js";

const originalIsTTY = process.stdout.isTTY;

function createDeferred<T>() {
  let resolve: (value: T) => void;
  let reject: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, reject: reject!, resolve: resolve! };
}

function enableInteractiveOutput() {
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: true,
  });
  vi.stubEnv("SENTRY_PLAIN_OUTPUT", "0");
  return vi.spyOn(process.stdout, "write").mockReturnValue(true);
}

afterEach(() => {
  vi.clearAllTimers();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: originalIsTTY,
  });
  vi.restoreAllMocks();
});

describe("withProgress", () => {
  test("rotates progress messages until an interactive operation resolves", async () => {
    vi.useFakeTimers();
    const stdoutWrite = enableInteractiveOutput();
    const deferred = createDeferred<string>();
    const operation = withProgress(
      {
        message: "Searching Sentry docs…",
        rotatingMessages: ["Finding the relevant bits…"],
        rotationIntervalMs: 4000,
      },
      async () => await deferred.promise,
    );

    await vi.advanceTimersByTimeAsync(4000);

    expect(stdoutWrite.mock.calls.flat().join("")).toContain(
      "Finding the relevant bits…",
    );

    deferred.resolve("done");
    await expect(operation).resolves.toBe("done");

    const writesAfterCompletion = stdoutWrite.mock.calls.length;
    await vi.advanceTimersByTimeAsync(8000);
    expect(stdoutWrite).toHaveBeenCalledTimes(writesAfterCompletion);
  });

  test("stops rotating progress messages when an interactive operation rejects", async () => {
    vi.useFakeTimers();
    const stdoutWrite = enableInteractiveOutput();
    const deferred = createDeferred<never>();
    const operation = withProgress(
      {
        message: "Searching Sentry docs…",
        rotatingMessages: ["It’s getting there…"],
        rotationIntervalMs: 4000,
      },
      async () => await deferred.promise,
    );

    await vi.advanceTimersByTimeAsync(4000);
    expect(stdoutWrite.mock.calls.flat().join("")).toContain(
      "It’s getting there…",
    );

    deferred.reject(new Error("docs unavailable"));
    await expect(operation).rejects.toThrow("docs unavailable");

    const writesAfterRejection = stdoutWrite.mock.calls.length;
    await vi.advanceTimersByTimeAsync(8000);
    expect(stdoutWrite).toHaveBeenCalledTimes(writesAfterRejection);
  });

  test("keeps JSON output free of progress messages", async () => {
    const stdoutWrite = enableInteractiveOutput();

    await expect(
      withProgress(
        {
          json: true,
          message: "Searching Sentry docs…",
          rotatingMessages: ["It’s getting there…"],
          rotationIntervalMs: 4000,
        },
        async () => "done",
      ),
    ).resolves.toBe("done");

    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  test("keeps plain output free of progress messages", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    vi.stubEnv("SENTRY_PLAIN_OUTPUT", "1");
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await expect(
      withProgress(
        {
          message: "Searching Sentry docs…",
          rotatingMessages: ["It’s getting there…"],
          rotationIntervalMs: 4000,
        },
        async () => "done",
      ),
    ).resolves.toBe("done");

    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  test("keeps forced-rich piped output free of interactive-only progress", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
    vi.stubEnv("SENTRY_PLAIN_OUTPUT", "0");
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await expect(
      withProgress(
        {
          interactiveOnly: true,
          message: "Searching Sentry docs…",
          rotatingMessages: ["It’s getting there…"],
          rotationIntervalMs: 4000,
        },
        async () => "done",
      ),
    ).resolves.toBe("done");

    expect(stdoutWrite).not.toHaveBeenCalled();
  });
});

describe("parsePollInterval", () => {
  test("accepts whole seconds at or above the minimum", () => {
    expect(parsePollInterval("5", { flag: "--interval" })).toBe(5);
    expect(parsePollInterval("10", { flag: "--refresh", min: 10 })).toBe(10);
  });

  test("rejects fractions, junk, and values below the minimum", () => {
    for (const value of ["0", "1.5", "5s", "", "-3"]) {
      expect(() => parsePollInterval(value, { flag: "--interval" })).toThrow(
        "--interval must be a whole number of seconds, at least 1",
      );
    }
    expect(() =>
      parsePollInterval("9", { flag: "--refresh", min: 10 }),
    ).toThrow("--refresh must be a whole number of seconds, at least 10");
  });
});

describe("abortableSleep", () => {
  test("resolves at once when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(abortableSleep(60_000, controller.signal)).resolves.toBe(
      undefined,
    );
  });

  test("resolves early when the signal aborts mid-sleep", async () => {
    const controller = new AbortController();
    const sleeping = abortableSleep(60_000, controller.signal);
    controller.abort();
    await expect(sleeping).resolves.toBe(undefined);
  });
});
