/**
 * Unit Tests for Route Tree Introspection
 *
 * Tests the shared introspection module used by `sentry help --json`
 * and `script/generate-skill.ts`.
 */

import { describe, expect, test } from "vitest";
import {
  CHOICE_TARGET,
  type CompletionTarget,
  choiceParser,
  DASHBOARD_TARGET,
  FILE_TARGET,
  ISSUE_QUERY_TARGET,
  ISSUE_TARGET,
  ORG_PROJECT_TARGET,
  ORG_TARGET,
  parseFilePath,
  withCompletionTarget,
} from "../../src/lib/completion-target.js";
import type {
  Command,
  FlagDef,
  RouteMap,
  RouteMapEntry,
} from "../../src/lib/introspect.js";
import {
  buildCommandInfo,
  extractAllRoutes,
  extractCommandCompletions,
  extractFlags,
  extractPositionals,
  extractRouteGroupCommands,
  extractRouteGroups,
  getPositionalString,
  isCommand,
  isRouteMap,
  resolveCommandPath,
} from "../../src/lib/introspect.js";
import { sanitizeIssueQuery } from "../../src/lib/search-query.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeCommand(overrides: Partial<Command> = {}): Command {
  return {
    brief: "Test command",
    parameters: {
      flags: {},
      aliases: {},
    },
    ...overrides,
  };
}

function makeRouteMap(
  entries: RouteMapEntry[],
  overrides: Partial<RouteMap> = {},
): RouteMap {
  return {
    brief: "Test route",
    getAllEntries: () => entries,
    ...overrides,
  };
}

function makeEntry(
  name: string,
  target: RouteMap | Command,
  hidden = false,
): RouteMapEntry {
  return {
    name: { original: name },
    target,
    hidden,
  };
}

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

describe("isRouteMap", () => {
  test("returns true for route maps", () => {
    const routeMap = makeRouteMap([]);
    expect(isRouteMap(routeMap)).toBe(true);
  });

  test("returns false for commands", () => {
    const cmd = makeCommand();
    expect(isRouteMap(cmd)).toBe(false);
  });
});

