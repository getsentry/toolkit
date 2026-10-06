/**
 * Tests for help-as-positional-arg error recovery in buildCommand.
 *
 * When a command throws a CliError and a positional arg was `"help"`,
 * the buildCommand wrapper recovers by showing the command's help
 * instead of the confusing error.
 *
 * This only fires as error recovery — if a command successfully resolves
 * a legitimate value like a project named "help", the recovery never runs.
 *
 * Tests run commands through Stricli's `run()` with `help` as a positional
 * and verify help output is shown when resolution fails.
 */

import { generateHelpTextForAllCommands, run } from "@stricli/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { app } from "../../src/app.js";
import type { SentryContext } from "../../src/context.js";
import { mockFetch, useTestConfigDir } from "../helpers.js";

useTestConfigDir("help-positional-");

// Silence unmocked fetch calls from the resolution cascade.
// Commands run through run(app, args) with "help" as a positional arg
// trigger real resolution (e.g., findProjectsBySlug("help") → listOrganizations)
// before the help-recovery error handler fires. A silent 404 prevents
// preload warnings while preserving the error → recovery behavior.
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch(
    async () =>
      new Response(JSON.stringify({ detail: "Not found" }), { status: 404 })
  );
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Captured output from a command run */
type CapturedOutput = {
  stdout: string;
  stderr: string;
};

/**
 * Build a mock context with forCommand support.
 *
 * Stricli calls `forCommand({ prefix })` before running the command.
 * We must provide it so `commandPrefix` is set on the context, enabling
 * the help recovery logic in `buildCommand`.
 */
function buildMockContext(captured: {
  stdout: string;
  stderr: string;
}): SentryContext & {
  forCommand: (opts: { prefix: readonly string[] }) => SentryContext;
} {
  const stdoutWriter = {
    write(data: string | Uint8Array) {
      captured.stdout +=
        typeof data === "string" ? data : new TextDecoder().decode(data);
      return true;
    },
  };
  const stderrWriter = {
    write(data: string | Uint8Array) {
      captured.stderr +=
        typeof data === "string" ? data : new TextDecoder().decode(data);
      return true;
    },
  };

  const baseContext: SentryContext = {
    process,
    env: process.env,
    cwd: process.cwd(),
    homeDir: "/tmp",
    configDir: "/tmp",
    stdout: stdoutWriter,
    stderr: stderrWriter,
    stdin: process.stdin,
  };

  return {
    ...baseContext,
    forCommand: ({ prefix }: { prefix: readonly string[] }): SentryContext => ({
      ...baseContext,
      commandPrefix: prefix,
    }),
  };
}

/**
 * Run a command through Stricli and capture stdout/stderr.
 *
 * Commands that hit resolution errors with "help" as a positional arg
 * will be recovered by the buildCommand wrapper, which shows help output
 * instead of the error.
 */
async function runCommand(args: string[]): Promise<CapturedOutput> {
  const captured = { stdout: "", stderr: "" };
  const mockContext = buildMockContext(captured);

  try {
    await run(app, args, mockContext);
  } catch {
    // Some commands may still throw (e.g., uncaught errors)
  }

  return captured;
}

describe("help recovery on ResolutionError", () => {
  test("sentry issue list help → shows help for issue list", async () => {
    // "help" is treated as a project slug, fails resolution → recovery shows help
    const { stdout, stderr } = await runCommand(["issue", "list", "help"]);

    expect(stdout).toContain("sentry issue list");
    expect(stderr).toContain("--help");
    expect(stderr).toContain("Tip");
  });

  test("sentry project list help → shows help for project list", async () => {
    const { stdout, stderr } = await runCommand(["project", "list", "help"]);

    expect(stdout).toContain("sentry project list");
    expect(stderr).toContain("--help");
  });

  test("sentry span list help → shows help for span list", async () => {
    const { stdout, stderr } = await runCommand(["span", "list", "help"]);

    expect(stdout).toContain("sentry span list");
    expect(stderr).toContain("--help");
  });

  test("stderr hint includes the correct command path", async () => {
    const { stderr } = await runCommand(["issue", "list", "help"]);

    expect(stderr).toContain("sentry issue list --help");
  });
});

describe("help recovery on ValidationError", () => {
  test("sentry trace view help → shows help for trace view", async () => {
    // "help" fails hex ID validation → ValidationError → recovery shows help
    const { stdout, stderr } = await runCommand(["trace", "view", "help"]);

    expect(stdout).toContain("sentry trace view");
    expect(stderr).toContain("--help");
  });

  test("sentry log view help → shows help for log view", async () => {
    const { stdout, stderr } = await runCommand(["log", "view", "help"]);

    expect(stdout).toContain("sentry log view");
    expect(stderr).toContain("--help");
  });
});

describe("help command unchanged", () => {
  test("sentry help still shows branded help", async () => {
    const { stdout, stderr } = await runCommand(["help"]);

    // Custom help command shows branded output — no recovery needed
    expect(stdout).toContain("sentry");
    // Should NOT have the recovery tip
    expect(stderr).not.toContain("Tip");
  });

  test("sentry help issue list still shows introspected help", async () => {
    const { stdout, stderr } = await runCommand(["help", "issue", "list"]);

    expect(stdout).toContain("sentry issue list");
    // Should NOT have the recovery tip — this is the normal help path
    expect(stderr).not.toContain("Tip");
  });

  test("sentry help project create shows the public positional syntax", async () => {
    const { stdout, stderr } = await runCommand(["help", "project", "create"]);

    expect(stdout).toContain(
      "sentry project create [<org>/]<name>:<platform>..."
    );
    expect(stderr).not.toContain("Tip");
  });

  test("project create --help shows the required paired syntax", () => {
    const help = generateHelpTextForAllCommands(app).find(
      ([route]) => route === "sentry project create"
    )?.[1];

    expect(help).toContain(
      "sentry project create [<org>/]<name>:<platform>..."
    );
    expect(help).not.toContain("--platform");
    expect(help).not.toContain("<name-or-platform>");
    expect(help).toContain("cannot contain whitespace");
  });
});

describe("project create parser contract", () => {
  test.each([
    "--platform",
    "-p",
  ])("rejects the removed %s flag", async (flag) => {
    const captured = { stdout: "", stderr: "" };
    const mockContext = buildMockContext(captured);
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    try {
      await run(
        app,
        ["project", "create", "my-app:node", flag, "javascript"],
        mockContext
      );

      const errorOutput = stderrWrite.mock.calls
        .map(([data]) => String(data))
        .join("");
      expect(errorOutput).toContain(flag);
      expect(errorOutput).toMatch(/No (flag|alias) registered/);
    } finally {
      stderrWrite.mockRestore();
    }
  });
});
