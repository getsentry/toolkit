/**
 * Tests for `sentry cli completion` command.
 *
 * Verifies each supported shell prints a script, an unsupported shell errors
 * without emitting a script, and the shell is auto-detected from $SHELL.
 */

import { run } from "@stricli/core";
import { describe, expect, test } from "vitest";
import { app } from "../../../src/app.js";
import type { SentryContext } from "../../../src/context.js";

/**
 * Run the completion command via Stricli's `run()` and capture stdout.
 *
 * @param args - Args after `cli completion` (e.g. `["bash"]`)
 * @param shellEnv - Value to inject as $SHELL for auto-detection tests
 */
async function runCompletion(
  args: string[],
  shellEnv?: string
): Promise<{ output: string; exitCode: number | undefined }> {
  let output = "";
  const env = { ...process.env, SHELL: shellEnv };
  const mockContext: SentryContext = {
    process: {
      ...process,
      exitCode: undefined,
    } as typeof process,
    env,
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

  await run(app, ["cli", "completion", ...args], mockContext);
  return { output, exitCode: mockContext.process.exitCode };
}

describe("sentry cli completion", () => {
  test("bash prints a bash completion script", async () => {
    const { output, exitCode } = await runCompletion(["bash"]);
    expect(output).toContain("complete -F _sentry_completions sentry");
    expect(exitCode ?? 0).toBe(0);
  });

  test("zsh prints a zsh completion script", async () => {
    const { output, exitCode } = await runCompletion(["zsh"]);
    expect(output).toContain("#compdef sentry");
    expect(exitCode ?? 0).toBe(0);
  });

  test("fish prints a fish completion script", async () => {
    const { output, exitCode } = await runCompletion(["fish"]);
    expect(output).toContain("complete -c sentry");
    expect(exitCode ?? 0).toBe(0);
  });

  test("unsupported shell errors and prints no script", async () => {
    const { output, exitCode } = await runCompletion(["nonsense"]);
    expect(output).toBe("");
    expect(exitCode).toBeGreaterThan(0);
  });

  test("auto-detects the shell from $SHELL when no arg is given", async () => {
    const { output, exitCode } = await runCompletion([], "/bin/zsh");
    expect(output).toContain("#compdef sentry");
    expect(exitCode ?? 0).toBe(0);
  });
});
