/**
 * Unit Tests for Route Tree Introspection
 *
 * Tests the shared introspection module used by `sentry help --json`
 * and `script/generate-skill.ts`.
 */

import { describe, expect, test } from "vitest";
import type {
  Command,
  FlagDef,
  RouteMap,
  RouteMapEntry,
} from "../../src/lib/introspect.js";
import {
  buildCommandInfo,
  extractAllRoutes,
  extractFlags,
  extractRouteGroupCommands,
  getPositionalString,
  isCommand,
  isRouteMap,
  resolveCommandPath,
} from "../../src/lib/introspect.js";

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
  overrides: Partial<RouteMap> = {}
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
  hidden = false
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

    const info = buildCommandInfo(cmd, "sentry thing list", [
      "sentry thing list myorg",
    ]);
    expect(info.path).toBe("sentry thing list");
    expect(info.brief).toBe("List things");
    expect(info.fullDescription).toBe("List all the things.");
    expect(info.positional).toBe("<target>");
    expect(info.flags).toHaveLength(1);
    expect(info.flags[0].name).toBe("limit");
    expect(info.aliases).toEqual({ l: "limit" });
    expect(info.examples).toEqual(["sentry thing list myorg"]);
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
      { brief: "Manage issues" }
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

// ---------------------------------------------------------------------------
// resolveCommandPath
// ---------------------------------------------------------------------------

describe("resolveCommandPath", () => {
  const listCmd = makeCommand({ brief: "List items" });
  const viewCmd = makeCommand({ brief: "View item" });
  const apiCmd = makeCommand({ brief: "API calls" });

  const issueRoute = makeRouteMap(
    [makeEntry("list", listCmd), makeEntry("view", viewCmd)],
    { brief: "Manage issues" }
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
      resolveCommandPath(topLevel, ["issue", "list", "extra", "more"])
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
