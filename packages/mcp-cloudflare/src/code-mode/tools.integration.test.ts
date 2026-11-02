import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/cloudflare";
import * as logging from "@sentry/mcp-core/telem/logging";
import mcpHandler from "../server/lib/mcp-handler";
import type { Env, WorkerProps } from "../server/types";
import { SPEC_TEXT, SPEC_VERSION } from "./openapi";

const monitorPath =
  "/api/0/projects/{organization_id_or_slug}/{project_id_or_slug}/monitors/{monitor_id_or_slug}/";

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
}

interface ToolList {
  tools: Array<{
    name: string;
    description?: string;
    annotations?: { readOnlyHint?: boolean };
  }>;
}

const originalFetch = globalThis.fetch;
let apiRequests: ApiRequest[];
let apiResponse: (request: ApiRequest) => Response | Promise<Response>;
let beforeRegionResponse: (() => Promise<void>) | undefined;
const revokeGrant = vi.fn(async () => {});

function workerEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...(env as Record<string, unknown>),
    MCP_CACHE: env.OAUTH_KV,
    OAUTH_PROVIDER: { revokeGrant },
    ...overrides,
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
    env?: Partial<Env>;
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
  const response = await mcpHandler.fetch!(
    request,
    workerEnv(options.env),
    ctx,
  );
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

async function search(
  code: string,
  options?: Parameters<typeof rpc>[2],
): Promise<ToolResult> {
  return await rpc(
    "tools/call",
    { name: "search_sentry_api", arguments: { code } },
    options,
  );
}

/** One of the search examples published in the tool description. */
async function publishedExample(
  name: "Discovery" | "Categories" | "Schema",
): Promise<string> {
  const { tools } = await rpc<ToolList>("tools/list", {});
  const example = tools
    .find((tool) => tool.name === "search_sentry_api")
    ?.description?.split(`${name} example: `)[1]
    ?.split(/\n(?:Discovery|Categories|Schema) example: /)[0]
    ?.trim();
  if (!example) throw new Error(`${name} example missing from tools/list`);
  return example;
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
      const logIssue = vi.spyOn(logging, "logIssue");
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
        // A deadline is the program's outcome, not a server failure.
        expect(logIssue).not.toHaveBeenCalled();
        expect(result.structuredContent).toEqual({
          error: expect.stringContaining("Execution deadline exceeded"),
          stats: { apiCalls: 1, writesAttempted: 0 },
        });
      } finally {
        finish.resolve();
        vi.useRealTimers();
        await waitOnExecutionContext(ctx);
      }
    },
  );

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
    { name: "API Read", grantedSkills: ["api-read"], listed: true },
    { name: "API Write", grantedSkills: ["api-write"], listed: true },
    ...["docs", "inspect", "triage", "project-management", "seer"].map(
      (skill) => ({ name: skill, grantedSkills: [skill], listed: false }),
    ),
    {
      name: "API Read on a project connection",
      grantedSkills: ["api-read"],
      listed: false,
      project: true,
    },
  ])(
    "lists Code Mode only for API grants: $name",
    async ({ grantedSkills, listed, project }) => {
      const { tools } = await rpc<ToolList>(
        "tools/list",
        {},
        project
          ? {
              path: "/mcp/code-mode-org/web",
              props: {
                grantedSkills,
                constraintOrganizationSlug: "code-mode-org",
                constraintProjectSlug: "web",
              },
            }
          : { props: { grantedSkills } },
      );
      const execute = tools.find(({ name }) => name === "execute_sentry_code");
      const search = tools.find(({ name }) => name === "search_sentry_api");
      expect(Boolean(execute), "execute_sentry_code").toBe(listed);
      expect(Boolean(search), "search_sentry_api").toBe(listed);
      if (execute) {
        expect(execute.annotations?.readOnlyHint).toBe(
          !grantedSkills.includes("api-write"),
        );
      }
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
            extra: {
              method: "GET",
              status: 503,
              operation: "/api/0/organizations/",
            },
          },
        );
      } else {
        expect(logIssue).not.toHaveBeenCalled();
      }
    },
  );
});

