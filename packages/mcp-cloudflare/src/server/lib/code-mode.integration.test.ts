import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_MCP_REQUEST_BODY_SIZE,
  MAX_MCP_TOOL_INPUT_ELEMENTS,
} from "@sentry/mcp-core/constants";
import * as logging from "@sentry/mcp-core/telem/logging";
import { SENTRY_OPENAPI_URL } from "../../code-mode/openapi";
import type { Env, WorkerProps } from "../types";
import mcpHandler from "./mcp-handler";

const monitorPath =
  "/api/0/projects/{organization_id_or_slug}/{project_id_or_slug}/monitors/{monitor_id_or_slug}/";
const projectListPath =
  "/api/0/organizations/{organization_id_or_slug}/projects/";
// A small subset of the pinned schema's real paths and auth_token alternatives.
const spec = {
  openapi: "3.0.0",
  paths: {
    "/api/0/organizations/": {
      get: {
        security: [{ auth_token: ["org:admin", "org:read", "org:write"] }],
      },
    },
    [projectListPath]: {
      get: {
        security: [{ auth_token: ["org:admin", "org:read", "org:write"] }],
      },
    },
    "/api/0/organizations/{organization_id_or_slug}/dashboards/": {
      get: {
        security: [{ auth_token: ["org:admin", "org:read", "org:write"] }],
      },
      post: {
        security: [{ auth_token: ["org:admin", "org:read", "org:write"] }],
      },
    },
    "/api/0/organizations/{organization_id_or_slug}/dashboards/{dashboard_id}/":
      {
        get: {
          security: [{ auth_token: ["org:admin", "org:read", "org:write"] }],
        },
      },
    [monitorPath]: {
      get: {
        security: [
          { auth_token: ["project:admin", "project:read", "project:write"] },
        ],
      },
      put: {
        security: [
          { auth_token: ["alerts:write", "project:admin", "project:write"] },
        ],
      },
    },
    "/api/0/sentry-apps/{sentry_app_id_or_slug}/": {
      get: { security: [{ auth_token: ["org:read", "project:read"] }] },
    },
  },
};

interface ApiRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string;
  signal: AbortSignal;
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: {
    result: unknown;
    stats: { apiCalls: number; writesAttempted: number };
  };
}

interface ToolList {
  tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>;
}

const originalFetch = globalThis.fetch;
let apiRequests: ApiRequest[];
let apiResponse: (request: ApiRequest) => Response | Promise<Response>;
let beforeRegionResponse: (() => Promise<void>) | undefined;
const revokeGrant = vi.fn(async () => {});

function workerEnv(): Env {
  return {
    ...(env as Record<string, unknown>),
    MCP_CACHE: env.OAUTH_KV,
    OAUTH_PROVIDER: { revokeGrant },
  } as Env;
}

async function dispatchRpc(
  method: string,
  params: Record<string, unknown>,
  options: {
    props?: Partial<WorkerProps>;
    path?: string;
    keepAlive?: Promise<void>;
    protocolVersion?: "2026-07-28" | "2025-03-26";
  } = {},
) {
  const protocolVersion = options.protocolVersion ?? "2026-07-28";
  const props: WorkerProps = {
    id: "code-mode-user",
    clientId: "code-mode-client",
    clientName: "Code Mode Test Client",
    accessToken: "test-api-token",
    refreshToken: "test-refresh-token",
    scope: "org:read project:read",
    grantedSkills: ["api-read"],
    ...options.props,
  };
  const ctx = Object.assign(createExecutionContext(), { props });
  if (options.keepAlive) ctx.waitUntil(options.keepAlive);
  const request = new Request(`http://localhost${options.path ?? "/mcp"}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${props.id}:code-mode-grant:secret`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Host: "localhost",
      "CF-Connecting-IP": "192.0.2.1",
      "User-Agent": "claude-code/2.0.0",
      "X-Sentry-Utm-Source": "plugin",
      "mcp-protocol-version": protocolVersion,
      "mcp-method": method,
      ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        ...(protocolVersion === "2026-07-28"
          ? {
              _meta: {
                "io.modelcontextprotocol/protocolVersion": protocolVersion,
                "io.modelcontextprotocol/clientInfo": {
                  name: "code-mode-integration-tests",
                  version: "1.0.0",
                },
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            }
          : {}),
      },
    }),
  });
  const response = await mcpHandler.fetch!(request, workerEnv(), ctx);
  return { response, ctx };
}

