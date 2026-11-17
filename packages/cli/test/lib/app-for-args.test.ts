import { describe, expect, test } from "vitest";
import {
  isRootHelpRequest,
  loadAppForArgs,
  routesForArgs,
} from "../../src/app-for-args.js";
import { routes } from "../../src/app.js";

describe("routesForArgs", () => {
  test.each([
    [
      ["issue", "list"],
      ["help", "issue"],
    ],
    [
      ["auth", "status", "--json"],
      ["help", "auth"],
    ],
    // The list command checks the singular route's subcommands
    [
      ["projects", "view", "cli"],
      ["help", "projects", "project"],
    ],
    [
      ["sourcemaps", "upload"],
      ["help", "sourcemaps"],
    ],
    // Global flags before the route name, with and without values
    [
      ["--verbose", "--log-level", "debug", "issue", "list"],
      ["help", "issue"],
    ],
    [
      ["--fields=id", "--no-json", "-v", "org", "list"],
      ["help", "org"],
    ],
    // A value flag missing its value doesn't take the next flag
    [
      ["--org", "--json", "auth", "status"],
      ["help", "auth"],
    ],
    // `--version` prints the version before any command runs
    [["--version"], ["help"]],
    [["--verbose", "--version"], ["help"]],
    [["--version", "--help"], ["help"]],
  ])("%j loads %j", (args, expected) => {
    expect(routesForArgs(args)).toEqual(expected);
  });

  test.each([
    [[]],
    [["--help"]],
    [["--help", "issue"]],
    [["--verbose"]],
    [["--json"]],
    // Flags the route scanner doesn't accept before the route name
    [["--unknown", "issue", "list"]],
    [["--", "issue"]],
    // An unknown name needs every route for the suggestions
    [["isue", "list"]],
    [["__proto__"]],
    // These read the whole command tree
    [["help", "issue"]],
    [["schema"]],
    [["cli", "setup"]],
  ])("%j loads the full application", (args) => {
    expect(routesForArgs(args)).toBeUndefined();
  });
});

describe("isRootHelpRequest", () => {
  const env = {};

  test.each([
    [[]],
    [["--verbose"]],
    [["--help"]],
    [["-h"]],
    [["--log-level", "debug", "--help"]],
    [["help"]],
    [["help", "--verbose"]],
    // The help command's own help
    [["help", "--help"]],
  ])("%j prints the top-level help", (args) => {
    expect(isRootHelpRequest(args, env)).toBe(true);
  });

  test.each([
    [["--version"]],
    [["--json"]],
    [["--help", "--json"]],
    [["--fields", "name"]],
    [["help", "--json"]],
    [["help", "--fields=name"]],
    [["--help", "issue"]],
    [["--helpAll"]],
    [["--", "issue"]],
    [["help", "issue"]],
    [["help", "--log-level", "debug"]],
    [["issue", "list"]],
  ])("%j does not", (args) => {
    expect(isRootHelpRequest(args, env)).toBe(false);
  });

  test("JSON output from the environment does not", () => {
    const json = { SENTRY_OUTPUT_FORMAT: "json" };
    expect(isRootHelpRequest([], json)).toBe(false);
    expect(isRootHelpRequest(["help"], json)).toBe(false);
  });
});

describe("loadAppForArgs", () => {
  test("builds the application with only the routes it needs", async () => {
    const loaded = await loadAppForArgs(["projects", "view", "cli"]);

    expect(
      loaded.routes
        .getAllEntries()
        .map((entry) => [entry.name.original, entry.hidden]),
    ).toEqual([
      ["help", false],
      ["projects", true],
      ["project", false],
    ]);
    expect(loaded.routes.getRoutingTargetForInput("project")).toBe(
      routes.getRoutingTargetForInput("project"),
    );
  });

  test("loads no command for `--version`", async () => {
    const loaded = await loadAppForArgs(["--version"]);

    expect(
      loaded.routes.getAllEntries().map((entry) => entry.name.original),
    ).toEqual(["help"]);
  });

  test("loads app.ts for the full application", async () => {
    expect((await loadAppForArgs(["--help", "--json"])).routes).toBe(routes);
  });
});
