import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { TOP_LEVEL_TOOL_NAMES } from "../../../mcp-core/src/tools/surfaces";
import { createDashboardFixture } from "../../../mcp-server-evals/src/code-mode/dashboard-fixture";

let outputDirectory: string;
let worker: Miniflare;
let fixture: Awaited<ReturnType<typeof createDashboardFixture>>;

async function rpc(
  method: string,
  params: Record<string, unknown> = {},
  route = "/mcp",
) {
  const response = await worker.dispatchFetch(`http://localhost${route}`, {
    method: "POST",
    headers: {
      authorization: "Bearer code-mode-eval-token",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": {
            name: "discovery-tests",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${text}`);
  const data = text.startsWith("event:")
    ? text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6)
    : text;
  const envelope = JSON.parse(data ?? "{}");
  if (envelope.error) throw new Error(JSON.stringify(envelope.error));
  return envelope.result;
}

beforeAll(async () => {
  outputDirectory = await mkdtemp(join(tmpdir(), "sentry-discovery-test-"));
  await promisify(execFile)(
    process.execPath,
    [
      resolve("node_modules/wrangler/bin/wrangler.js"),
      "deploy",
      "src/code-mode/discovery-worker.ts",
      "--dry-run",
      "--config",
      "wrangler.code-mode.jsonc",
      "--outdir",
      outputDirectory,
    ],
    {
      timeout: 60_000,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );
  fixture = await createDashboardFixture();
  worker = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      modulesRoot: outputDirectory,
      scriptPath: join(outputDirectory, "discovery-worker.js"),
      compatibilityDate: "2026-01-12",
      compatibilityFlags: ["nodejs_compat"],
      workerLoaders: { LOADER: {} },
      bindings: {
        API_BASE_URL: `${fixture.baseUrl}/api/0`,
        OPENAPI_URL: fixture.openapiUrl,
        CODE_MODE_ALLOW_WRITES: "true",
      },
    }),
  );
});

beforeEach(() => fixture.reset());

afterAll(async () => {
  await worker?.dispose();
  await fixture?.close();
  if (outputDirectory)
    await rm(outputDirectory, { recursive: true, force: true });
});

it("offers the real catalog and Code Mode together without replacing normal tools", async () => {
  const combined = await rpc("tools/list");
  const control = await rpc("tools/list", {}, "/catalog/mcp");
  expect(
    combined.tools.map((tool: { name: string }) => tool.name).sort(),
  ).toEqual(
    [
      ...TOP_LEVEL_TOOL_NAMES,
      "search_sentry_api",
      "execute_sentry_code",
    ].sort(),
  );
  expect(
    control.tools.map((tool: { name: string }) => tool.name).sort(),
  ).toEqual([...TOP_LEVEL_TOOL_NAMES].sort());
  await expect(
    rpc(
      "tools/call",
      { name: "execute_sentry_code", arguments: { code: "async () => 1" } },
      "/catalog/mcp",
    ),
  ).rejects.toThrow();

  const catalog = await rpc("tools/call", {
    name: "search_sentry_tools",
    arguments: { query: "dashboard" },
  });
  expect(catalog.isError).not.toBe(true);
  expect(
    catalog.structuredContent.results.map(
      (tool: { name: string }) => tool.name,
    ),
  ).toEqual(
    expect.arrayContaining(["get_dashboard_details", "find_dashboards"]),
  );
  expect(
    catalog.structuredContent.results.every(
      (tool: { annotations: { readOnlyHint: boolean } }) =>
        tool.annotations.readOnlyHint,
    ),
  ).toBe(true);

  const details = await rpc("tools/call", {
    name: "execute_sentry_tool",
    arguments: {
      name: "get_dashboard_details",
      arguments: {
        organizationSlug: fixture.organizationSlug,
        dashboardIdOrTitle: "101",
      },
    },
  });
  expect(details.isError).not.toBe(true);
  expect(details.content[0].text).toContain("Errors Overview");
  expect(fixture.snapshot().requests).toEqual([
    {
      method: "GET",
      path: `/api/0/organizations/${fixture.organizationSlug}/dashboards/101/`,
      status: 200,
    },
  ]);
});

it("executes the existing sandbox and broker alongside the normal catalog", async () => {
  const discovery = await rpc("tools/call", {
    name: "search_sentry_api",
    arguments: { code: "async () => Object.keys(spec.paths)" },
  });
  expect(discovery.isError).not.toBe(true);
  expect(discovery.structuredContent.result.length).toBeGreaterThan(0);
  const result = await rpc("tools/call", {
    name: "execute_sentry_code",
    arguments: {
      code: `async () => (await sentry.request({path: '/organizations/${fixture.organizationSlug}/dashboards/101/'})).body.id`,
    },
  });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toEqual({
    result: "101",
    stats: { apiCalls: 1, writesAttempted: 0 },
  });
});

it("requires authentication before exposing either eval surface", async () => {
  for (const route of ["/mcp", "/catalog/mcp"]) {
    const response = await worker.dispatchFetch(`http://localhost${route}`, {
      method: "POST",
    });
    expect(response.status).toBe(401);
  }
});

it("refuses non-fixture API configuration", async () => {
  const misconfigured = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      modulesRoot: outputDirectory,
      scriptPath: join(outputDirectory, "discovery-worker.js"),
      compatibilityDate: "2026-01-12",
      compatibilityFlags: ["nodejs_compat"],
      workerLoaders: { LOADER: {} },
      bindings: {
        API_BASE_URL: "https://sentry.io/api/0",
        OPENAPI_URL: fixture.openapiUrl,
      },
    }),
  );
  try {
    const response = await misconfigured.dispatchFetch("http://localhost/mcp", {
      method: "POST",
      headers: { authorization: "Bearer code-mode-eval-token" },
    });
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("loopback HTTP fixtures");
    expect(fixture.snapshot().requests).toEqual([]);
  } finally {
    await misconfigured.dispose();
  }
});
