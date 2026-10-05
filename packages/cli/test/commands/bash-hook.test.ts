/**
 * Tests for `sentry bash-hook` command.
 *
 * Tests the script output mode (template substitution) and the shellQuote helper.
 * The --send-event mode is tested indirectly via traceback.test.ts.
 */

import { run } from "@stricli/core";
import { describe, expect, test } from "vitest";
import { app } from "../../src/app.js";
import type { SentryContext } from "../../src/context.js";
import { shellQuote } from "../../src/lib/utils.js";
import { useTestConfigDir } from "../helpers.js";

useTestConfigDir("bash-hook-");

/**
 * Run bash-hook command and capture stdout.
 */
async function runBashHook(
  args: string[]
): Promise<{ output: string; exitCode: number }> {
  let output = "";
  const mockContext: SentryContext = {
    process: {
      ...process,
      exitCode: undefined,
    } as typeof process,
    env: process.env,
    cwd: process.cwd(),
    homeDir: "/tmp",
    configDir: "/tmp",
    stdout: {
      write(data: string | Uint8Array) {
        output +=
          typeof data === "string" ? data : new TextDecoder().decode(data);
        return true;
      },
    },
    stderr: {
      write() {
        return true;
      },
    },
    stdin: process.stdin,
  };

  await run(app, ["bash-hook", ...args], mockContext);
  return { output, exitCode: mockContext.process.exitCode ?? 0 };
}

describe("shellQuote", () => {
  test("wraps simple string in single quotes", () => {
    expect(shellQuote("hello")).toBe("'hello'");
  });

  test("escapes embedded single quotes", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  test("handles empty string", () => {
    expect(shellQuote("")).toBe("''");
  });

  test("handles special characters safely", () => {
    expect(shellQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'");
    expect(shellQuote("hello; world")).toBe("'hello; world'");
    expect(shellQuote('a"b')).toBe("'a\"b'");
  });

  test("handles multiple single quotes", () => {
    expect(shellQuote("it's a 'test'")).toBe("'it'\\''s a '\\''test'\\'''");
  });
});

describe("bashHookCommand (script output mode)", () => {
  test("generates script with set -e by default", async () => {
    const { output } = await runBashHook([]);
    expect(output).toContain("set -e");
    expect(output).toContain("_sentry_exit_trap");
    expect(output).toContain("_sentry_err_trap");
    expect(output).toContain("_sentry_traceback");
  });

  test("omits set -e when --no-exit is passed", async () => {
    const { output } = await runBashHook(["--no-exit"]);
    expect(output).not.toMatch(/^set -e/);
    expect(output).toContain("_sentry_err_trap");
  });

  test("substitutes CLI path placeholder", async () => {
    const { output } = await runBashHook(["--cli", "/usr/local/bin/sentry"]);
    expect(output).toContain("'/usr/local/bin/sentry'");
    expect(output).not.toContain("___SENTRY_CLI___");
  });

  test("substitutes tag placeholders", async () => {
    const { output } = await runBashHook([
      "--tag",
      "env:prod",
      "--tag",
      "tier:backend",
    ]);
    expect(output).toContain("--tag 'env:prod'");
    expect(output).toContain("--tag 'tier:backend'");
    expect(output).not.toContain("___SENTRY_TAGS___");
  });

  test("substitutes release placeholder", async () => {
    const { output } = await runBashHook(["--release", "1.0.0"]);
    expect(output).toContain("--release '1.0.0'");
    expect(output).not.toContain("___SENTRY_RELEASE___");
  });

  test("generates unique temp file paths per invocation", async () => {
    const { output: out1 } = await runBashHook([]);
    const { output: out2 } = await runBashHook([]);
    // Scripts should contain different UUIDs for temp files
    expect(out1).not.toBe(out2);
  });

  test("no placeholders remain in output", async () => {
    const { output } = await runBashHook([]);
    expect(output).not.toContain("___SENTRY_");
  });

  test("accepts --no-environ without error", async () => {
    const { output } = await runBashHook(["--no-environ"]);
    expect(output).toContain("_sentry_err_trap");
  });

  test("accepts --allow-xcode-infoplist-preprocessing without error", async () => {
    const { output } = await runBashHook([
      "--allow-xcode-infoplist-preprocessing",
    ]);
    expect(output).toContain("_sentry_err_trap");
  });

  test("handles dollar signs in tag values safely", async () => {
    const { output } = await runBashHook(["--tag", "key:val$'inject"]);
    // The value should be properly shell-quoted, not corrupted by JS $' pattern
    expect(output).toContain("--tag 'key:val$'\\''inject'");
    expect(output).not.toContain("___SENTRY_");
  });

  test("exports SENTRY_DSN when --dsn is provided", async () => {
    const { output } = await runBashHook([
      "--dsn",
      "https://key@o1.ingest.sentry.io/1",
    ]);
    expect(output).toContain(
      "export SENTRY_DSN='https://key@o1.ingest.sentry.io/1'"
    );
  });
});

describe("bashHookCommand (send-event validation)", () => {
  test("--send-event without --traceback fails", async () => {
    const { exitCode, output } = await runBashHook([
      "--send-event",
      "--log",
      "/tmp/test.log",
    ]);
    expect(exitCode).not.toBe(0);
    expect(output).toBe("");
  });

  test("--send-event without --log fails", async () => {
    const { exitCode, output } = await runBashHook([
      "--send-event",
      "--traceback",
      "/tmp/test.traceback",
    ]);
    expect(exitCode).not.toBe(0);
    expect(output).toBe("");
  });
});
