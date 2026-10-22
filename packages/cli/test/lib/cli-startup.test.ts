import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { startCli } from "../../src/cli.js";
import { resetAllowFailure } from "../../src/lib/allow-failure.js";
import { EXIT } from "../../src/lib/errors.js";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- spy on the startup dependency
import * as upgrade from "../../src/lib/upgrade.js";
import { useTestConfigDir } from "../helpers.js";

useTestConfigDir("cli-startup-");

test("fatal errors preserve their name while redacting credentials", async () => {
  const argv = process.argv;
  const exitCode = process.exitCode;
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  const cleanup = vi
    .spyOn(upgrade, "startCleanupOldBinary")
    .mockImplementation(() => {
      throw new TypeError(
        'Headers.set: "Bearer SYNTHETIC_PREFIX\nSYNTHETIC_SECRET" is an invalid header value.',
      );
    });

  try {
    process.argv = ["node", "sentry", "--help"];
    await startCli();

    expect(cleanup).toHaveBeenCalledOnce();
    expect(stderr).toHaveBeenLastCalledWith(
      'Fatal: TypeError: Headers.set: "Bearer [REDACTED]" is an invalid header value.\n',
    );
    expect(process.exitCode).toBe(1);
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
    vi.restoreAllMocks();
  }
});

describe("allow-failure", () => {
  const savedArgv = process.argv;
  const savedExitCode = process.exitCode;
  const savedEnv = process.env.SENTRY_ALLOW_FAILURE;

  beforeEach(() => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    delete process.env.SENTRY_ALLOW_FAILURE;
    resetAllowFailure();
  });

  afterEach(() => {
    process.argv = savedArgv;
    process.exitCode = savedExitCode;
    if (savedEnv === undefined) {
      delete process.env.SENTRY_ALLOW_FAILURE;
    } else {
      process.env.SENTRY_ALLOW_FAILURE = savedEnv;
    }
    resetAllowFailure();
    vi.restoreAllMocks();
  });

  async function runWithArgs(...args: string[]): Promise<number> {
    process.argv = ["node", "sentry", ...args];
    process.exitCode = undefined;
    await startCli();
    return Number(process.exitCode ?? 0);
  }

  test("failing commands keep their exit code by default", async () => {
    expect(await runWithArgs("trace", "view", "not-a-trace-id")).toBe(
      EXIT.RESOLUTION,
    );
  });

  test("--allow-failure after the command exits 0 and keeps the error", async () => {
    expect(
      await runWithArgs("trace", "view", "not-a-trace-id", "--allow-failure"),
    ).toBe(0);
    const stderr = vi
      .mocked(process.stderr.write)
      .mock.calls.map(([chunk]) => String(chunk))
      .join("");
    expect(stderr).toContain("Error:");
  });

  test("--allow-failure before the command exits 0", async () => {
    expect(
      await runWithArgs("--allow-failure", "trace", "view", "not-a-trace-id"),
    ).toBe(0);
  });

  test("SENTRY_ALLOW_FAILURE also covers flag parse errors", async () => {
    process.env.SENTRY_ALLOW_FAILURE = "1";
    expect(
      await runWithArgs("trace", "view", "not-a-trace-id", "--no-such-flag"),
    ).toBe(0);
  });

  test("falsy SENTRY_ALLOW_FAILURE keeps the exit code", async () => {
    process.env.SENTRY_ALLOW_FAILURE = "0";
    expect(await runWithArgs("trace", "view", "not-a-trace-id")).toBe(
      EXIT.RESOLUTION,
    );
  });
});