async function rpc<T>(
  method: string,
  params: Record<string, unknown>,
  options: Parameters<typeof dispatchRpc>[2] = {},
): Promise<T> {
  const { response, ctx } = await dispatchRpc(method, params, options);
  const result = await readRpcResult<T>(response);
  await waitOnExecutionContext(ctx);
  return result;
}

async function readRpcResult<T>(response: Response): Promise<T> {
  const text = await response.text();
  expect(response.status, text).toBe(200);
  const data = text.startsWith("{")
    ? text
    : text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6);
  expect(data, text).toBeDefined();
  const message = JSON.parse(data!) as { result?: T; error?: unknown };
  expect(message.error).toBeUndefined();
  return message.result as T;
}

async function execute(
  code: string,
  options?: Parameters<typeof rpc>[2],
): Promise<ToolResult> {
  return await rpc(
    "tools/call",
    { name: "execute_sentry_code", arguments: { code } },
    options,
  );
}

beforeEach(() => {
  apiRequests = [];
  revokeGrant.mockClear();
  apiResponse = () => Response.json({ ok: true });
  beforeRegionResponse = undefined;
  // The pool runs the real main Worker in this isolate. Only external HTTP is
  // simulated; MCP handlers, Dynamic Workers and the RPC broker are real.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url === SENTRY_OPENAPI_URL) return Response.json(spec);
    const url = new URL(request.url);
    if (!["sentry.io", "de.sentry.io"].includes(url.hostname)) {
      return await originalFetch(input, init);
    }
    const recorded = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: await request.text(),
      signal: request.signal,
    };
    apiRequests.push(recorded);
    const organization = /^\/api\/0\/organizations\/([^/]+)\/$/.exec(
      url.pathname,
    );
    if (organization) {
      await beforeRegionResponse?.();
      return Response.json({
        id: "100",
        slug: organization[1],
        name: organization[1],
        links: {
          regionUrl: "https://de.sentry.io",
          organizationUrl: `https://sentry.io/organizations/${organization[1]}/`,
        },
      });
    }
    if (url.pathname === "/api/0/projects/code-mode-org/web/") {
      return Response.json({ id: "200", slug: "web", name: "Web" });
    }
    return await apiResponse(recorded);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

describe("Code Mode on the authenticated MCP", () => {
  it.each(["return", "throw"])(
    "closes unawaited API work when the program exits with %s",
    async (exit) => {
      const started = deferred();
      const finish = deferred();
      let write: ApiRequest | undefined;
      apiResponse = async (request) => {
        if (request.method === "POST") {
          write = request;
          started.resolve();
          await finish.promise;
        } else {
          await started.promise;
        }
        return Response.json({ ok: true });
      };
      const { response, ctx } = await dispatchRpc(
        "tools/call",
        {
          name: "execute_sentry_code",
          arguments: {
            code: `async () => {
              sentry.request({method: "POST", path: "/organizations/code-mode-org/dashboards/", body: {title: "Copy"}}).catch(() => {});
              await sentry.request({path: "/organizations/"});
              ${exit === "return" ? 'return "done";' : 'throw new Error("Program failed");'}
            }`,
          },
        },
        { props: { grantedSkills: ["api-write"] }, keepAlive: finish.promise },
      );
      try {
        const result = await readRpcResult<ToolResult>(response);
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain(
          exit === "return" ? "Await every sentry.request()" : "Program failed",
        );
        expect(result.content[0].text).toContain(
          "writes may already have completed",
        );
        expect(write?.signal.aborted).toBe(true);
      } finally {
        finish.resolve();
        await waitOnExecutionContext(ctx);
      }
    },
  );

  it("does not send a write when authorization finishes after the program", async () => {
    const authorizing = deferred();
    const finish = deferred();
    beforeRegionResponse = async () => {
      authorizing.resolve();
      await finish.promise;
    };
    apiResponse = async () => {
      await authorizing.promise;
      return Response.json({ ok: true });
    };
    const { response, ctx } = await dispatchRpc(
      "tools/call",
      {
        name: "execute_sentry_code",
        arguments: {
          code: `async () => {
            sentry.request({method: "POST", path: "/organizations/code-mode-org/dashboards/", body: {title: "Copy"}}).catch(() => {});
            await sentry.request({path: "/organizations/"});
            return "done";
          }`,
        },
      },
      { props: { grantedSkills: ["api-write"] }, keepAlive: finish.promise },
    );
    try {
      const result = await readRpcResult<ToolResult>(response);
      finish.resolve();
      await waitOnExecutionContext(ctx);
      // Drain the released lookup and any continuation into the API broker.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(apiRequests.filter(({ method }) => method === "POST")).toEqual([]);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Await every sentry.request()");
    } finally {
      finish.resolve();
      await waitOnExecutionContext(ctx);
    }
  });

  it.each(["headers", "body"])(
    "aborts an awaited API request stalled before its %s at the execution deadline",
    async (phase) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const started = deferred();
      const finish = deferred();
      let pending: ApiRequest | undefined;
      apiResponse = async (request) => {
        pending = request;
        started.resolve();
        if (phase === "headers") {
          await finish.promise;
          return Response.json({ ok: true });
        }
        return new Response(
          new ReadableStream({
            start(controller) {
              request.signal.addEventListener(
                "abort",
                () => controller.error(request.signal.reason),
                { once: true },
              );
              void finish.promise.then(() => {
                if (!request.signal.aborted) controller.close();
              });
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      };
      const dispatched = dispatchRpc(
        "tools/call",
        {
          name: "execute_sentry_code",
          arguments: {
            code: 'async () => sentry.request({path: "/organizations/"})',
          },
        },
        { keepAlive: finish.promise },
      );
      await started.promise;
      await vi.advanceTimersByTimeAsync(30_000);
      const { response, ctx } = await dispatched;
      try {
        const result = await readRpcResult<ToolResult>(response);
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("Execution deadline exceeded");
        expect(pending?.signal.aborted).toBe(true);
        expect(apiRequests).toHaveLength(1);
      } finally {
        finish.resolve();
        vi.useRealTimers();
        await waitOnExecutionContext(ctx);
      }
    },
  );

  it("rejects excessive nested argument members before executing code", async () => {
    const result = await rpc<ToolResult>("tools/call", {
      name: "execute_sentry_code",
      arguments: {
        code: 'async () => sentry.request({path: "/organizations/"})',
        unused: Object.fromEntries(
          Array.from(
            { length: MAX_MCP_TOOL_INPUT_ELEMENTS + 1 },
            (_, index) => [`key${index}`, null],
          ),
        ),
      },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      `maximum of ${MAX_MCP_TOOL_INPUT_ELEMENTS} elements`,
    );
    expect(apiRequests).toEqual([]);
  });

  it.each(["2026-07-28", "2025-03-26"] as const)(
    "rejects HTTP bodies above the limit with protocol %s",
    async (protocolVersion) => {
      const { response, ctx } = await dispatchRpc(
        "tools/call",
        {
          name: "execute_sentry_code",
          arguments: { code: "x".repeat(MAX_MCP_REQUEST_BODY_SIZE) },
        },
        { protocolVersion },
      );
      const body = await response.text();
      await waitOnExecutionContext(ctx);
      expect(response.status).toBe(413);
      expect(response.headers.get("Content-Type")).toContain(
        "application/json",
      );
      expect(JSON.parse(body)).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32000,
          message: `Payload Too Large: Request body must not exceed ${MAX_MCP_REQUEST_BODY_SIZE} bytes`,
        },
      });
      expect(apiRequests).toEqual([]);
    },
  );

  it("advertises Code Mode alongside the normal catalog and executes discovery", async () => {
    const list = await rpc<ToolList>("tools/list", {});
    expect(list.tools.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "search_sentry_api",
        "execute_sentry_code",
        "find_organizations",
      ]),
    );
    expect(
      list.tools.find(({ name }) => name === "execute_sentry_code")?.annotations
        ?.readOnlyHint,
    ).toBe(true);
    const result = await rpc<ToolResult>("tools/call", {
      name: "search_sentry_api",
      arguments: { code: "async () => Object.keys(spec.paths)" },
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.result).toContain(monitorPath);
    expect(apiRequests).toHaveLength(0);
  });

  it("blocks api-read writes through both sentry.request and raw fetch", async () => {
    const result = await execute(
      `async () => {
      let wrappedStatus;
      try { await sentry.request({method: "PUT", path: "/projects/code-mode-org/web/monitors/billing/", body: {name: "changed"}}); }
      catch (error) { wrappedStatus = error.status; }
      let rawBlocked = false;
      try { await fetch("https://sentry.io/api/0/projects/code-mode-org/web/monitors/billing/", {method: "PUT", body: "{}"}); }
      catch { rawBlocked = true; }
      return {wrappedStatus, rawBlocked};
    }`,
      {
        props: {
          upstreamScopes: [
            "org:read",
            "project:write",
            "team:write",
            "event:write",
          ],
        },
      },
    );
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.result).toEqual({
      wrappedStatus: 403,
      rawBlocked: true,
    });
    expect(apiRequests).toHaveLength(0);
  });

  it("uses the API write grant, regional routing and attribution headers", async () => {
    apiResponse = (request) =>
      Response.json(
        { saved: JSON.parse(request.body) },
        { headers: { ETag: '"saved-monitor"', Link: "<next-page>; rel=next" } },
      );
    const result = await execute(
      `async () => sentry.request({
      method: "PUT", path: "/projects/code-mode-org/web/monitors/billing/", body: {name: "Billing"}
    })`,
      { props: { grantedSkills: ["api-write"] } },
    );
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.result).toMatchObject({
      status: 200,
      headers: { etag: '"saved-monitor"', link: "<next-page>; rel=next" },
      body: { saved: { name: "Billing" } },
    });
    const writes = apiRequests.filter(({ method }) => method === "PUT");
    expect(writes).toHaveLength(1);
    expect(writes[0].url).toBe(
      "https://de.sentry.io/api/0/projects/code-mode-org/web/monitors/billing/",
    );
    expect(writes[0].headers.get("authorization")).toBe(
      "Bearer test-api-token",
    );
    expect(writes[0].headers.get("x-sentry-mcp-client-id")).toBe(
      "code-mode-client",
    );
    expect(writes[0].headers.get("x-sentry-mcp-client-name")).toBe(
      "Code Mode Test Client",
    );
    expect(writes[0].headers.get("x-sentry-mcp-utm-source")).toBe("plugin");
  });

  it("keeps concurrent users' upstream credentials separate", async () => {
    apiResponse = ({ headers }) =>
      Response.json({ owner: headers.get("authorization") });
    const code =
      'async () => (await sentry.request({path: "/organizations/"})).body';
    const results = await Promise.all([
      execute(code, {
        props: { id: "first-user", accessToken: "first-api-token" },
      }),
      execute(code, {
        props: { id: "second-user", accessToken: "second-api-token" },
      }),
    ]);
    expect(results.map((result) => result.isError)).toEqual([
      undefined,
      undefined,
    ]);
    expect(results.map((result) => result.structuredContent?.result)).toEqual([
      { owner: "Bearer first-api-token" },
      { owner: "Bearer second-api-token" },
    ]);
    expect(apiRequests).toHaveLength(2);
  });

  it("enforces an organization grant against other organizations and global ID routes", async () => {
    const result = await execute(
      `async () => {
      const outcomes = [];
      for (const path of ["/organizations/other-org/projects/", "/sentry-apps/an-app/"]) {
        try { await sentry.request({path}); }
        catch (error) { outcomes.push({status: error.status, body: error.data}); }
      }
      return outcomes;
    }`,
      {
        path: "/mcp/code-mode-org",
        props: { constraintOrganizationSlug: "code-mode-org" },
      },
    );
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.result).toEqual([
      {
        status: 403,
        body: { detail: expect.stringContaining("organization constraint") },
      },
      {
        status: 403,
        body: { detail: expect.stringContaining("organization constraint") },
      },
    ]);
    expect(
      apiRequests.every(
        ({ url }) =>
          url === "https://sentry.io/api/0/organizations/code-mode-org/",
      ),
    ).toBe(true);
  });

  it.each([
    {
      name: "docs-only grant",
      props: { grantedSkills: ["docs"] },
      path: "/mcp",
    },
    {
      name: "project constraint",
      props: {
        grantedSkills: ["api-read"],
        constraintOrganizationSlug: "code-mode-org",
        constraintProjectSlug: "web",
      },
      path: "/mcp/code-mode-org/web",
    },
  ])("preserves the existing surface for a $name", async ({ props, path }) => {
    const result = await rpc<ToolList>("tools/list", {}, { props, path });
    expect(result.tools.map(({ name }) => name)).not.toContain(
      "execute_sentry_code",
    );
    expect(result.tools.map(({ name }) => name)).not.toContain(
      "search_sentry_api",
    );
  });

  it.each(["inspect", "triage", "project-management", "seer"])(
    "does not turn a legacy %s grant into arbitrary API access",
    async (skill) => {
      const result = await rpc<ToolList>(
        "tools/list",
        {},
        {
          props: {
            grantedSkills: [skill],
            upstreamScopes: ["org:read", "project:write", "event:write"],
          },
        },
      );
      expect(result.tools.map(({ name }) => name)).not.toContain(
        "execute_sentry_code",
      );
      expect(result.tools.map(({ name }) => name)).not.toContain(
        "search_sentry_api",
      );
      expect(apiRequests).toHaveLength(0);
    },
  );

  it("copies a dashboard for two projects with api-write and an upstream org:read token", async () => {
    // Dashboard POST accepts org:read in both the published schema and backend.
    const original = {
      id: "101",
      title: "Errors",
      projects: [101, 102],
      widgets: [],
    };
    const dashboards = new Map([[original.id, original]]);
    apiResponse = ({ url, method, body }) => {
      if (method === "POST") {
        const saved = {
          ...JSON.parse(body),
          id: String(dashboards.size + 101),
        };
        dashboards.set(saved.id, saved);
        return Response.json(saved, { status: 201 });
      }
      const id = new URL(url).pathname.split("/").at(-2)!;
      return Response.json(dashboards.get(id));
    };
    const result = await execute(
      `async () => {
        const path = "/organizations/code-mode-org/dashboards/";
        const original = (await sentry.request({path: path + "101/"})).body;
        const copies = [];
        for (const project of [201, 202]) {
          const created = (await sentry.request({method: "POST", path,
            body: {title: original.title + " " + project, widgets: original.widgets, projects: [project]}
          })).body;
          const verified = (await sentry.request({path: path + created.id + "/"})).body;
          copies.push({id: verified.id, projects: verified.projects});
        }
        return copies;
      }`,
      {
        props: {
          grantedSkills: ["api-write"],
          upstreamScopes: ["org:read"],
          grantedScopes: ["org:read"],
        },
      },
    );
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.result).toEqual([
      { id: "102", projects: [201] },
      { id: "103", projects: [202] },
    ]);
    expect(apiRequests.filter(({ method }) => method === "POST")).toHaveLength(
      2,
    );
    expect(dashboards.get("101")).toEqual(original);
  });

  it.each([undefined, ["org:read", "project:write"]])(
    "preserves the real upstream permission denial with recorded scopes %j",
    async (upstreamScopes) => {
      apiResponse = () =>
        Response.json(
          { detail: "You do not have permission to perform this action." },
          { status: 403 },
        );
      const result = await execute(
        'async () => sentry.request({method: "POST", path: "/organizations/code-mode-org/dashboards/", body: {title: "Copy", widgets: []}})',
        { props: { grantedSkills: ["api-write"], upstreamScopes } },
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("403");
      expect(result.content[0].text).toContain("You do not have permission");
      expect(
        apiRequests.filter(({ method }) => method === "POST"),
      ).toHaveLength(1);
      expect(revokeGrant).not.toHaveBeenCalled();
    },
  );

  it("revokes an upstream-rejected grant even when user code catches the 401", async () => {
    apiResponse = () =>
      Response.json({ detail: "Expired upstream token" }, { status: 401 });
    const result = await execute(`async () => {
      const statuses = [];
      for (let i = 0; i < 2; i++) {
        try { await sentry.request({path: "/organizations/"}); }
        catch (error) { statuses.push(error.status); }
      }
      return statuses;
    }`);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.result).toEqual([401, 401]);
    expect(revokeGrant).toHaveBeenCalledExactlyOnceWith(
      "code-mode-grant",
      "code-mode-user",
    );
  });

  it.each([403, 503])(
    "reports only upstream server failures when user code catches HTTP %s",
    async (status) => {
      const logIssue = vi
        .spyOn(logging, "logIssue")
        .mockReturnValue("code-mode-event");
      apiResponse = () =>
        Response.json({ detail: "Upstream failure" }, { status });
      const result = await execute(`async () => {
        try { await sentry.request({path: "/organizations/"}); }
        catch (error) { return {status: error.status, eventId: error.headers["x-sentry-event-id"] ?? null}; }
      }`);
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent?.result).toEqual({
        status,
        eventId: status === 503 ? "code-mode-event" : null,
      });
      if (status === 503) {
        expect(logIssue).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ name: "ApiServerError", status: 503 }),
          {
            loggerScope: ["code-mode", "api"],
            extra: { method: "GET", status: 503 },
          },
        );
      } else {
        expect(logIssue).not.toHaveBeenCalled();
      }
    },
  );
});
