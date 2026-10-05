/**
 * Tests for the `/dev/tty` forwarding install→teardown lifecycle.
 *
 * The production code opens a real `/dev/tty` fd via `openSync` and checks
 * `isatty(0)` for the environment gate. To exercise the state transitions
 * deterministically we pass `TtyDeps` that:
 *
 *   - override `isTty` to return `true` (bun test runs with piped stdin, so
 *     the default predicate short-circuits the install path),
 *   - override `openTty` to return a `/dev/ptmx` fd — a pseudo-TTY master
 *     that `new ReadStream(fd)` accepts, with no keyboard side effects.
 *
 * `/dev/ptmx` is Linux-specific. Tests skip gracefully on platforms where it
 * isn't available.
 */

import { existsSync, openSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  closeFreshTtyForwarding,
  forwardFreshTtyToStdin,
} from "../../../src/lib/init/stdin-reopen.js";

const HAS_PTMX = existsSync("/dev/ptmx");

/**
 * Open a fresh `/dev/ptmx` fd for use as a pseudo-TTY fixture. The returned
 * fd is owned by the `ReadStream` that the test attaches it to —
 * `fresh.destroy()` inside teardown closes it. No explicit close needed
 * from the test body.
 */
function makePtmxFd(): { fd: number } {
  const fd = openSync("/dev/ptmx", "r+");
  return { fd };
}

/**
 * Assign `process.stdin.isTTY` via `Object.defineProperty` so the test
 * works regardless of whether the runtime defined `isTTY` as writable or
 * readonly. On CI (Node/Bun with piped stdin), `isTTY` is a non-writable
 * property and bare assignment throws `TypeError: Attempted to assign to
 * readonly property`. `defineProperty` overrides the descriptor in-place.
 */
function setIsTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, "isTTY", {
    value,
    writable: true,
    configurable: true,
  });
}

/**
 * `bun test` runs with piped stdin, so `process.stdin.setRawMode` is
 * typically `undefined` (the method only exists on real TTY streams).
 * The production code captures these methods at install time via
 * `stdinHandle.setRawMode` etc., so we stub them on `process.stdin` before
 * each test and restore after. This matches what the real Bun binary would
 * provide when stdin is actually a TTY.
 */
type StdinStubState = {
  restore: () => void;
};

function stubStdinTtyMethods(): StdinStubState {
  const stdin = process.stdin as unknown as Record<string, unknown>;
  const keys = ["setRawMode", "pause", "resume", "_read"] as const;
  const originals: Record<string, unknown> = {};
  const hadKey: Record<string, boolean> = {};
  for (const key of keys) {
    hadKey[key] = key in stdin;
    originals[key] = stdin[key];
  }
  // Install test stubs. Each stub returns process.stdin so chainable-style
  // callers (clack's setRawMode, etc.) behave sensibly.
  stdin.setRawMode = (_mode: boolean) => process.stdin;
  stdin.pause = () => process.stdin;
  stdin.resume = () => process.stdin;
  stdin._read = (_size: number) => {
    // intentionally empty — test stub
  };

  return {
    restore: () => {
      for (const key of keys) {
        if (hadKey[key]) {
          stdin[key] = originals[key];
        } else {
          delete stdin[key];
        }
      }
    },
  };
}

let stdinStub: StdinStubState | undefined;

beforeEach(() => {
  stdinStub = stubStdinTtyMethods();
});

afterEach(() => {
  // Defense-in-depth: if a test installs forwarding and throws before
  // tearing down, reset the module state before the next test runs.
  closeFreshTtyForwarding();
  stdinStub?.restore();
  stdinStub = undefined;
});

describe("closeFreshTtyForwarding (null-state paths)", () => {
  test("is a no-op when forwarding was never installed", () => {
    expect(() => closeFreshTtyForwarding()).not.toThrow();
  });

  test("is idempotent across repeated calls", () => {
    expect(() => {
      closeFreshTtyForwarding();
      closeFreshTtyForwarding();
      closeFreshTtyForwarding();
    }).not.toThrow();
  });
});

