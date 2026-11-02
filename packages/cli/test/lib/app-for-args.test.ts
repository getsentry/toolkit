import { describe, expect, test } from "vitest";
import { loadAppForArgs, routesForArgs } from "../../src/app-for-args.js";
import { routes } from "../../src/app.js";
import { ROUTE_LOADERS } from "../../src/generated/route-loaders.js";

describe("ROUTE_LOADERS", () => {
  test("loads every top-level route of app.ts, in its order", async () => {
    const entries = routes.getAllEntries();
    expect(Object.keys(ROUTE_LOADERS)).toEqual(
      entries.map((entry) => entry.name.original),
    );
    for (const entry of entries) {
      expect(await ROUTE_LOADERS[entry.name.original]!()).toBe(entry.target);
    }
  });
});

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
  ])("%j loads %j", (args, expected) => {
    expect(routesForArgs(args)).toEqual(expected);
  });

  test.each([
    [[]],
    [["--help"]],
    [["--version", "--help"]],
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
    expect((await loadAppForArgs(["--help"])).routes).toBe(routes);
  });
});
