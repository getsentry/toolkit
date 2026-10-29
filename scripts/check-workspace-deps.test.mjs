import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildGraph,
  findCycles,
  findForbiddenPaths,
} from "./check-workspace-deps.mjs";

const layered = [
  { name: "sentry", devDependencies: { "@sentry/mcp-core": "workspace:*" } },
  {
    name: "@sentry/mcp-core",
    dependencies: { "@sentry/toolkit-core": "workspace:*", zod: "^4" },
  },
  {
    name: "@sentry/mcp-cloudflare",
    dependencies: { "@sentry/mcp-core": "workspace:*" },
  },
  { name: "@sentry/toolkit-core" },
  {
    name: "@sentry/mcp-server",
    dependencies: { "@modelcontextprotocol/sdk": "catalog:" },
  },
];

describe("check-workspace-deps", () => {
  it("accepts the CLI -> mcp-core -> toolkit-core layering", () => {
    const graph = buildGraph(layered);
    assert.deepEqual(graph.get("@sentry/mcp-core"), ["@sentry/toolkit-core"]);
    assert.deepEqual(findCycles(graph), []);
    assert.deepEqual(findForbiddenPaths(graph), []);
  });

  it("reports a cycle once", () => {
    const graph = buildGraph([
      ...layered.filter(({ name }) => name !== "@sentry/mcp-core"),
      {
        name: "@sentry/mcp-core",
        dependencies: { "@sentry/toolkit-core": "workspace:*" },
        devDependencies: { sentry: "workspace:*" },
      },
    ]);
    assert.deepEqual(findCycles(graph), [
      ["@sentry/mcp-core", "sentry", "@sentry/mcp-core"],
    ]);
  });

  it("rejects mcp-core depending on the CLI, even transitively", () => {
    const graph = buildGraph([
      { name: "sentry" },
      { name: "helper", dependencies: { sentry: "workspace:*" } },
      { name: "@sentry/toolkit-core" },
      {
        name: "@sentry/mcp-core",
        dependencies: { "@sentry/toolkit-core": "workspace:*" },
        peerDependencies: { helper: "*" },
      },
    ]);
    assert.deepEqual(findForbiddenPaths(graph), [
      ["@sentry/mcp-core", "helper", "sentry"],
    ]);
  });

  it("rejects the mcp-server proxy depending on the CLI or MCP core", () => {
    const graph = buildGraph([
      ...layered.filter(({ name }) => name !== "@sentry/mcp-server"),
      { name: "@sentry/mcp-server", dependencies: { sentry: "workspace:*" } },
    ]);
    assert.deepEqual(findForbiddenPaths(graph), [
      ["@sentry/mcp-server", "sentry"],
      ["@sentry/mcp-server", "sentry", "@sentry/mcp-core"],
      [
        "@sentry/mcp-server",
        "sentry",
        "@sentry/mcp-core",
        "@sentry/toolkit-core",
      ],
    ]);
  });

  it("rejects toolkit-core depending on mcp-core", () => {
    const graph = buildGraph([
      ...layered.filter(({ name }) => name !== "@sentry/toolkit-core"),
      {
        name: "@sentry/toolkit-core",
        devDependencies: { "@sentry/mcp-core": "workspace:*" },
      },
    ]);
    assert.deepEqual(findForbiddenPaths(graph), [
      ["@sentry/toolkit-core", "@sentry/mcp-core"],
    ]);
  });
});
