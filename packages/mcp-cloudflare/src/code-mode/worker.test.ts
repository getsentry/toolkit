import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_MCP_TOOL_INPUT_ELEMENTS } from "../../../mcp-core/src/constants";

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: {
    result?: unknown;
    error?: string;
    httpError?: {
      status: number;
      method: string;
      path: string;
      headers: Record<string, string>;
    };
    stats: { apiCalls: number; writesAttempted: number };
  };
  isError?: boolean;
}

const requests: Array<{ method: string; path: string; auth?: string }> = [];
const specRequests: string[] = [];
const acceptedWrites: string[] = [];
let slowWriteResponse: ServerResponse | undefined;
let slowWriteClosed = false;
const workflowPath =
  "/api/0/organizations/{organization_id_or_slug}/workflows/{workflow_id}/";
const releasePath = "/api/0/organizations/{organization_id_or_slug}/releases/";
const metadataSpec = {
  openapi: "3.0.0",
  paths: {
    [workflowPath]: {
      put: { summary: "Update an Alert by ID", tags: ["workflows"] },
    },
    "/api/0/detectors/": {
      get: { operationId: "listAlertDetectors", tags: ["workflows"] },
    },
    "/api/0/notifications/": {
      get: { description: "Retrieve alert notification history." },
    },
    "/api/0/rules/": { get: { tags: ["Alerts"] } },
    "/api/0/alerts/": {
      summary: "Alert operations",
      parameters: [{ name: "cursor", in: "query", schema: { type: "string" } }],
      get: {},
    },
    [releasePath]: {
      parameters: [
        {
          name: "organization_id_or_slug",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
        { name: "cursor", in: "query", schema: { type: "string" } },
      ],
      post: {
        description: "Create a release for the organization.",
        parameters: [
          { name: "cursor", in: "query", schema: { type: "integer" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["version", "projects"],
                properties: {
                  version: { type: "string" },
                  projects: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  },
};
let fixture: Server;
let origin: string;
let outputDirectory: string;
let worker: Miniflare;

async function createWorker(allowWrites = true, specPath = "/spec.json") {
  return new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      modulesRoot: outputDirectory,
      scriptPath: join(outputDirectory, "worker.js"),
      compatibilityDate: "2026-01-12",
      compatibilityFlags: ["nodejs_compat"],
      workerLoaders: { LOADER: {} },
      bindings: {
        API_BASE_URL: `${origin}/api/0`,
        OPENAPI_URL: `${origin}${specPath}`,
        CODE_MODE_ALLOW_WRITES: String(allowWrites),
      },
    }),
  );
}

async function rpc<T>(
  method: string,
  params: Record<string, unknown>,
  target = worker,
): Promise<T> {
  const response = await target.dispatchFetch("http://localhost/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer fixture-only-token",
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
            name: "code-mode-tests",
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

async function callTool(
  name: "search_sentry_api" | "execute_sentry_code",
  code: string,
  target = worker,
): Promise<ToolResult> {
  return await rpc("tools/call", { name, arguments: { code } }, target);
}

async function publishedExample(
  name: "Discovery" | "Categories" | "Schema",
  target: Miniflare,
): Promise<string> {
  const { tools } = await rpc<{
    tools: Array<{ name: string; description: string }>;
  }>("tools/list", {}, target);
  const description = tools.find(
    (tool) => tool.name === "search_sentry_api",
  )?.description;
  const example = description
    ?.split(`${name} example: `)[1]
    ?.split(/\n(?:Discovery|Categories|Schema) example: /)[0]
    ?.trim();
  if (!example) throw new Error(`${name} example missing from tools/list`);
  return example;
}

beforeAll(async () => {
  outputDirectory = await mkdtemp(join(tmpdir(), "sentry-code-mode-test-"));
  await promisify(execFile)(
    process.execPath,
    [
      resolve("node_modules/wrangler/bin/wrangler.js"),
      "deploy",
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
  fixture = createServer((request, response) => {
    if (
      request.url === "/metadata-spec.json" ||
      request.url === "/metadata-spec-categories.json"
    ) {
      specRequests.push(request.url);
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          ...metadataSpec,
          ...(request.url === "/metadata-spec-categories.json"
            ? {
                tags: [
                  {
                    name: "workflows",
                    description: "Manage alert workflows.",
                    "x-sidebar-name": "Alerts",
                  },
                ],
              }
            : {}),
        }),
      );
      return;
    }
    if (request.url === "/spec.json") {
      specRequests.push(request.url);
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          openapi: "3.0.0",
          servers: [{ url: origin }],
          paths: { "/api/0/items/": { get: { summary: "List items" } } },
        }),
      );
      return;
    }
    requests.push({
      method: request.method ?? "GET",
      path: request.url ?? "",
      auth: request.headers.authorization,
    });
    if (request.url === "/api/0/slow-write/") {
      acceptedWrites.push("accepted-write");
      slowWriteResponse = response;
      response.once("close", () => {
        slowWriteClosed = true;
      });
      response.writeHead(201, { "Content-Type": "application/json" });
      response.write('{"id":"accepted-write",');
      return;
    }
    if (request.url === "/api/0/redirect/") {
      response.writeHead(302, { Location: `${origin}/outside-api` });
      response.end();
      return;
    }
    if (request.url === "/api/0/failure/") {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ title: ["This field is required."] }));
      return;
    }
    if (
      request.url === "/api/0/insufficient-scope/" ||
      request.url === "/api/0/forbidden/"
    ) {
      response.writeHead(403, {
        "Content-Type": "application/json",
        "Set-Cookie": "private-session=not-for-sandbox",
        ...(request.url === "/api/0/insufficient-scope/"
          ? {
              "WWW-Authenticate":
                'Bearer error="insufficient_scope", scope="org:admin org:write"',
            }
          : {}),
      });
      response.end(
        JSON.stringify({
          detail: "You do not have permission to perform this action.",
        }),
      );
      return;
    }
    response.writeHead(request.method === "POST" ? 201 : 200, {
      "Content-Type": "application/json",
      Link: '</api/0/items/?cursor=next>; rel="next"; results="true"',
      "Set-Cookie": "private-session=not-for-sandbox",
    });
    response.end(
      JSON.stringify({ id: String(requests.length), name: "Fixture item" }),
    );
  });
  await new Promise<void>((resolveReady) =>
    fixture.listen(0, "127.0.0.1", resolveReady),
  );
  const address = fixture.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture did not bind a port.");
  origin = `http://127.0.0.1:${address.port}`;
  worker = await createWorker();
});