describe("Code Mode sandbox", () => {
  const dashboards = "/organizations/code-mode-org/dashboards/";
  const dashboardsPath = `/api/0${dashboards}`;
  const writer = { props: { grantedSkills: ["api-write"] } };
  const sent = (method: string) =>
    apiRequests.filter((request) => request.method === method);
  const failPosts = (status = 400) => {
    apiResponse = ({ method }) =>
      method === "POST"
        ? Response.json({ title: ["This field is required."] }, { status })
        : Response.json([]);
  };

  it("runs the published search examples against the shipped schema", async () => {
    const spec = JSON.parse(SPEC_TEXT) as {
      tags?: unknown;
      paths: Record<
        string,
        Record<
          string,
          { description?: string; parameters?: unknown; requestBody?: unknown }
        >
      >;
    };
    const discovery = await search(
      (await publishedExample("Discovery")).replace(
        'const term = "release";',
        'const term = "alert";',
      ),
    );
    expect(discovery.isError).toBeUndefined();
    expect(discovery.structuredContent?.result).toContainEqual(
      expect.objectContaining({
        method: "put",
        path: "/api/0/organizations/{organization_id_or_slug}/workflows/{workflow_id}/",
        summary: "Update an Alert by ID",
      }),
    );
    const categories = await search(await publishedExample("Categories"));
    expect(categories.structuredContent?.result).toEqual(spec.tags);
    const schema = await search(await publishedExample("Schema"));
    const releases =
      spec.paths["/api/0/organizations/{organization_id_or_slug}/releases/"];
    expect(schema.structuredContent?.result).toEqual({
      description: releases.post.description,
      pathParameters: releases.parameters,
      operationParameters: releases.post.parameters,
      requestBody: releases.post.requestBody,
    });
    expect(apiRequests).toEqual([]);
  });

  it("keeps search away from the network", async () => {
    const result = await search(
      'async () => (await fetch("https://sentry.io/api/0/organizations/")).text()',
    );
    expect(result.isError).toBe(true);
    expect(apiRequests).toEqual([]);
  });

  it("repeats array query parameters and drops private response headers", async () => {
    const link =
      '<https://sentry.io/api/0/organizations/code-mode-org/projects/?cursor=next>; rel="next"; results="true"';
    apiResponse = ({ method }) =>
      Response.json(
        { id: "1", name: "Web" },
        {
          status: method === "POST" ? 201 : 200,
          headers: { Link: link, "Set-Cookie": "private-session=secret" },
        },
      );
    const result = await execute(
      `async () => {
        const source = await sentry.request({path: "/organizations/code-mode-org/projects/", query: {project: [1, 2], cursor: undefined}});
        const created = await sentry.request({method: "POST", path: "/api/0${dashboards}", body: {title: source.body.name}});
        return {status: created.status, link: source.headers.link, cookie: source.headers["set-cookie"] ?? null};
      }`,
      writer,
    );
    expect(result.structuredContent).toEqual({
      result: { status: 201, link, cookie: null },
      stats: { apiCalls: 2, writesAttempted: 1 },
    });
    expect(
      apiRequests
        .filter(({ url }) => url.startsWith("https://de.sentry.io/"))
        .map(({ method, url }) => ({ method, url })),
    ).toEqual([
      {
        method: "GET",
        url: "https://de.sentry.io/api/0/organizations/code-mode-org/projects/?project=1&project=2",
      },
      { method: "POST", url: `https://de.sentry.io${dashboardsPath}` },
    ]);
  });

  it("blocks raw network access, API path escapes and redirects", async () => {
    apiResponse = () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://example.com/outside-api" },
      });
    const result = await execute(`async () => {
      const outcomes = [];
      for (const url of ["https://unconfigured.invalid/api/0/organizations/", "https://sentry.io/api/0/organizations/"]) {
        try { await fetch(url, {headers: {Authorization: "Bearer forged"}}); outcomes.push("unexpected access"); }
        catch { outcomes.push("blocked"); }
      }
      for (const path of ["/../../outside-api", "/organizations/"]) {
        try { await sentry.request({path}); }
        catch (error) { outcomes.push(error.status); }
      }
      return outcomes;
    }`);
    expect(result.structuredContent?.result).toEqual([
      "blocked",
      "blocked",
      403,
      502,
    ]);
    expect(apiRequests.map(({ url }) => url)).toEqual([
      "https://sentry.io/api/0/organizations/",
    ]);
  });

  it("returns an uncaught API failure with HTTP evidence and no retries", async () => {
    const challenge =
      'Bearer error="insufficient_scope", scope="org:admin org:write"';
    apiResponse = () =>
      Response.json(
        { detail: "You do not have permission to perform this action." },
        {
          status: 403,
          headers: {
            "Set-Cookie": "private-session=secret",
            "WWW-Authenticate": challenge,
          },
        },
      );
    const result = await execute(
      `async () => sentry.request({method: "POST", path: "${dashboards}", body: {}})`,
      writer,
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: expect.stringContaining(
        `POST ${dashboardsPath} returned HTTP 403`,
      ),
      httpError: {
        status: 403,
        method: "POST",
        path: dashboardsPath,
        headers: {
          "content-type": "application/json",
          "www-authenticate": challenge,
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
    expect(sent("POST")).toHaveLength(1);
  });

  it("exposes HTTP details on caught errors", async () => {
    failPosts(403);
    const result = await execute(
      `async () => {
        try { await sentry.request({method: "POST", path: "${dashboards}", body: {}}); }
        catch (error) { return {status: error.status, method: error.method, path: error.path, data: error.data}; }
      }`,
      writer,
    );
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.result).toEqual({
      status: 403,
      method: "POST",
      path: dashboardsPath,
      data: { title: ["This field is required."] },
    });
  });

  it.each([
    {
      name: "a failure settled before the program returns",
      ignored: `sentry.request({method: "POST", path: "${dashboards}", body: {}})`,
      error: `POST ${dashboardsPath} returned HTTP 400`,
      posts: 1,
    },
    {
      name: "a failure through a derived promise",
      ignored: `sentry.request({method: "POST", path: "${dashboards}", body: {}}).then(() => {})`,
      error: `POST ${dashboardsPath} returned HTTP 400`,
      posts: 1,
    },
    {
      name: "an invalid request",
      ignored: 'sentry.request({path: "invalid-path"})',
      error: "path must start with /",
      posts: 0,
    },
  ])(
    "fails the execution on an ignored rejection: $name",
    async ({ ignored, error, posts }) => {
      const answered = deferred();
      apiResponse = async ({ method }) => {
        if (method === "POST") {
          answered.resolve();
          return Response.json({ title: ["Required."] }, { status: 400 });
        }
        // Answer the awaited read after the ignored write has failed.
        if (posts) await answered.promise;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return Response.json([]);
      };
      const result = await execute(
        `async () => {
          ${ignored};
          await sentry.request({path: "/organizations/"});
          return "done";
        }`,
        writer,
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.error).toContain(error);
      expect(result.structuredContent).not.toHaveProperty("result");
      expect(sent("POST")).toHaveLength(posts);
    },
  );

  it("allows handled rejections, caught late or collected with allSettled", async () => {
    failPosts();
    const result = await execute(
      `async () => {
        const pending = sentry.request({method: "POST", path: "${dashboards}", body: {}});
        await sentry.request({path: "/organizations/"});
        let late;
        try { await pending; } catch (error) { late = error.status; }
        const settled = await Promise.allSettled([
          sentry.request({method: "POST", path: "${dashboards}", body: {}}),
          sentry.request({path: "/organizations/"}),
        ]);
        return {late, settled: settled.map(result => result.status)};
      }`,
      writer,
    );
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.result).toEqual({
      late: 400,
      settled: ["rejected", "fulfilled"],
    });
  });

  it("bounds API requests per execution", async () => {
    const result = await execute(
      "async () => { for (let i = 0; i < 21; i++) await sentry.request({path: '/organizations/'}); }",
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("API call budget exhausted");
    expect(apiRequests).toHaveLength(20);
  });

  it("keeps the API broker outside the model module", async () => {
    const result = await execute(
      "async () => ({moduleBroker: typeof apiBroker, parameterBroker: typeof broker})",
    );
    expect(result.structuredContent?.result).toEqual({
      moduleBroker: "undefined",
      parameterBroker: "undefined",
    });
  });

  it("returns useful errors for invalid code, plain throws and oversized results", async () => {
    const invalid = await execute("async () => {");
    expect(invalid.isError).toBe(true);
    // A thrown object with HTTP-like fields is the program's error, not an API one.
    const thrown = await execute(
      'async () => { throw {status: 403, message: "Example denied"}; }',
    );
    expect(thrown.structuredContent).toEqual({
      error: expect.stringContaining("Example denied"),
      stats: { apiCalls: 0, writesAttempted: 0 },
    });
    const oversized = await execute("async () => 'x'.repeat(50_001)");
    expect(oversized.isError).toBe(true);
    expect(oversized.content[0]?.text).toContain("Result exceeds 50,000 bytes");
    expect(apiRequests).toEqual([]);
  });
});

