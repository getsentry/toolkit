// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn
import * as Sentry from "@sentry/node";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runCli } from "../../src/cli.js";
import { SENTRY_CLI } from "../../src/sentry-cli.js";
import { useTestConfigDir } from "../helpers.js";

useTestConfigDir("unknown-command-telemetry-");

const SECRET = "abcd12efg0";
const originalExitCode = process.exitCode;

let setContextSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  setContextSpy = vi.spyOn(Sentry, "setContext");
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
});

describe("unknown_command telemetry: sensitive flag values are redacted", () => {
  test.each([
    {
      label: "--flag VALUE form",
      argv: ["alert", "--token", SECRET],
    },
    {
      label: "--flag=VALUE form",
      argv: ["alert", `--token=${SECRET}`],
    },
  ])("$label does not leak the token", async ({ argv }) => {
    await runCli(argv, SENTRY_CLI);

    const unknownCommandCall = setContextSpy.mock.calls.find(
      ([name]) => name === "unknown_command",
    );
    expect(unknownCommandCall).toBeDefined();

    const serialized = JSON.stringify(unknownCommandCall);
    expect(serialized).not.toContain(SECRET);
  });
});
