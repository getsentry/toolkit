/**
 * Tests for getUIAsync() — verifies the runtime-detection rules pick
 * the right WizardUI implementation.
 *
 * The factory's selection logic depends on five signals:
 *   - `SENTRY_INIT_TUI` env var
 *   - `--yes` flag (passed in via opts)
 *   - `--no-tui` (mapped to `forceLegacy`)
 *   - stdin/stdout TTY state
 *   - whether the runtime is the Bun-compiled binary (Ink is
 *     gated to Bun because its top-level-await usage doesn't
 *     bundle into our CJS npm distribution).
 *
 * We patch the env and `process.stdin.isTTY` / `process.stdout.isTTY`
 * around each test so the assertions are deterministic. To keep tests
 * fast and TTY-independent we use the `forceLegacy` / non-TTY / `--yes`
 * paths to assert `LoggingUI` is returned without ever spinning up a
 * real renderer.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  getUIAsync,
  isInteractiveTerminal,
} from "../../../../src/lib/init/ui/factory.js";
import { LoggingUI } from "../../../../src/lib/init/ui/logging-ui.js";

/**
 * Snapshot of the process state we mutate per test. Restored in
 * afterEach so the test runner's own TTY/env is left untouched.
 */
type TerminalSnapshot = {
  stdinTTY: boolean | undefined;
  stdoutTTY: boolean | undefined;
  envValue: string | undefined;
};

const ENV_KEY = "SENTRY_INIT_TUI";

function snapshot(): TerminalSnapshot {
  return {
    stdinTTY: process.stdin.isTTY,
    stdoutTTY: process.stdout.isTTY,
    envValue: process.env[ENV_KEY],
  };
}

function restore(snap: TerminalSnapshot): void {
  // Direct property writes match how Node exposes these flags.
  (process.stdin as { isTTY: boolean | undefined }).isTTY = snap.stdinTTY;
  (process.stdout as { isTTY: boolean | undefined }).isTTY = snap.stdoutTTY;
  if (snap.envValue === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = snap.envValue;
  }
}

let saved: TerminalSnapshot;

beforeEach(() => {
  saved = snapshot();
  delete process.env[ENV_KEY];
});

afterEach(() => {
  restore(saved);
});

describe("isInteractiveTerminal", () => {
  test("returns true when both stdin and stdout are TTYs", () => {
    (process.stdin as { isTTY: boolean }).isTTY = true;
    (process.stdout as { isTTY: boolean }).isTTY = true;
    expect(isInteractiveTerminal()).toBe(true);
  });

  test("returns false when stdin is not a TTY", () => {
    (process.stdin as { isTTY: boolean }).isTTY = false;
    (process.stdout as { isTTY: boolean }).isTTY = true;
    expect(isInteractiveTerminal()).toBe(false);
  });

  test("returns false when stdout is not a TTY", () => {
    (process.stdin as { isTTY: boolean }).isTTY = true;
    (process.stdout as { isTTY: boolean }).isTTY = false;
    expect(isInteractiveTerminal()).toBe(false);
  });
});

describe("getUIAsync selection", () => {
  test("returns LoggingUI when --yes is set, even on a TTY", async () => {
    (process.stdin as { isTTY: boolean }).isTTY = true;
    (process.stdout as { isTTY: boolean }).isTTY = true;
    const ui = await getUIAsync({ yes: true });
    expect(ui).toBeInstanceOf(LoggingUI);
  });

  test("returns LoggingUI when stdin is not a TTY", async () => {
    (process.stdin as { isTTY: boolean }).isTTY = false;
    (process.stdout as { isTTY: boolean }).isTTY = true;
    const ui = await getUIAsync({ yes: false });
    expect(ui).toBeInstanceOf(LoggingUI);
  });

  test("returns LoggingUI when stdout is not a TTY", async () => {
    (process.stdin as { isTTY: boolean }).isTTY = true;
    (process.stdout as { isTTY: boolean }).isTTY = false;
    const ui = await getUIAsync({ yes: false });
    expect(ui).toBeInstanceOf(LoggingUI);
  });

  test("returns LoggingUI when SENTRY_INIT_TUI=0 even on interactive TTY", async () => {
    (process.stdin as { isTTY: boolean }).isTTY = true;
    (process.stdout as { isTTY: boolean }).isTTY = true;
    process.env[ENV_KEY] = "0";
    const ui = await getUIAsync({ yes: false });
    expect(ui).toBeInstanceOf(LoggingUI);
  });

  test("returns LoggingUI when forceLegacy is set on interactive TTY", async () => {
    (process.stdin as { isTTY: boolean }).isTTY = true;
    (process.stdout as { isTTY: boolean }).isTTY = true;
    const ui = await getUIAsync({ yes: false, forceLegacy: true });
    expect(ui).toBeInstanceOf(LoggingUI);
  });

  test("forceLegacy preserves the LoggingUI choice in non-interactive contexts too", async () => {
    (process.stdin as { isTTY: boolean }).isTTY = false;
    (process.stdout as { isTTY: boolean }).isTTY = false;
    const ui = await getUIAsync({ yes: false, forceLegacy: true });
    expect(ui).toBeInstanceOf(LoggingUI);
  });
});