beforeEach(() => {
  requests.length = 0;
  specRequests.length = 0;
  acceptedWrites.length = 0;
  slowWriteResponse = undefined;
  slowWriteClosed = false;
});

afterAll(async () => {
  await worker?.dispose();
  if (fixture)
    await new Promise<void>((resolveClosed) =>
      fixture.close(() => resolveClosed()),
    );
  if (outputDirectory)
    await rm(outputDirectory, { recursive: true, force: true });
});

describe("HTTP Code Mode through real Dynamic Workers", () => {
  it("aborts a stalled response body at the real deadline without rolling back an accepted write", async () => {
    const started = performance.now();
    try {
      const result = await callTool(
        "execute_sentry_code",
        'async () => sentry.request({method: "POST", path: "/slow-write/", body: {name: "Fixture item"}})',
      );
      expect(performance.now() - started).toBeGreaterThanOrEqual(29_000);
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("Execution deadline exceeded");
      expect(result.content[0]?.text).toContain(
        "writes may already have completed",
      );
      await expect.poll(() => slowWriteClosed, { timeout: 2_000 }).toBe(true);
      expect(acceptedWrites).toEqual(["accepted-write"]);
      expect(requests).toEqual([
        {
          method: "POST",
          path: "/api/0/slow-write/",
          auth: "Bearer fixture-only-token",
        },
      ]);
    } finally {
      slowWriteResponse?.destroy();
    }
  }, 45_000);

  it("bounds nested tool arguments before starting a Dynamic Worker", async () => {
    const result = await rpc<ToolResult>("tools/call", {
      name: "execute_sentry_code",
      arguments: {
        code: 'async () => sentry.request({path: "/items/"})',
        unused: { values: Array(MAX_MCP_TOOL_INPUT_ELEMENTS + 1).fill(null) },
      },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      `maximum of ${MAX_MCP_TOOL_INPUT_ELEMENTS} elements`,
    );
    expect(requests).toEqual([]);
  });

  it("requires an explicit direct API bearer token", async () => {
    const response = await worker.dispatchFetch("http://localhost/mcp", {
      method: "POST",
    });
    expect(response.status).toBe(401);
    expect(requests).toEqual([]);
  });
  it("discovers the configured OpenAPI and returns a structured result", async () => {
    expect(
      await callTool(
        "search_sentry_api",
        "async () => Object.keys(spec.paths)",
      ),
    ).toMatchInlineSnapshot(`
      {
        "_meta": {
          "io.modelcontextprotocol/serverInfo": {
            "name": "sentry-code-mode-experiment",
            "version": "0.1.0",
          },
        },
        "content": [
          {
            "text": "{"result":["/api/0/items/"],"stats":{"apiCalls":0,"writesAttempted":0}}",
            "type": "text",
          },
        ],
        "resultType": "complete",
        "structuredContent": {
          "result": [
            "/api/0/items/",
          ],
          "stats": {
            "apiCalls": 0,
            "writesAttempted": 0,
          },
        },
      }
    `);
    expect(requests).toEqual([]);
  });

  it("discovers alerts from metadata using the example published to MCP clients", async () => {
    const metadataWorker = await createWorker(true, "/metadata-spec.json");
    try {
      const example = await publishedExample("Discovery", metadataWorker);
      expect(specRequests).toEqual([]);
      const result = await callTool(
        "search_sentry_api",
        example.replace('const term = "release";', 'const term = "alert";'),
        metadataWorker,
      );
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        result: [
          {
            method: "put",
            path: workflowPath,
            summary: "Update an Alert by ID",
            tags: ["workflows"],
          },
          {
            method: "get",
            path: "/api/0/detectors/",
            operationId: "listAlertDetectors",
            tags: ["workflows"],
          },
          { method: "get", path: "/api/0/notifications/" },
          { method: "get", path: "/api/0/rules/", tags: ["Alerts"] },
          { method: "get", path: "/api/0/alerts/" },
        ],
        stats: { apiCalls: 0, writesAttempted: 0 },
      });
      expect(specRequests).toEqual(["/metadata-spec.json"]);
      expect(requests).toEqual([]);
    } finally {
      await metadataWorker.dispose();
    }
  });

  it.each([
    {
      source: "operation tags",
      specPath: "/metadata-spec.json",
      categories: [{ name: "workflows" }, { name: "Alerts" }],
    },
    {
      source: "declared category metadata",
      specPath: "/metadata-spec-categories.json",
      categories: [
        {
          name: "workflows",
          description: "Manage alert workflows.",
          "x-sidebar-name": "Alerts",
        },
      ],
    },
  ])(
    "discovers categories from $source with the published example",
    async ({ specPath, categories }) => {
      const metadataWorker = await createWorker(true, specPath);
      try {
        const result = await callTool(
          "search_sentry_api",
          await publishedExample("Categories", metadataWorker),
          metadataWorker,
        );
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual({
          result: categories,
          stats: { apiCalls: 0, writesAttempted: 0 },
        });
        expect(requests).toEqual([]);
      } finally {
        await metadataWorker.dispose();
      }
    },
  );

  it("returns path and operation parameters separately with the published schema example", async () => {
    const metadataWorker = await createWorker(true, "/metadata-spec.json");
    try {
      const result = await callTool(
        "search_sentry_api",
        await publishedExample("Schema", metadataWorker),
        metadataWorker,
      );
      const path = metadataSpec.paths[releasePath];
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        result: {
          description: path.post.description,
          pathParameters: path.parameters,
          operationParameters: path.post.parameters,
          requestBody: path.post.requestBody,
        },
        stats: { apiCalls: 0, writesAttempted: 0 },
      });
      expect(requests).toEqual([]);
    } finally {
      await metadataWorker.dispose();
    }
  });

  it("combines authenticated API calls and preserves pagination", async () => {
    const result = await callTool(
      "execute_sentry_code",
      `async () => {
      const source = await sentry.request({path: "/items/", query: {project: [1, 2]}});
      const created = await sentry.request({method: "POST", path: "/api/0/items/", body: {name: source.body.name}});
      return {id: created.body.id, link: source.headers.link, cookie: source.headers["set-cookie"] ?? null};
    }`,
    );
    expect(result).toMatchInlineSnapshot(`
      {
        "_meta": {
          "io.modelcontextprotocol/serverInfo": {
            "name": "sentry-code-mode-experiment",
            "version": "0.1.0",
          },
        },
        "content": [
          {
            "text": "{"result":{"id":"2","link":"</api/0/items/?cursor=next>; rel=\\"next\\"; results=\\"true\\"","cookie":null},"stats":{"apiCalls":2,"writesAttempted":1}}",
            "type": "text",
          },
        ],
        "resultType": "complete",
        "structuredContent": {
          "result": {
            "cookie": null,
            "id": "2",
            "link": "</api/0/items/?cursor=next>; rel="next"; results="true"",
          },
          "stats": {
            "apiCalls": 2,
            "writesAttempted": 1,
          },
        },
      }
    `);
    expect(result.structuredContent).toEqual({
      result: {
        id: "2",
        link: '</api/0/items/?cursor=next>; rel="next"; results="true"',
        cookie: null,
      },
      stats: { apiCalls: 2, writesAttempted: 1 },
    });
    expect(requests).toEqual([
      {
        method: "GET",
        path: "/api/0/items/?project=1&project=2",
        auth: "Bearer fixture-only-token",
      },
      {
        method: "POST",
        path: "/api/0/items/",
        auth: "Bearer fixture-only-token",
      },
    ]);
  });

  it("prevents search from accessing the network", async () => {
    const result = await callTool(
      "search_sentry_api",
      'async () => (await fetch(new URL("/api/0/items/", spec.servers[0].url))).text()',
    );
    expect(result.isError).toBe(true);
    expect(requests).toEqual([]);
  });

  it("blocks raw network access, API path escapes and API redirects", async () => {
    const result = await callTool(
      "execute_sentry_code",
      `async () => {
      const outcomes = [];
      for (const url of ["https://unconfigured.invalid/api/0/items/", ${JSON.stringify(`${origin}/api/0/items/`)}]) {
        try { await fetch(url, {headers: {Authorization: "Bearer forged"}}); outcomes.push("unexpected access"); }
        catch { outcomes.push("blocked"); }
      }
      for (const path of ["/../../outside-api", "/redirect/"]) {
        try { await sentry.request({path}); }
        catch (error) { outcomes.push(error.status); }
      }
      return outcomes;
    }`,
    );
    expect(result.structuredContent?.result).toEqual([
      "blocked",
      "blocked",
      403,
      502,
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe("/api/0/redirect/");
  });

  it("rejects writes for a read-only connection", async () => {
    const readOnlyWorker = await createWorker(false);
    try {
      const result = await callTool(
        "execute_sentry_code",
        `async () => {
          try { await sentry.request({path: "/items/", method: "POST"}); }
          catch (error) { return error.status; }
        }`,
        readOnlyWorker,
      );
      expect(result.structuredContent?.result).toBe(403);
      expect(requests).toEqual([]);
    } finally {
      await readOnlyWorker.dispose();
    }
  });

  it("returns API failures as tool errors without retrying writes", async () => {
    const result = await callTool(
      "execute_sentry_code",
      "async () => sentry.request({method: 'POST', path: '/failure/', body: {}})",
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "POST /api/0/failure/ returned HTTP 400",
    );
    expect(result.content[0]?.text).toContain(
      "writes may already have completed",
    );
    expect(requests).toHaveLength(1);
  });

  it("preserves upstream scope evidence in caught HTTP errors", async () => {
    const result = await callTool(
      "execute_sentry_code",
      `async () => {
        try { await sentry.request({path: "/insufficient-scope/", method: "POST"}); }
        catch (error) {
          return {status: error.status, method: error.method, path: error.path,
            headers: error.headers, data: error.data};
        }
      }`,
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.result).toEqual({
      status: 403,
      method: "POST",
      path: "/api/0/insufficient-scope/",
      headers: {
        "content-type": "application/json",
        "www-authenticate":
          'Bearer error="insufficient_scope", scope="org:admin org:write"',
      },
      data: { detail: "You do not have permission to perform this action." },
    });
    expect(requests).toHaveLength(1);
  });

  it.each(["insufficient-scope", "forbidden"])(
    "returns an uncaught %s denial with HTTP evidence and no retries",
    async (endpoint) => {
      const result = await callTool(
        "execute_sentry_code",
        `async () => sentry.request({method: "POST", path: "/${endpoint}/"})`,
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: expect.stringContaining(
          `POST /api/0/${endpoint}/ returned HTTP 403`,
        ),
        httpError: {
          status: 403,
          method: "POST",
          path: `/api/0/${endpoint}/`,
          headers: {
            "content-type": "application/json",
            ...(endpoint === "insufficient-scope"
              ? {
                  "www-authenticate":
                    'Bearer error="insufficient_scope", scope="org:admin org:write"',
                }
              : {}),
          },
        },
        stats: { apiCalls: 1, writesAttempted: 1 },
      });
      expect(result.content[0]?.text).toContain(
        "You do not have permission to perform this action.",
      );
      expect(result.content[0]?.text).toContain(
        "writes may already have completed",
      );
      expect(result.content[0]?.text).toContain('"status":403');
      if (endpoint === "forbidden") {
        expect(result.content[0]?.text).not.toContain("insufficient_scope");
      }
      expect(requests).toHaveLength(1);
    },
  );

  it("bounds API requests per execution", async () => {
    const result = await callTool(
      "execute_sentry_code",
      "async () => { for (let i = 0; i < 21; i++) await sentry.request({path: '/items/'}); }",
    );
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(20);
  });

  it("keeps the API broker outside the model module", async () => {
    const result = await callTool(
      "execute_sentry_code",
      "async () => ({moduleBroker: typeof apiBroker, parameterBroker: typeof broker})",
    );
    expect(result.structuredContent?.result).toEqual({
      moduleBroker: "undefined",
      parameterBroker: "undefined",
    });
  });

  it("preserves a user error with partial HTTP-like properties", async () => {
    const result = await callTool(
      "execute_sentry_code",
      'async () => { throw {status: 403, message: "Example denied"}; }',
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: expect.stringContaining("Example denied"),
      stats: { apiCalls: 0, writesAttempted: 0 },
    });
    expect(result.structuredContent).not.toHaveProperty("httpError");
    expect(result.content[0]?.text).not.toContain("Invalid input");
  });

  it("returns useful errors for invalid code and oversized results", async () => {
    const invalid = await callTool("execute_sentry_code", "async () => {");
    expect(invalid.isError).toBe(true);
    const oversized = await callTool(
      "execute_sentry_code",
      "async () => 'x'.repeat(50_001)",
    );
    expect(oversized.isError).toBe(true);
    expect(oversized.content[0]?.text).toContain("Result exceeds 50,000 bytes");
    expect(requests).toEqual([]);
  });
});
