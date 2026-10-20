import { expect, test, vi } from "vitest";
import { startCli } from "../../src/cli.js";
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
