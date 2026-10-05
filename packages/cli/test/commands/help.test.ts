/**
 * Tests for the Help Command
 *
 * Tests `sentry help --json` output for full tree, specific groups,
 * specific commands, and not-found cases.
 */

import { run } from "@stricli/core";
import { describe, expect, test } from "vitest";
import { app } from "../../src/app.js";
import type { SentryContext } from "../../src/context.js";

/**
 * Run a help command and capture stdout output.
 */
async function runHelp(args: string[]): Promise<string> {
  let output = "";
  const mockContext: SentryContext = {
    process,
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

  await run(app, ["help", ...args], mockContext);
  return output;
}

describe("sentry help --json", () => {
  test("outputs full route tree as JSON", async () => {
    const output = await runHelp(["--json"]);
    const parsed = JSON.parse(output);

    expect(parsed).toHaveProperty("routes");
    expect(Array.isArray(parsed.routes)).toBe(true);
    expect(parsed.routes.length).toBeGreaterThan(0);

    // Check structure of first route
    const firstRoute = parsed.routes[0];
    expect(firstRoute).toHaveProperty("name");
    expect(firstRoute).toHaveProperty("brief");
    expect(firstRoute).toHaveProperty("commands");
  });

  test("full tree contains known routes", async () => {
    const output = await runHelp(["--json"]);
    const parsed = JSON.parse(output);

    const routeNames = parsed.routes.map((r: { name: string }) => r.name);
    expect(routeNames).toContain("help");
    expect(routeNames).toContain("auth");
    expect(routeNames).toContain("issue");
    expect(routeNames).toContain("api");
  });

  test("all flags are visible including framework-injected ones", async () => {
    const output = await runHelp(["--json"]);
    const parsed = JSON.parse(output);

    // Find a command that should have framework-injected flags
    const issueRoute = parsed.routes.find(
      (r: { name: string }) => r.name === "issue"
    );
    expect(issueRoute).toBeDefined();

    const listCmd = issueRoute.commands.find(
      (c: { path: string }) => c.path === "sentry issue list"
    );
    expect(listCmd).toBeDefined();

    const flagNames = listCmd.flags.map((f: { name: string }) => f.name);
    // Framework-injected flags should be visible
    expect(flagNames).toContain("log-level");
    expect(flagNames).toContain("verbose");
  });
});

describe("sentry help --json <group>", () => {
  test("outputs route group metadata", async () => {
    const output = await runHelp(["--json", "issue"]);
    const parsed = JSON.parse(output);

    expect(parsed).toHaveProperty("name", "issue");
    expect(parsed).toHaveProperty("brief");
    expect(parsed).toHaveProperty("commands");
    expect(Array.isArray(parsed.commands)).toBe(true);
    expect(parsed.commands.length).toBeGreaterThan(0);
  });

  test("group commands have correct paths", async () => {
    const output = await runHelp(["--json", "issue"]);
    const parsed = JSON.parse(output);

    for (const cmd of parsed.commands) {
      expect(cmd.path).toMatch(/^sentry issue /);
    }
  });
});

describe("sentry help --json <group> <command>", () => {
  test("outputs specific command metadata", async () => {
    const output = await runHelp(["--json", "issue", "list"]);
    const parsed = JSON.parse(output);

    expect(parsed).toHaveProperty("path", "sentry issue list");
    expect(parsed).toHaveProperty("brief");
    expect(parsed).toHaveProperty("flags");
    expect(parsed).toHaveProperty("positional");
    expect(parsed).toHaveProperty("aliases");
    expect(Array.isArray(parsed.flags)).toBe(true);
  });

  test("command flags include expected entries", async () => {
    const output = await runHelp(["--json", "issue", "list"]);
    const parsed = JSON.parse(output);

    const flagNames = parsed.flags.map((f: { name: string }) => f.name);
    // issue list should have common flags
    expect(flagNames).toContain("json");
    expect(flagNames).toContain("limit");
  });

  test("standalone command resolves correctly", async () => {
    const output = await runHelp(["--json", "api"]);
    const parsed = JSON.parse(output);

    expect(parsed).toHaveProperty("path", "sentry api");
    expect(parsed).toHaveProperty("flags");
  });

  test("event view documents attachment download URLs", async () => {
    const output = await runHelp(["--json", "event", "view"]);
    const parsed = JSON.parse(output);
    const attachments = parsed.jsonFields?.find(
      (field: { name: string }) => field.name === "attachments"
    );

    expect(attachments).toMatchObject({
      type: "array",
      description:
        "Event attachments; each includes metadata and an absolute authenticated download URL",
    });
  });
});

describe("sentry help --json nested routes (dashboard widget)", () => {
  test("nested group has correct name and commands", async () => {
    const output = await runHelp(["--json", "dashboard", "widget"]);
    const parsed = JSON.parse(output);

    expect(parsed).toHaveProperty("name", "dashboard widget");
    expect(parsed).toHaveProperty("commands");
    const paths = parsed.commands.map((c: { path: string }) => c.path);
    expect(paths).toContain("sentry dashboard widget add");
    expect(paths).toContain("sentry dashboard widget edit");
    expect(paths).toContain("sentry dashboard widget delete");
  });

  test("nested command resolves with full path", async () => {
    const output = await runHelp(["--json", "dashboard", "widget", "add"]);
    const parsed = JSON.parse(output);

    expect(parsed).toHaveProperty("path", "sentry dashboard widget add");
    expect(parsed).toHaveProperty("flags");
  });
});

describe("introspectCommand error cases", () => {
  // Error cases throw OutputError (which calls process.exit) through the
  // framework, so we test the introspection functions directly here.
  // The exit behavior is covered by the OutputError framework tests.
  test("unknown command returns error object", async () => {
    const { introspectCommand } = await import("../../src/lib/help.js");
    const result = introspectCommand(["nonexistent"]);
    expect(result).toHaveProperty("error");
    if ("error" in result) {
      expect(result.error).toContain("nonexistent");
    }
  });

  test("unknown subcommand returns error object", async () => {
    const { introspectCommand } = await import("../../src/lib/help.js");
    const result = introspectCommand(["issue", "nonexistent"]);
    expect(result).toHaveProperty("error");
    if ("error" in result) {
      expect(result.error).toContain("issue nonexistent");
    }
  });

  test("extra path segments return error object", async () => {
    const { introspectCommand } = await import("../../src/lib/help.js");
    const result = introspectCommand(["issue", "list", "extra"]);
    expect(result).toHaveProperty("error");
  });
});

describe("introspectCommand fuzzy suggestions", () => {
  test("top-level typo includes suggestions", async () => {
    const { introspectCommand } = await import("../../src/lib/help.js");
    const result = introspectCommand(["isseu"]);
    expect(result).toHaveProperty("error");
    if ("error" in result) {
      expect(result.error).toContain("isseu");
      expect(result.suggestions).toContain("issue");
    }
  });

  test("subcommand typo includes suggestions", async () => {
    const { introspectCommand } = await import("../../src/lib/help.js");
    const result = introspectCommand(["issue", "lis"]);
    expect(result).toHaveProperty("error");
    if ("error" in result) {
      expect(result.suggestions).toContain("list");
    }
  });

  test("completely unrelated input has no suggestions", async () => {
    const { introspectCommand } = await import("../../src/lib/help.js");
    const result = introspectCommand(["xyzfoo123456"]);
    expect(result).toHaveProperty("error");
    if ("error" in result) {
      expect(result.suggestions).toBeUndefined();
    }
  });
});

describe("formatHelpHuman with suggestions", () => {
  test("renders 'Did you mean' with single suggestion", async () => {
    const { formatHelpHuman } = await import("../../src/lib/help.js");
    const output = formatHelpHuman({
      error: "Command not found: isseu",
      suggestions: ["issue"],
    });
    expect(output).toContain("Did you mean: issue?");
  });

  test("renders 'Did you mean' with multiple suggestions", async () => {
    const { formatHelpHuman } = await import("../../src/lib/help.js");
    const output = formatHelpHuman({
      error: "Command not found: trc",
      suggestions: ["trace", "trial"],
    });
    expect(output).toContain("Did you mean: trace or trial?");
  });

  test("renders three suggestions with Oxford comma", async () => {
    const { formatHelpHuman } = await import("../../src/lib/help.js");
    const output = formatHelpHuman({
      error: "Command not found: x",
      suggestions: ["alpha", "beta", "gamma"],
    });
    expect(output).toContain("Did you mean: alpha, beta, or gamma?");
  });

  test("no 'Did you mean' when suggestions are absent", async () => {
    const { formatHelpHuman } = await import("../../src/lib/help.js");
    const output = formatHelpHuman({ error: "Command not found: xyz123" });
    expect(output).not.toContain("Did you mean");
  });
});