describe("isCommand", () => {
  test("returns true for commands", () => {
    const cmd = makeCommand();
    expect(isCommand(cmd)).toBe(true);
  });

  test("returns false for route maps", () => {
    const routeMap = makeRouteMap([]);
    expect(isCommand(routeMap)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getPositionalString
// ---------------------------------------------------------------------------

describe("getPositionalString", () => {
  test("returns empty string for undefined", () => {
    expect(getPositionalString(undefined)).toBe("");
  });

  test("returns tuple placeholders", () => {
    const result = getPositionalString({
      kind: "tuple",
      parameters: [{ placeholder: "org" }, { placeholder: "project" }],
    });
    expect(result).toBe("<org> <project>");
  });

  test("uses default arg names for tuple without placeholders", () => {
    const result = getPositionalString({
      kind: "tuple",
      parameters: [{}, {}],
    });
    expect(result).toBe("<arg0> <arg1>");
  });

  test("distinguishes optional tuple arguments from required ones", () => {
    expect(
      getPositionalString({
        kind: "tuple",
        parameters: [
          { placeholder: "target" },
          { placeholder: "org", optional: true },
        ],
      }),
    ).toBe("<target> [<org>]");
  });

  test("returns array placeholder with ellipsis", () => {
    const result = getPositionalString({
      kind: "array",
      parameter: { placeholder: "command" },
    });
    expect(result).toBe("<command...>");
  });

  test("uses default for array without placeholder", () => {
    const result = getPositionalString({
      kind: "array",
      parameter: {},
    });
    expect(result).toBe("<args...>");
  });
});

describe("extractPositionals", () => {
  test("keeps arrays required and variadic even when the parser accepts zero", () => {
    expect(
      extractPositionals({
        kind: "array",
        parameter: { placeholder: "issue" },
      }),
    ).toEqual([
      { placeholder: "issue", brief: "", optional: false, variadic: true },
    ]);
  });
  test("preserves optional tuple arguments", () => {
    expect(
      extractPositionals({
        kind: "tuple",
        parameters: [{ placeholder: "org", optional: true }],
      }),
    ).toEqual([
      { placeholder: "org", brief: "", optional: true, variadic: false },
    ]);
  });
});

// ---------------------------------------------------------------------------
// extractFlags
// ---------------------------------------------------------------------------

describe("extractFlags", () => {
  test("returns empty array for undefined", () => {
    expect(extractFlags(undefined)).toEqual([]);
  });

  test("extracts boolean flag with defaults", () => {
    const flags: Record<string, FlagDef> = {
      json: { kind: "boolean", brief: "Output JSON", default: false },
    };
    const result = extractFlags(flags);
    expect(result).toEqual([
      {
        name: "json",
        brief: "Output JSON",
        kind: "boolean",
        default: false,
        optional: true,
        variadic: false,
        hidden: false,
      },
    ]);
  });

  test("extracts parsed flag", () => {
    const flags: Record<string, FlagDef> = {
      limit: {
        kind: "parsed",
        brief: "Max items",
        default: 25,
        optional: false,
      },
    };
    const result = extractFlags(flags);
    expect(result).toEqual([
      {
        name: "limit",
        brief: "Max items",
        kind: "parsed",
        default: 25,
        optional: false,
        variadic: false,
        hidden: false,
      },
    ]);
  });

  test("extracts hidden flag", () => {
    const flags: Record<string, FlagDef> = {
      verbose: { kind: "boolean", hidden: true },
    };
    const result = extractFlags(flags);
    expect(result[0].hidden).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildCommandInfo
// ---------------------------------------------------------------------------

describe("buildCommandInfo", () => {
  test("builds info with all fields", () => {
    const cmd = makeCommand({
      brief: "List things",
      fullDescription: "List all the things.",
      __examples: [
        {
          description: "List things in an org",
          command: "sentry thing list myorg",
        },
      ],
      parameters: {
        positional: {
          kind: "tuple",
          parameters: [{ placeholder: "target" }],
        },
        flags: {
          limit: {
            kind: "parsed",
            brief: "Max items",
            default: 10,
          },
        },
        aliases: { l: "limit" },
      },
    });

    const info = buildCommandInfo(cmd, "sentry thing list");
    expect(info.path).toBe("sentry thing list");
    expect(info.brief).toBe("List things");
    expect(info.fullDescription).toBe("List all the things.");
    expect(info.positional).toBe("<target>");
    expect(info.flags).toHaveLength(1);
    expect(info.flags[0].name).toBe("limit");
    expect(info.aliases).toEqual({ l: "limit" });
    expect(info.examples).toEqual([
      "# List things in an org\nsentry thing list myorg",
    ]);
  });

  test("renders multi-step workflow examples one step per line", () => {
    const cmd = makeCommand({
      brief: "Create things",
      __examples: [
        {
          description: "Create, then finalize",
          command: ["sentry thing create a", "sentry thing finalize a"],
        },
      ],
    });
    const info = buildCommandInfo(cmd, "sentry thing create");
    expect(info.examples).toEqual([
      "# Create, then finalize\nsentry thing create a\nsentry thing finalize a",
    ]);
  });

  test("handles command with no positional args", () => {
    const cmd = makeCommand({ brief: "Do something" });
    const info = buildCommandInfo(cmd, "sentry do");
    expect(info.positional).toBe("");
  });

  test("prefers a public positional syntax override", () => {
    const cmd = makeCommand({
      __primaryUsage: "<name>:<kind>...",
      parameters: {
        positional: {
          kind: "array",
          parameter: { placeholder: "name:kind" },
        },
      },
    });

    const info = buildCommandInfo(cmd, "sentry project create");
    expect(info.positional).toBe("<name>:<kind>...");
    expect(info.positionals[0]).toMatchObject({
      placeholder: "name:kind",
      optional: false,
      variadic: true,
      syntax: "<name>:<kind>...",
    });
  });
});

// ---------------------------------------------------------------------------
// extractRouteGroupCommands
// ---------------------------------------------------------------------------

describe("extractRouteGroupCommands", () => {
  test("extracts visible subcommands", () => {
    const listCmd = makeCommand({ brief: "List items" });
    const viewCmd = makeCommand({ brief: "View item" });
    const hiddenCmd = makeCommand({ brief: "Hidden" });

    const routeMap = makeRouteMap([
      makeEntry("list", listCmd),
      makeEntry("view", viewCmd),
      makeEntry("secret", hiddenCmd, true),
    ]);

    const commands = extractRouteGroupCommands(routeMap, "thing");
    expect(commands).toHaveLength(2);
    expect(commands[0].path).toBe("sentry thing list");
    expect(commands[1].path).toBe("sentry thing view");
  });

  test("skips route map entries (only extracts commands)", () => {
    const nestedMap = makeRouteMap([]);
    const cmd = makeCommand({ brief: "A command" });

    const routeMap = makeRouteMap([
      makeEntry("nested", nestedMap),
      makeEntry("cmd", cmd),
    ]);

    const commands = extractRouteGroupCommands(routeMap, "parent");
    expect(commands).toHaveLength(1);
    expect(commands[0].path).toBe("sentry parent cmd");
  });
});

// ---------------------------------------------------------------------------
// extractAllRoutes
// ---------------------------------------------------------------------------

describe("extractAllRoutes", () => {
  test("extracts route groups and standalone commands", () => {
    const listCmd = makeCommand({ brief: "List items" });
    const viewCmd = makeCommand({ brief: "View item" });
    const apiCmd = makeCommand({ brief: "Make API calls" });

    const issueRoute = makeRouteMap(
      [makeEntry("list", listCmd), makeEntry("view", viewCmd)],
      { brief: "Manage issues" },
    );

    const topLevel = makeRouteMap([
      makeEntry("issue", issueRoute),
      makeEntry("api", apiCmd),
    ]);

    const routes = extractAllRoutes(topLevel);
    expect(routes).toHaveLength(2);

    // Route group
    expect(routes[0].name).toBe("issue");
    expect(routes[0].brief).toBe("Manage issues");
    expect(routes[0].commands).toHaveLength(2);

    // Standalone command
    expect(routes[1].name).toBe("api");
    expect(routes[1].commands).toHaveLength(1);
    expect(routes[1].commands[0].path).toBe("sentry api");
  });

  test("skips hidden entries", () => {
    const cmd = makeCommand({ brief: "Visible" });
    const hidden = makeCommand({ brief: "Hidden" });

    const topLevel = makeRouteMap([
      makeEntry("visible", cmd),
      makeEntry("hidden", hidden, true),
    ]);

    const routes = extractAllRoutes(topLevel);
    expect(routes).toHaveLength(1);
    expect(routes[0].name).toBe("visible");
  });
});

describe("extractCommandCompletions", () => {
  /** A fresh parser tagged with `kind`, as the bound parsers are. */
  const tagged = (kind: CompletionTarget) =>
    withCompletionTarget(kind, (input: string) => input);
  const orgParser = tagged(ORG_TARGET);
  const orgProjectParser = tagged(ORG_PROJECT_TARGET);
  const issueParser = tagged(ISSUE_TARGET);

  /** Command whose positionals use the given parsers. */
  function commandWith(...parsers: unknown[]): Command {
    return makeCommand({
      parameters: {
        positional: {
          kind: "tuple",
          parameters: parsers.map((parse, i) => ({
            placeholder: `arg${i}`,
            parse,
          })),
        },
      },
    });
  }

  test("reads the kind of each positional with full nested paths", () => {
    const variadic = makeCommand({
      parameters: {
        positional: {
          kind: "array",
          parameter: { placeholder: "issue", parse: issueParser },
        },
      },
    });
    const nested = makeRouteMap([
      makeEntry("view", commandWith(orgProjectParser)),
    ]);
    const topLevel = makeRouteMap([
      makeEntry(
        "issue",
        makeRouteMap([
          makeEntry("merge", variadic),
          makeEntry("link", commandWith(issueParser, String)),
          makeEntry("help", commandWith(String)),
          makeEntry("rules", nested),
        ]),
      ),
      makeEntry("trial", commandWith(String, orgParser)),
      makeEntry("api", makeCommand()),
    ]);

    expect(extractCommandCompletions(topLevel)).toEqual({
      "issue link": {
        positionals: [ISSUE_TARGET, null],
        variadic: false,
        flags: {},
      },
      "issue merge": { positionals: [ISSUE_TARGET], variadic: true, flags: {} },
      "issue rules view": {
        positionals: [ORG_PROJECT_TARGET],
        variadic: false,
        flags: {},
      },
      trial: { positionals: [null, ORG_TARGET], variadic: false, flags: {} },
    });
  });

  test("reads flag value kinds, listing other value-taking flags as null", () => {
    const list = makeCommand({
      parameters: {
        positional: {
          kind: "tuple",
          parameters: [
            {
              placeholder: "target",
              parse: tagged(DASHBOARD_TARGET),
            },
          ],
        },
        flags: {
          web: { kind: "boolean" },
          period: { kind: "parsed" },
          query: { kind: "parsed", parse: sanitizeIssueQuery },
        },
        aliases: { w: "web", t: "period", q: "query" },
      },
    });
    const flagOnly = makeCommand({
      parameters: {
        flags: { query: { kind: "parsed", parse: sanitizeIssueQuery } },
      },
    });
    const topLevel = makeRouteMap([
      makeEntry("list", list),
      makeEntry("search", flagOnly),
    ]);

    expect(extractCommandCompletions(topLevel)).toEqual({
      list: {
        positionals: [DASHBOARD_TARGET],
        variadic: false,
        flags: {
          "--period": null,
          "--query": ISSUE_QUERY_TARGET,
          "-q": ISSUE_QUERY_TARGET,
          "-t": null,
        },
        flagNames: {
          "--period": { brief: "", aliases: ["-t"] },
          "--query": { brief: "", aliases: ["-q"] },
          "--web": { brief: "", aliases: ["-w"] },
        },
      },
      search: {
        positionals: [],
        variadic: false,
        flags: { "--query": ISSUE_QUERY_TARGET },
        flagNames: { "--query": { brief: "" } },
      },
    });
  });

  test("lists every visible flag's name, brief, aliases, and repeatability", () => {
    const create = makeCommand({
      parameters: {
        flags: {
          json: { kind: "boolean", brief: "Output as JSON" },
          tag: { kind: "parsed", brief: "A tag", variadic: true },
          debug: { kind: "boolean", brief: "Internal", hidden: true },
        },
        aliases: { t: "tag", d: "debug" },
      },
    });

    expect(
      extractCommandCompletions(makeRouteMap([makeEntry("create", create)]))
        .create?.flagNames,
    ).toEqual({
      "--json": { brief: "Output as JSON" },
      "--tag": { brief: "A tag", aliases: ["-t"], variadic: true },
    });
  });

  test("skips hidden commands, hidden groups, and commands with nothing to complete", () => {
    const annotated = commandWith(orgParser);
    const hiddenGroup = makeRouteMap([makeEntry("list", annotated)]);
    const topLevel = makeRouteMap([
      makeEntry("secret", annotated, true),
      makeEntry("internal", hiddenGroup, true),
      makeEntry(
        "plain",
        makeCommand({
          parameters: { flags: { period: { kind: "parsed", hidden: true } } },
        }),
      ),
    ]);

    expect(extractCommandCompletions(topLevel)).toEqual({});
  });

  test("lists the values of choice positionals and enum flags", () => {
    const shell = makeCommand({
      parameters: {
        positional: {
          kind: "tuple",
          parameters: [
            { placeholder: "shell", parse: choiceParser(["bash", "zsh"]) },
            { placeholder: "out", parse: parseFilePath },
          ],
        },
        flags: {
          format: { kind: "enum", values: ["json", "text"] },
          mode: { kind: "parsed", parse: choiceParser(["fast"]) },
        },
        aliases: { f: "format" },
      },
    });

    expect(
      extractCommandCompletions(makeRouteMap([makeEntry("shell", shell)])),
    ).toEqual({
      shell: {
        positionals: [CHOICE_TARGET, FILE_TARGET],
        variadic: false,
        flags: {
          "--format": CHOICE_TARGET,
          "--mode": CHOICE_TARGET,
          "-f": CHOICE_TARGET,
        },
        choices: {
          "--format": ["json", "text"],
          "--mode": ["fast"],
          "-f": ["json", "text"],
          "0": ["bash", "zsh"],
        },
        flagNames: {
          "--format": { brief: "", aliases: ["-f"] },
          "--mode": { brief: "" },
        },
      },
    });
  });
});

describe("extractRouteGroups", () => {
  test("lists the visible subcommands of every group, nested ones included", () => {
    const topLevel = makeRouteMap([
      makeEntry(
        "alert",
        makeRouteMap(
          [
            makeEntry(
              "issues",
              makeRouteMap([
                makeEntry("list", makeCommand({ brief: "List rules" })),
                makeEntry("secret", makeCommand(), true),
              ]),
            ),
          ],
          { brief: "Manage alerts" },
        ),
      ),
      makeEntry("api", makeCommand({ brief: "Call the API" })),
      makeEntry("internal", makeRouteMap([]), true),
    ]);

    expect(extractRouteGroups(topLevel)).toEqual({
      "": { alert: "Manage alerts", api: "Call the API" },
      alert: { issues: "Test route" },
      "alert issues": { list: "List rules" },
    });
  });
});

// ---------------------------------------------------------------------------
// resolveCommandPath
// ---------------------------------------------------------------------------

describe("resolveCommandPath", () => {
  const listCmd = makeCommand({ brief: "List items" });
  const viewCmd = makeCommand({ brief: "View item" });
  const apiCmd = makeCommand({ brief: "API calls" });

  const issueRoute = makeRouteMap(
    [makeEntry("list", listCmd), makeEntry("view", viewCmd)],
    { brief: "Manage issues" },
  );

  const topLevel = makeRouteMap([
    makeEntry("issue", issueRoute),
    makeEntry("api", apiCmd),
  ]);

  test("returns null for empty path", () => {
    expect(resolveCommandPath(topLevel, [])).toBeNull();
  });

  test("returns unresolved for unknown top-level entry", () => {
    const result = resolveCommandPath(topLevel, ["nonexistent"]);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("unresolved");
    if (result?.kind === "unresolved") {
      expect(result.input).toBe("nonexistent");
    }
  });

  test("resolves route group", () => {
    const result = resolveCommandPath(topLevel, ["issue"]);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("group");
    if (result!.kind === "group") {
      expect(result!.info.name).toBe("issue");
      expect(result!.info.commands).toHaveLength(2);
    }
  });

  test("resolves standalone command", () => {
    const result = resolveCommandPath(topLevel, ["api"]);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("command");
    if (result!.kind === "command") {
      expect(result!.info.path).toBe("sentry api");
    }
  });

  test("resolves subcommand in group", () => {
    const result = resolveCommandPath(topLevel, ["issue", "list"]);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("command");
    if (result!.kind === "command") {
      expect(result!.info.path).toBe("sentry issue list");
      expect(result!.info.brief).toBe("List items");
    }
  });

  test("returns unresolved for unknown subcommand", () => {
    const result = resolveCommandPath(topLevel, ["issue", "unknown"]);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("unresolved");
    if (result?.kind === "unresolved") {
      expect(result.input).toBe("unknown");
    }
  });

  test("returns null when navigating deeper into standalone command", () => {
    expect(resolveCommandPath(topLevel, ["api", "something"])).toBeNull();
  });

  test("returns null for extra path segments beyond 2 levels", () => {
    expect(resolveCommandPath(topLevel, ["issue", "list", "extra"])).toBeNull();
    expect(
      resolveCommandPath(topLevel, ["issue", "list", "extra", "more"]),
    ).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Fuzzy suggestions
  // -------------------------------------------------------------------------

  test("suggests close top-level match for typo", () => {
    const result = resolveCommandPath(topLevel, ["issu"]);
    expect(result?.kind).toBe("unresolved");
    if (result?.kind === "unresolved") {
      expect(result.suggestions).toContain("issue");
    }
  });

  test("suggests close subcommand match for typo", () => {
    const result = resolveCommandPath(topLevel, ["issue", "lis"]);
    expect(result?.kind).toBe("unresolved");
    if (result?.kind === "unresolved") {
      expect(result.suggestions).toContain("list");
    }
  });

  test("returns empty suggestions for completely unrelated input", () => {
    const result = resolveCommandPath(topLevel, ["xyzfoo123"]);
    expect(result?.kind).toBe("unresolved");
    if (result?.kind === "unresolved") {
      expect(result.suggestions).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: real route tree
// ---------------------------------------------------------------------------

describe("integration: real CLI route tree", () => {
  test("extractAllRoutes returns entries for the actual CLI", async () => {
    // Dynamic import to avoid circular deps in test setup
    const { routes } = await import("../../src/app.js");
    type IntrospectRouteMap = import("../../src/lib/introspect.js").RouteMap;
    const routeMap = routes as unknown as IntrospectRouteMap;

    const allRoutes = extractAllRoutes(routeMap);

    // Should have multiple route entries
    expect(allRoutes.length).toBeGreaterThan(5);

    // Known routes should exist
    const routeNames = allRoutes.map((r) => r.name);
    expect(routeNames).toContain("help");
    expect(routeNames).toContain("auth");
    expect(routeNames).toContain("issue");
    expect(routeNames).toContain("api");
  });

  test("resolveCommandPath finds 'issue list' in the actual CLI", async () => {
    const { routes } = await import("../../src/app.js");
    type IntrospectRouteMap = import("../../src/lib/introspect.js").RouteMap;
    const routeMap = routes as unknown as IntrospectRouteMap;

    const result = resolveCommandPath(routeMap, ["issue", "list"]);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("command");
    if (result!.kind === "command") {
      expect(result!.info.path).toBe("sentry issue list");
      expect(result!.info.flags.length).toBeGreaterThan(0);
    }
  });

  test("resolveCommandPath finds 'issue' group in the actual CLI", async () => {
    const { routes } = await import("../../src/app.js");
    type IntrospectRouteMap = import("../../src/lib/introspect.js").RouteMap;
    const routeMap = routes as unknown as IntrospectRouteMap;

    const result = resolveCommandPath(routeMap, ["issue"]);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("group");
    if (result!.kind === "group") {
      expect(result!.info.commands.length).toBeGreaterThan(0);
      const cmdNames = result!.info.commands.map((c) => c.path);
      expect(cmdNames).toContain("sentry issue list");
    }
  });
});
