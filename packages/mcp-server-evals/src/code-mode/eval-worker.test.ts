import path from "node:path";
import { fileURLToPath } from "node:url";
import { unstable_dev } from "wrangler";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import TOOL_DEFINITIONS from "@sentry/mcp-core/toolDefinitions";
import { createDashboardFixture } from "./dashboard-fixture";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const WORKER = path.join(
  root,
  "packages/mcp-cloudflare/src/code-mode/eval-worker.ts",
);
const CONFIG = path.join(
  root,
  "packages/mcp-server-evals/src/code-mode/wrangler.jsonc",
);
const CODE_MODE_TOOLS = ["search_sentry_api", "execute_sentry_code"];
const TOP_LEVEL_TOOL_NAMES: string[] = TOOL_DEFINITIONS.filter(
  (tool) => tool.surface === "direct" && !CODE_MODE_TOOLS.includes(tool.name),
).map((tool) => tool.name);

type Worker = Awaited<ReturnType<typeof unstable_dev>>;
let worker: Worker;
let fixture: Awaited<ReturnType<typeof createDashboardFixture>>;

async function startWorker(apiBaseUrl: string): Promise<Worker> {
  return await unstable_dev(WORKER, {
    config: CONFIG,
    ip: "127.0.0.1",
    port: 0,
    local: true,
    persist: false,
    logLevel: "error",
    vars: { API_BASE_URL: apiBaseUrl },
    experimental: {
      disableExperimentalWarning: true,
      disableDevRegistry: true,
      watch: false,
    },
  });
}

async function rpc(
  method: string,
  params: Record<string, unknown> = {},
  route = "/mcp",
) {
  const response = await worker.fetch(route, {
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
            name: "eval-worker-tests",
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

const byName = (a: string, b: string) => a.localeCompare(b);
const toolNames = (result: { tools: Array<{ name: string }> }) =>
  result.tools.map((tool) => tool.name).sort(byName);

beforeAll(async () => {
  fixture = await createDashboardFixture();
  worker = await startWorker(`${fixture.baseUrl}/api/0`);
}, 120_000);

beforeEach(() => fixture.reset());

afterAll(async () => {
  await worker?.stop();
  await fixture?.close();
});

it("grants each surface like a hosted connection", async () => {
  expect(toolNames(await rpc("tools/list"))).toEqual(
    [...TOP_LEVEL_TOOL_NAMES, ...CODE_MODE_TOOLS].sort(byName),
  );
  expect(toolNames(await rpc("tools/list", {}, "/catalog/mcp"))).toEqual(
    [...TOP_LEVEL_TOOL_NAMES].sort(byName),
  );
  // A connection that granted only API Write keeps the foundational tools.
  expect(toolNames(await rpc("tools/list", {}, "/code-mode/mcp"))).toEqual(
    expect.arrayContaining(CODE_MODE_TOOLS),
  );
  await expect(
    rpc(
      "tools/call",
      { name: "execute_sentry_code", arguments: { code: "async () => 1" } },
      "/catalog/mcp",
    ),
  ).rejects.toThrow();
});

it("serves the normal catalog next to Code Mode", async () => {
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
});

it("runs Code Mode through the hosted authorization and shipped schema", async () => {
  const discovery = await rpc("tools/call", {
    name: "search_sentry_api",
    arguments: { code: "async () => Object.keys(spec.paths).length" },
  });
  expect(discovery.isError).not.toBe(true);
  expect(discovery.structuredContent.result).toBeGreaterThan(100);

  const result = await rpc("tools/call", {
    name: "execute_sentry_code",
    arguments: {
      code: `async () => {
        const dashboard = (await sentry.request({path: "/organizations/${fixture.organizationSlug}/dashboards/101/"})).body.id;
        let unpublished;
        try { await sentry.request({path: "/organizations/${fixture.organizationSlug}/dashboards/101/widgets/"}); }
        catch (error) { unpublished = {status: error.status, detail: error.data.detail}; }
        return {dashboard, unpublished};
      }`,
    },
  });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toEqual({
    result: {
      dashboard: "101",
      unpublished: {
        status: 403,
        detail: "This API path is not available in the published API schema.",
      },
    },
    stats: { apiCalls: 2, writesAttempted: 0 },
  });
  // The refused path never reaches the fixture.
  expect(
    fixture
      .snapshot()
      .requests.filter(({ path }) => path.endsWith("/widgets/")),
  ).toEqual([]);
});

it("requires authentication on every surface", async () => {
  for (const route of ["/mcp", "/catalog/mcp", "/code-mode/mcp"]) {
    const response = await worker.fetch(route, { method: "POST" });
    expect(response.status).toBe(401);
  }
});

it("refuses non-fixture API configuration", async () => {
  const misconfigured = await startWorker("https://sentry.io/api/0");
  try {
    const response = await misconfigured.fetch("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer code-mode-eval-token" },
    });
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("loopback HTTP fixtures");
    expect(fixture.snapshot().requests).toEqual([]);
  } finally {
    await misconfigured.stop();
  }
}, 120_000);