describe("Code Mode telemetry", () => {
  /**
   * Captures what Code Mode records on the active tools/call span. The MCP
   * handler's own request attributes use setAttribute and are ignored here.
   */
  function captureSpan(): Record<string, unknown> {
    const attributes: Record<string, unknown> = {};
    const span = {
      setAttribute: () => {},
      setAttributes: (values: Record<string, unknown>) =>
        Object.assign(attributes, values),
    };
    vi.spyOn(Sentry, "getActiveSpan").mockReturnValue(
      span as unknown as ReturnType<typeof Sentry.getActiveSpan>,
    );
    return attributes;
  }

  it("records the executed code and each operation by path template", async () => {
    const attributes = captureSpan();
    const count = vi.spyOn(Sentry.metrics, "count");
    const code = `async () => {
      await sentry.request({path: "/organizations/code-mode-org/projects/"});
      await sentry.request({method: "PUT", path: "/projects/code-mode-org/web/monitors/billing/", body: {name: "Billing"}});
      await sentry.request({path: "/organizations/code-mode-org/not-published/"}).catch(() => {});
      return "done";
    }`;
    const result = await execute(code, {
      props: { grantedSkills: ["api-write"] },
    });
    expect(result.isError).toBeUndefined();
    expect(attributes).toMatchObject({
      "gen_ai.tool.call.arguments.code": code,
      "app.code_mode.outcome": "ok",
      "app.code_mode.spec_version": SPEC_VERSION,
      "app.code_mode.api_calls": 3,
      "app.code_mode.writes": 1,
    });
    expect(JSON.parse(String(attributes["app.code_mode.operations"]))).toEqual([
      "GET /api/0/organizations/{organization_id_or_slug}/projects/ 200",
      `PUT ${monitorPath} 200`,
      "GET unknown 403 denied",
    ]);
    expect(count).toHaveBeenCalledWith("app.code_mode.execution", 1, {
      attributes: { tool: "execute_sentry_code", outcome: "ok" },
    });
    expect(count).toHaveBeenCalledWith("app.code_mode.request", 1, {
      attributes: {
        method: "PUT",
        operation: monitorPath,
        status: 200,
        denied: false,
      },
    });
    expect(count).toHaveBeenCalledWith("app.code_mode.request", 1, {
      attributes: {
        method: "GET",
        operation: "unknown",
        status: 403,
        denied: true,
      },
    });
  });

  it("records search code without API attributes", async () => {
    const attributes = captureSpan();
    const code = "async () => Object.keys(spec.paths).length";
    const result = await search(code);
    expect(result.structuredContent?.result).toBe(
      Object.keys(JSON.parse(SPEC_TEXT).paths).length,
    );
    expect(attributes).toEqual({
      "gen_ai.tool.call.arguments.code": code,
      "app.code_mode.outcome": "ok",
      "app.code_mode.spec_version": SPEC_VERSION,
    });
  });

  it("does not report program errors as issues", async () => {
    const logIssue = vi.spyOn(logging, "logIssue");
    const attributes = captureSpan();
    const result = await execute(
      'async () => { throw new Error("Program failed"); }',
    );
    expect(result.isError).toBe(true);
    expect(logIssue).not.toHaveBeenCalled();
    expect(attributes["app.code_mode.outcome"]).toBe("error");
  });

  it("reports internal failures as issues and returns the event ID", async () => {
    const logIssue = vi
      .spyOn(logging, "logIssue")
      .mockReturnValue("internal-event");
    const attributes = captureSpan();
    const loader = {
      load() {
        throw new Error("Loader unavailable");
      },
    } as unknown as WorkerLoader;
    const result = await execute('async () => "never runs"', {
      env: { LOADER: loader },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Loader unavailable");
    expect(result.content[0]?.text).toContain("Event ID: internal-event");
    // Failures outside the sandbox keep the tool's declared output shape.
    expect(result.structuredContent).toEqual({
      error: expect.stringContaining("Event ID: internal-event"),
      stats: { apiCalls: 0, writesAttempted: 0 },
    });
    expect(logIssue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "Loader unavailable" }),
      {
        loggerScope: ["code-mode", "execution"],
        extra: { tool: "execute_sentry_code", specVersion: SPEC_VERSION },
      },
    );
    expect(attributes["app.code_mode.outcome"]).toBe("internal_error");
  });
});
