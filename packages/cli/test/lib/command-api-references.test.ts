import { describe, expect, test } from "vitest";
import { routes } from "../../src/app.js";
import type { ApiReference } from "../../src/lib/api-schema.js";
import { buildCommand } from "../../src/lib/command.js";
import {
  getCommandApiReferences,
  type RouteMap,
} from "../../src/lib/introspect.js";
import { buildRouteMap } from "../../src/lib/route-map.js";

function command() {
  return buildCommand({
    docs: { brief: "Example command" },
    auth: false,
    async *func() {
      yield;
    },
  });
}

const exampleApi: Readonly<Record<string, readonly ApiReference[]>> = {
  "sentry log list": [{ fn: "queryEvents", note: "Uses the logs dataset." }],
  "sentry log view": [{ fn: "queryEvents", note: "Filters by log item ID." }],
  "sentry monitor cron list": [{ fn: "listMonitors" }],
  "sentry future": [{ fn: "newOperation" }],
  "sentry internal": [{ fn: "notPublished" }],
};

function exampleRoutes() {
  const list = command();
  const log = buildRouteMap({
    routes: { list, view: command() },
    aliases: { details: "view" },
    docs: { brief: "Logs" },
  });
  const cron = buildRouteMap({
    routes: { list: command() },
    docs: { brief: "Cron monitors" },
  });
  return buildRouteMap({
    routes: {
      log,
      logs: list,
      internal: command(),
      monitor: buildRouteMap({
        routes: { cron },
        docs: { brief: "Monitors" },
      }),
      future: command(),
      local: command(),
    },
    docs: { brief: "CLI", hideRoute: { logs: true, internal: true } },
  }) as unknown as RouteMap;
}

describe("command API discovery", () => {
  test("reads generated references for new public commands and nested paths", () => {
    const tree = exampleRoutes();
    expect(getCommandApiReferences(tree, "future", exampleApi)).toEqual([
      { command: "sentry future", fn: "newOperation" },
    ]);
    expect(
      getCommandApiReferences(tree, "monitor cron list", exampleApi),
    ).toEqual([{ command: "sentry monitor cron list", fn: "listMonitors" }]);
    expect(getCommandApiReferences(tree, "monitor cron", exampleApi)).toEqual(
      getCommandApiReferences(tree, "monitor", exampleApi),
    );
  });

  test("resolves registered and hidden public aliases to canonical command paths", () => {
    const tree = exampleRoutes();
    const list = getCommandApiReferences(tree, "log list", exampleApi);
    expect(getCommandApiReferences(tree, "log ls", exampleApi)).toEqual(list);
    expect(getCommandApiReferences(tree, "logs", exampleApi)).toEqual(list);
    expect(getCommandApiReferences(tree, "log details", exampleApi)).toEqual(
      getCommandApiReferences(tree, "log show", exampleApi),
    );
    expect(
      getCommandApiReferences(tree, "log show", exampleApi)[0]?.command,
    ).toBe("sentry log view");
  });

  test("groups keep each command's context even when they share an API", () => {
    expect(getCommandApiReferences(exampleRoutes(), "log", exampleApi)).toEqual(
      [
        {
          command: "sentry log list",
          fn: "queryEvents",
          note: "Uses the logs dataset.",
        },
        {
          command: "sentry log view",
          fn: "queryEvents",
          note: "Filters by log item ID.",
        },
      ],
    );
  });

  test("does not expose internal commands or discard unmatched path segments", () => {
    const tree = exampleRoutes();
    for (const query of [
      "internal",
      "unknown",
      "log view extra",
      "local",
      "",
    ]) {
      expect(getCommandApiReferences(tree, query, exampleApi)).toEqual([]);
    }
  });

  test("published command references include their direct and transitive API calls", () => {
    const tree = routes as unknown as RouteMap;
    // Inspecting the route tree must not inherit commands' execution bodies.
    expect(getCommandApiReferences(tree, "help")).toEqual([]);
    expect(getCommandApiReferences(tree, "logs")).toEqual(
      getCommandApiReferences(tree, "log list"),
    );
    expect(getCommandApiReferences(tree, "trace list")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fn: "listOrganizationEvents",
          note: expect.stringContaining("is_transaction:true"),
        }),
      ]),
    );
    expect(getCommandApiReferences(tree, "log view")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fn: "listOrganizationEvents",
          note: expect.stringContaining("dataset=logs"),
        }),
      ]),
    );
    expect(getCommandApiReferences(tree, "trace show")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fn: "getOrganizationTrace" }),
      ]),
    );
  });
});