describe("forwardFreshTtyToStdin no-install paths", () => {
  test("does not patch stdin methods when isTty predicate is false", () => {
    const originalSetRawMode = process.stdin.setRawMode;
    const handle = forwardFreshTtyToStdin({ isTty: () => false });
    // Handle is a Disposable but install was skipped — stdin untouched.
    expect(handle).toBeDefined();
    expect(process.stdin.setRawMode).toBe(originalSetRawMode);
    // Disposing the no-install handle is a safe no-op.
    expect(() => handle[Symbol.dispose]()).not.toThrow();
    expect(process.stdin.setRawMode).toBe(originalSetRawMode);
  });

  test("does not patch stdin methods when the openTty factory throws", () => {
    const originalSetRawMode = process.stdin.setRawMode;
    const openTty = vi.fn(() => {
      throw new Error("fake /dev/tty unavailable");
    });
    const handle = forwardFreshTtyToStdin({ isTty: () => true, openTty });
    expect(handle).toBeDefined();
    expect(openTty).toHaveBeenCalledTimes(1);
    expect(process.stdin.setRawMode).toBe(originalSetRawMode);
  });
});

describe("forwardFreshTtyToStdin → closeFreshTtyForwarding round trip", () => {
  if (!HAS_PTMX) {
    test("skipped: /dev/ptmx unavailable on this platform", () => {
      expect(HAS_PTMX).toBe(false);
    });
    return;
  }

  test("install captures and teardown restores stdin methods", () => {
    const { fd } = makePtmxFd();
    const openTty = vi.fn(() => fd);

    const originalSetRawMode = process.stdin.setRawMode;
    const originalPause = process.stdin.pause;
    const originalResume = process.stdin.resume;

    const handle = forwardFreshTtyToStdin({ isTty: () => true, openTty });
    expect(handle).toBeDefined();
    expect(openTty).toHaveBeenCalledTimes(1);

    // After install, process.stdin methods are patched — they no longer
    // match the pre-install references.
    expect(process.stdin.setRawMode).not.toBe(originalSetRawMode);
    expect(process.stdin.pause).not.toBe(originalPause);
    expect(process.stdin.resume).not.toBe(originalResume);

    closeFreshTtyForwarding();

    // After teardown the originals are restored by reference equality.
    expect(process.stdin.setRawMode).toBe(originalSetRawMode);
    expect(process.stdin.pause).toBe(originalPause);
    expect(process.stdin.resume).toBe(originalResume);
  });

  test("isTTY restored to its pre-install value (backfill branch)", () => {
    const { fd } = makePtmxFd();
    const stdin = process.stdin as { isTTY?: boolean };
    const previousIsTty = stdin.isTTY;

    // Force the backfill branch by clearing isTTY up-front.
    setIsTTY(undefined);

    try {
      const handle = forwardFreshTtyToStdin({
        isTty: () => true,
        openTty: () => fd,
      });
      expect(handle).toBeDefined();
      // Install backfilled isTTY to true.
      expect(stdin.isTTY).toBe(true);

      closeFreshTtyForwarding();
      // Teardown restored to the pre-install value (undefined).
      expect(stdin.isTTY).toBeUndefined();
    } finally {
      setIsTTY(previousIsTty);
    }
  });

  test("isTTY untouched when already set (no-backfill branch)", () => {
    const { fd } = makePtmxFd();
    const stdin = process.stdin as { isTTY?: boolean };
    const previousIsTty = stdin.isTTY;
    setIsTTY(true);

    try {
      const handle = forwardFreshTtyToStdin({
        isTty: () => true,
        openTty: () => fd,
      });
      expect(handle).toBeDefined();
      expect(stdin.isTTY).toBe(true);

      closeFreshTtyForwarding();
      // backfilledIsTty was false, so teardown must not touch isTTY.
      expect(stdin.isTTY).toBe(true);
    } finally {
      setIsTTY(previousIsTty);
    }
  });

  test("re-install after teardown succeeds with fresh state", () => {
    const first = makePtmxFd();
    const second = makePtmxFd();

    const h1 = forwardFreshTtyToStdin({
      isTty: () => true,
      openTty: () => first.fd,
    });
    expect(h1).toBeDefined();
    closeFreshTtyForwarding();

    // Second install observes the newly-restored original methods as its
    // capture target, so the cycle completes cleanly.
    const h2 = forwardFreshTtyToStdin({
      isTty: () => true,
      openTty: () => second.fd,
    });
    expect(h2).toBeDefined();
    closeFreshTtyForwarding();
  });

  test("secondary forward call returns a no-op disposable", () => {
    const { fd } = makePtmxFd();
    const stdin = process.stdin as { isTTY?: boolean };
    const previousIsTty = stdin.isTTY;

    try {
      const h1 = forwardFreshTtyToStdin({
        isTty: () => true,
        openTty: () => fd,
      });
      expect(h1).toBeDefined();

      // Second call — already installed. Factory NOT called again.
      const secondaryFactory = vi.fn(() => {
        throw new Error("should not be invoked");
      });
      const h2 = forwardFreshTtyToStdin({
        isTty: () => true,
        openTty: secondaryFactory,
      });
      expect(h2).toBeDefined();
      expect(secondaryFactory).not.toHaveBeenCalled();

      // Disposing the secondary handle must NOT tear down the primary's
      // state. stdin methods stay patched until the PRIMARY disposable fires.
      const patchedSetRawMode = process.stdin.setRawMode;
      h2[Symbol.dispose]();
      expect(process.stdin.setRawMode).toBe(patchedSetRawMode);

      // Primary disposal now actually tears down.
      h1[Symbol.dispose]();
    } finally {
      setIsTTY(previousIsTty);
    }
  });

  test("teardown tolerates double-close of the same install", () => {
    const { fd } = makePtmxFd();

    const handle = forwardFreshTtyToStdin({
      isTty: () => true,
      openTty: () => fd,
    });
    expect(handle).toBeDefined();

    // First close tears down; second must be a no-op guarded by the
    // installedState === null check at the top of closeFreshTtyForwarding.
    closeFreshTtyForwarding();
    expect(() => closeFreshTtyForwarding()).not.toThrow();
  });

  test("teardown tolerates raw mode being set before close", () => {
    const { fd } = makePtmxFd();

    const handle = forwardFreshTtyToStdin({
      isTty: () => true,
      openTty: () => fd,
    });
    expect(handle).toBeDefined();

    // Simulate clack calling setRawMode(true) mid-prompt, then the
    // wizard throwing before clack's matching setRawMode(false) fires.
    // The patched setRawMode routes to fresh.setRawMode on the real
    // ptmx fd — exercising the ioctl path.
    process.stdin.setRawMode(true);

    // Teardown should call fresh.setRawMode(false) before destroy.
    // We can't observe the call directly without a deeper seam, but we
    // verify teardown completes without throwing even after raw mode
    // was set (covers the termios-restore try/catch).
    expect(() => closeFreshTtyForwarding()).not.toThrow();
  });

  test("teardown invokes restored pause to release stdin handle", () => {
    // Regression for CLI-1DD: post-wizard `sentry init` hang. Our no-op
    // pause patch (installed to dodge Bun's fd-0 EINVAL) silently
    // swallowed clack's `rl.close() → input.pause()` call, leaving stdin
    // ref'd. Teardown must invoke the restored original so the libuv
    // event loop can drain.
    const { fd } = makePtmxFd();

    // Replace the beforeEach stub with a counting spy BEFORE install so
    // the install captures it as `original.pause`.
    let pauseCalls = 0;
    const pauseSpy = (): NodeJS.ReadStream => {
      pauseCalls += 1;
      return process.stdin;
    };
    (process.stdin as unknown as { pause: () => NodeJS.ReadStream }).pause =
      pauseSpy;

    const handle = forwardFreshTtyToStdin({
      isTty: () => true,
      openTty: () => fd,
    });
    expect(handle).toBeDefined();

    // During install, process.stdin.pause is the patched no-op — clack's
    // internal `rl.close() → input.pause()` would hit the no-op and the
    // spy would never fire. Simulate that:
    expect(process.stdin.pause).not.toBe(pauseSpy);
    process.stdin.pause();
    expect(pauseCalls).toBe(0);

    closeFreshTtyForwarding();

    // After teardown: pause is restored to our spy AND teardown invoked
    // it exactly once to release the libuv handle.
    expect(process.stdin.pause).toBe(pauseSpy);
    expect(pauseCalls).toBe(1);
  });

  test("stdin is not flowing after teardown (releases event loop)", () => {
    // Integration regression for CLI-1DD. Observes the actual stream
    // state transition that blocks the event loop. Without the fix,
    // `readableFlowing` stays `true` post-teardown and the process hangs
    // until a keypress.
    const { fd } = makePtmxFd();

    // Route install's `original.pause` capture at the real
    // `Readable.prototype.pause`, not the beforeEach no-op stub — so
    // that invoking it actually transitions `readableFlowing: true → false`.
    // Same for `.resume()`: used below to simulate clack's implicit flow.
    const { Readable } = require("node:stream") as typeof import("node:stream");
    const stdinMut = process.stdin as unknown as {
      pause: () => NodeJS.ReadStream;
      resume: () => NodeJS.ReadStream;
    };
    stdinMut.pause = Readable.prototype.pause as () => NodeJS.ReadStream;
    stdinMut.resume = Readable.prototype.resume as () => NodeJS.ReadStream;

    // Put stdin into flowing mode. This is effectively what clack does
    // indirectly via `readline.createInterface()` → `input.resume()`.
    process.stdin.resume();

    try {
      expect(
        (process.stdin as { readableFlowing?: boolean | null }).readableFlowing
      ).toBe(true);

      const handle = forwardFreshTtyToStdin({
        isTty: () => true,
        openTty: () => fd,
      });
      expect(handle).toBeDefined();

      closeFreshTtyForwarding();

      // `readableFlowing` values: null (initial), true (flowing), false
      // (paused). After teardown we must be NOT true — otherwise the
      // libuv event loop stays alive.
      expect(
        (process.stdin as { readableFlowing?: boolean | null }).readableFlowing
      ).not.toBe(true);
    } finally {
      // Defensive: ensure we don't leak a flowing-mode stdin into the
      // next test even if an expectation above threw.
      Readable.prototype.pause.call(process.stdin);
    }
  });
});

