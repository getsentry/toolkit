/**
 * Sensitive flag values (run code, tokens) must not reach Sentry through the
 * unknown_command telemetry event.
 *
 * reportUnknownCommand() derives unknown_token and argv from raw argv before
 * redacting, which lets a value like a run code survive as an unresolved path
 * segment or as the trailing argv token.
 */

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
      argv: ["onboarding", "--run-code", SECRET, "--stage", "connect_agent"],
    },
    {
      label: "--flag=VALUE form",
      argv: ["onboarding", `--run-code=${SECRET}`],
    },
  ])("$label does not leak the run code", async ({ argv }) => {
    await runCli(argv, SENTRY_CLI);

    const unknownCommandCall = setContextSpy.mock.calls.find(
      ([name]) => name === "unknown_command",
    );
    expect(unknownCommandCall).toBeDefined();

    const serialized = JSON.stringify(unknownCommandCall);
    expect(serialized).not.toContain(SECRET);
  });
});
