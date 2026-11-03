/**
 * Command synonym registry and CLI error suggestion regressions.
 *
 * Core invariants (case-insensitivity, lookup consistency) could be
 * property-tested, but the map is small and static — unit tests are
 * sufficient here. These verify each telemetry-driven pattern category.
 */

import { homedir } from "node:os";
import { run } from "@stricli/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { app, routes } from "../../src/app.js";
import { getCommandSuggestion } from "../../src/lib/command-suggestions.js";
import { isRouteMap, type RouteMap } from "../../src/lib/introspect.js";
import { useTestConfigDir } from "../helpers.js";

describe("getCommandSuggestion", () => {
  test("never treats registered commands or aliases as unknown synonyms", () => {
    for (const group of routes.getAllEntries()) {
      if (!("getAllEntries" in group.target)) {
        continue;
      }
      for (const command of group.target.getAllEntries()) {
        for (const token of [command.name.original, ...command.aliases]) {
          expect(
            getCommandSuggestion(group.name.original, token),
            `${group.name.original}/${token}`,
          ).toBeUndefined();
        }
      }
    }
  });

  // --- Pattern 2: view synonyms ---
  test("suggests issue view for 'issue/get'", () => {
    const s = getCommandSuggestion("issue", "get");
    expect(s).toBeDefined();
    expect(s!.command).toContain("issue view");
  });

  test("suggests issue view for 'issue/details'", () => {
    expect(getCommandSuggestion("issue", "details")?.command).toContain(
      "issue view",
    );
  });

  test("suggests issue view for 'issue/info'", () => {
    expect(getCommandSuggestion("issue", "info")?.command).toContain(
      "issue view",
    );
  });

  // --- Pattern 3: mutation commands ---
  test("suggests native resolve for the unambiguous close synonym", () => {
    expect(getCommandSuggestion("issue", "close")).toEqual({
      command: "sentry issue resolve <issue-id>",
    });
  });

  test.each(["update", "set-status", "assign", "comment"])(
    "keeps the API suggestion for issue %s without an exact native equivalent",
    (command) => {
      expect(getCommandSuggestion("issue", command)?.command).toMatch(
        /^sentry api /,
      );
    },
  );

  // --- Pattern 4: event list is now a real command (no longer a synonym) ---
  test("returns undefined for 'event/list' (now a real command)", () => {
    expect(getCommandSuggestion("event", "list")).toBeUndefined();
  });

  // --- Pattern 5: old sentry-cli commands ---
  test("suggests auth status for 'cli/info'", () => {
    expect(getCommandSuggestion("cli", "info")?.command).toContain(
      "auth status",
    );
  });

  test("suggests issue list for 'cli/issues'", () => {
    expect(getCommandSuggestion("cli", "issues")?.command).toContain(
      "issue list",
    );
  });

  test("suggests log list for 'cli/logs'", () => {
    expect(getCommandSuggestion("cli", "logs")?.command).toContain("log list");
  });

  test("suggests send-event for 'cli/send-event'", () => {
    expect(getCommandSuggestion("cli", "send-event")?.command).toContain(
      "sentry event send",
    );
  });

  // --- Pattern 6: dashboard synonyms ---
  test("suggests dashboard list for 'dashboard/default-overview'", () => {
    expect(
      getCommandSuggestion("dashboard", "default-overview")?.command,
    ).toContain("dashboard list");
  });

  // --- Case insensitivity ---
  test("is case-insensitive on the unknown token", () => {
    expect(getCommandSuggestion("issue", "Get")).toBeDefined();
    expect(getCommandSuggestion("issue", "CLOSE")).toBeDefined();
    expect(getCommandSuggestion("cli", "INFO")).toBeDefined();
  });

  // --- No match ---
  test("returns undefined for unrecognized token", () => {
    expect(getCommandSuggestion("issue", "foobar")).toBeUndefined();
  });

  test("returns undefined for empty route context with unknown token", () => {
    expect(getCommandSuggestion("", "foobar")).toBeUndefined();
  });

  test("returns undefined for unknown route context", () => {
    expect(getCommandSuggestion("nonexistent", "events")).toBeUndefined();
  });
});

describe("command error suggestions", () => {
  const getConfigDir = useTestConfigDir("command-suggestions-");
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  async function runIssue(args: string[]): Promise<string> {
    let stderr = "";
    process.exitCode = undefined;
    process.argv = ["node", "sentry", "issue", ...args];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
    await run(app, ["issue", ...args], {
      process,
      env: process.env,
      cwd: getConfigDir(),
      homeDir: homedir(),
      configDir: getConfigDir(),
      stdout: { write: () => true },
      stderr: process.stderr,
      stdin: process.stdin,
    });
    return stderr;
  }

  test.each(["resolve", "ignore", "events"])(
    "preserves the parse error for native issue %s",
    async (command) => {
      const output = await runIssue([command, "TEST-1", "extra"]);
      expect(output).toContain("extra");
      expect(output).not.toContain("Tip:");
    },
  );

  test.each([
    ["resolve", "--in", "@commit:", "Invalid --in spec"],
    ["ignore", "--until", "invalid", "--until"],
  ])(
    "preserves the validation error for native issue %s",
    async (command, flag, value, error) => {
      const output = await runIssue([command, "TEST-1", flag, value]);
      expect(output).toContain(error);
      expect(output).not.toContain("sentry api");
    },
  );
});

describe("routes with defaultCommand", () => {
  /** Derive the set the same way app.ts does — via introspection */
  const routesWithDefault = new Set(
    routes
      .getAllEntries()
      .filter(
        (e) =>
          isRouteMap(e.target as unknown) &&
          (e.target as unknown as RouteMap).getDefaultCommand?.(),
      )
      .map((e) => e.name.original),
  );

  test("all route groups with a view subcommand have defaultCommand set", () => {
    const expected = [
      "issue",
      "event",
      "org",
      "project",
      "dashboard",
      "trace",
      "span",
      "log",
    ];
    for (const route of expected) {
      expect(routesWithDefault.has(route)).toBe(true);
    }
  });

  test("auth route group has defaultCommand (smart default)", () => {
    expect(routesWithDefault.has("auth")).toBe(true);
    const authEntry = routes
      .getAllEntries()
      .find((e) => e.name.original === "auth");
    const authMap = authEntry?.target as unknown as RouteMap;
    const defaultCmd = authMap.getDefaultCommand?.();
    const defaultEntry = authMap
      .getAllEntries()
      .find((e) => e.target === defaultCmd);
    expect(defaultEntry?.name.original).toBe("default");
    expect(defaultEntry?.hidden).toBe(true);
  });

  test("route groups without defaultCommand", () => {
    expect(routesWithDefault.has("cli")).toBe(false);
    expect(routesWithDefault.has("sourcemap")).toBe(false);
    expect(routesWithDefault.has("repo")).toBe(false);
    expect(routesWithDefault.has("team")).toBe(false);
  });
});