describe("using-declaration semantics", () => {
  if (!HAS_PTMX) {
    test("skipped: /dev/ptmx unavailable on this platform", () => {
      expect(HAS_PTMX).toBe(false);
    });
    return;
  }

  test("`using` scope releases forwarding when the block exits", () => {
    const { fd } = makePtmxFd();
    const originalSetRawMode = process.stdin.setRawMode;

    {
      using tty = forwardFreshTtyToStdin({
        isTty: () => true,
        openTty: () => fd,
      });
      expect(tty).toBeDefined();
      // Inside the block, setRawMode is patched.
      expect(process.stdin.setRawMode).not.toBe(originalSetRawMode);
    }
    // Block exited → disposable fired → originals restored.
    expect(process.stdin.setRawMode).toBe(originalSetRawMode);
  });

  test("`using` teardown fires even when the block throws", () => {
    const { fd } = makePtmxFd();
    const originalSetRawMode = process.stdin.setRawMode;

    const run = (): void => {
      using tty = forwardFreshTtyToStdin({
        isTty: () => true,
        openTty: () => fd,
      });
      expect(tty).toBeDefined();
      throw new Error("boom");
    };
    expect(run).toThrow("boom");
    // Throw unwound the `using` scope → disposable fired.
    expect(process.stdin.setRawMode).toBe(originalSetRawMode);
  });
});
