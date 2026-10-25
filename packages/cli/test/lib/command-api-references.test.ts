import { describe, expect, test } from "vitest";
import { routes } from "../../src/app.js";
import {
  type ApiReference,
  getAllEndpoints,
} from "../../src/lib/api-schema.js";
import { buildCommand } from "../../src/lib/command.js";
import {
  getCommandApiReferences,
  type RouteMap,
  validateCommandApiReferences,
} from "../../src/lib/introspect.js";
import { buildRouteMap } from "../../src/lib/route-map.js";

function command(relatedApi?: readonly ApiReference[]) {
  return buildCommand({
    docs: { brief: "Example command", relatedApi },
    auth: false,
    async *func() {
      yield;
    },
  });
}

function exampleRoutes() {
  const list = command([{ fn: "queryEvents", note: "Uses the logs dataset." }]);
  const view = command([
    { fn: "queryEvents", note: "Filters by log item ID." },
  ]);
  const log = buildRouteMap({
    routes: { list, view },
    aliases: { details: "view" },
    docs: { brief: "Logs" },
  });
  const metrics = buildRouteMap({
    routes: { list: command([{ fn: "listDetectors" }]) },
    docs: { brief: "Metric alerts" },
  });
  return buildRouteMap({
    routes: {
      log,
      logs: list,
      internal: command([{ fn: "notPublished" }]),
      alert: buildRouteMap({
        routes: { metrics },
        docs: { brief: "Alerts" },
      }),
      future: command([{ fn: "newOperation" }]),
      local: command(),
    },
    docs: { brief: "CLI", hideRoute: { logs: true, internal: true } },
  }) as unknown as RouteMap;
}

describe("command API discovery", () => {
  test("reads metadata from new public commands and full nested paths", () => {
    const tree = exampleRoutes();
    expect(getCommandApiReferences(tree, "future")).toEqual([
      { command: "sentry future", fn: "newOperation" },
    ]);
    expect(getCommandApiReferences(tree, "alert metrics list")).toEqual([
      { command: "sentry alert metrics list", fn: "listDetectors" },
    ]);
    expect(getCommandApiReferences(tree, "alert metrics")).toEqual(
      getCommandApiReferences(tree, "alert"),
    );
  });

  test("resolves registered and hidden public aliases to canonical command paths", () => {
    const tree = exampleRoutes();
    const list = getCommandApiReferences(tree, "log list");
    expect(getCommandApiReferences(tree, "log ls")).toEqual(list);
    expect(getCommandApiReferences(tree, "logs")).toEqual(list);
    expect(getCommandApiReferences(tree, "log details")).toEqual(
      getCommandApiReferences(tree, "log show"),
    );
    expect(getCommandApiReferences(tree, "log show")[0]?.command).toBe(
      "sentry log view",
    );
  });

  test("groups keep each command's context even when they share an API", () => {
    expect(getCommandApiReferences(exampleRoutes(), "log")).toEqual([
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
    ]);
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
      expect(getCommandApiReferences(tree, query)).toEqual([]);
    }
  });

  test("rejects missing and ambiguous API references as the catalog changes", () => {
    const tree = exampleRoutes();
    const endpoints = [
      { fn: "queryEvents" },
      { fn: "listDetectors" },
      { fn: "newOperation" },
    ];
    expect(() => validateCommandApiReferences(tree, endpoints)).not.toThrow();
    expect(() =>
      validateCommandApiReferences(tree, endpoints.slice(1)),
    ).toThrow(
      'sentry log list: related API "queryEvents" matches 0 schema operations',
    );
    expect(() =>
      validateCommandApiReferences(tree, [...endpoints, { fn: "queryEvents" }]),
    ).toThrow(
      'sentry log list: related API "queryEvents" matches 2 schema operations',
    );
  });

  test("published command references resolve against the bundled API catalog", () => {
    const tree = routes as unknown as RouteMap;
    expect(() =>
      validateCommandApiReferences(tree, getAllEndpoints()),
    ).not.toThrow();
    expect(getCommandApiReferences(tree, "logs")).toEqual(
      getCommandApiReferences(tree, "log list"),
    );
    expect(getCommandApiReferences(tree, "trace list")).toEqual([
      expect.objectContaining({
        fn: "listOrganizationEvents",
        note: expect.stringContaining("is_transaction:true"),
      }),
    ]);
    expect(getCommandApiReferences(tree, "log view")).toEqual([
      expect.objectContaining({
        fn: "listOrganizationEvents",
        note: expect.stringContaining("dataset=logs"),
      }),
    ]);
    expect(getCommandApiReferences(tree, "trace show")).toEqual([
      expect.objectContaining({ fn: "getOrganizationTrace" }),
    ]);
    expect(
      getCommandApiReferences(tree, "alert metrics").map((reference) => ({
        command: reference.command,
        fn: reference.fn,
      })),
    ).toEqual([
      { command: "sentry alert metrics list", fn: "listOrganizationDetectors" },
      { command: "sentry alert metrics view", fn: "getOrganizationDetector" },
      {
        command: "sentry alert metrics create",
        fn: "createOrganizationProjectDetector",
      },
      {
        command: "sentry alert metrics delete",
        fn: "deleteOrganizationDetector",
      },
      { command: "sentry alert metrics edit", fn: "getOrganizationDetector" },
      {
        command: "sentry alert metrics edit",
        fn: "updateOrganizationDetector",
      },
    ]);
  });
});
