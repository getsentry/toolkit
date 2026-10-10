import type { ExecutionContext, RateLimit } from "@cloudflare/workers-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DIRECT_AUTH_ASSERTION_TOKEN } from "../../test-utils/fetch-mock-setup";
import type { Env } from "../types";

const { sentryMetricsCount, sentrySetUser } = vi.hoisted(() => ({
  sentryMetricsCount: vi.fn(),
  sentrySetUser: vi.fn(),
}));

vi.mock("@sentry/cloudflare", () => ({
  getActiveSpan: vi.fn(() => undefined),
  getIsolationScope: vi.fn(() => ({ setAttributes: vi.fn() })),
  metrics: {
    count: sentryMetricsCount,
  },
  setUser: sentrySetUser,
}));

import mcpHandler, { handleSentryBearerMcpRequest } from "./mcp-handler";
import {
  OAUTH_GRANT_AGE_BUCKET_ATTRIBUTE,
  OAUTH_GRANT_REVOKED_REASON_ATTRIBUTE,
  OAUTH_UPSTREAM_EXPIRES_IN_BUCKET_ATTRIBUTE,
} from "../oauth/telemetry";

interface OAuthProps {
  id: string;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  sessionStartedAt?: number;
  upstreamExpiresAt?: number;
  grantedSkills: string[];
  constraintOrganizationSlug?: string | null;
  constraintProjectSlug?: string | null;
}

const DEFAULT_OAUTH_PROPS: OAuthProps = {
  id: "test-user-123",
  clientId: "test-client",
  accessToken: "test-access-token",
  refreshToken: "test-refresh-token",
  grantedSkills: ["inspect", "docs"],
};

function createMcpContext(
  props: Partial<OAuthProps> = {},
): ExecutionContext & { props: OAuthProps } {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {
      ...DEFAULT_OAUTH_PROPS,
      ...props,
    },
  } as ExecutionContext & { props: OAuthProps };
}

function createMcpRequest(
  method: string,
  params: Record<string, unknown> = {},
  options: {
    path?: string;
    id?: number | string;
    bearerToken?: string;
    headers?: Record<string, string>;
  } = {},
): Request {
  const { path = "/mcp", id = 1, bearerToken } = options;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "CF-Connecting-IP": "192.0.2.1",
    Host: "localhost",
    ...options.headers,
  };
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }

  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
      id,
    }),
  });
}

async function parseSSEResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) {
    throw new Error(`No data line found in SSE response: ${text}`);
  }
  return JSON.parse(dataLine.slice(6)) as T;
}

function createTestEnv(): Env {
  return {
    COOKIE_SECRET: "test-cookie-secret-32-characters",
    SENTRY_CLIENT_ID: "test-client-id",
    SENTRY_CLIENT_SECRET: "test-client-secret",
    SENTRY_HOST: "sentry.io",
    OPENROUTER_API_KEY: "test-openrouter-key",
    OPENROUTER_MODEL: "openai/gpt-5.6-luna",
    EMBEDDED_AGENT_PROVIDER: "openrouter",
    OAUTH_KV: {} as KVNamespace,
    OAUTH_PROVIDER: {
      listUserGrants: vi.fn().mockResolvedValue({ items: [] }),
      revokeGrant: vi.fn().mockResolvedValue(undefined),
    } as unknown as Env["OAUTH_PROVIDER"],
  } as Env;
}

describe("MCP Handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sentryMetricsCount.mockReset();
    sentrySetUser.mockReset();
  });

  describe("authentication", () => {
    it("should reject requests without auth context", async () => {
      const request = createMcpRequest("tools/list");
      const ctx = {
        waitUntil: () => {},
        passThroughOnException: () => {},
      } as ExecutionContext;

      await expect(
        mcpHandler.fetch!(request, createTestEnv(), ctx),
      ).rejects.toThrow("No authentication context");
    });

    it("should reject legacy tokens without grantedSkills", async () => {
      const now = Date.now();
      const request = createMcpRequest(
        "tools/list",
        {},
        {
          bearerToken: "test-user-123:legacy-grant-id:secret",
        },
      );
      const ctx = createMcpContext({
        grantedSkills: undefined as unknown as string[],
        sessionStartedAt: now - 2 * 24 * 60 * 60 * 1000,
        upstreamExpiresAt: now + 3 * 24 * 60 * 60 * 1000,
      });
      (ctx.props as Record<string, unknown>).grantedScopes = [
        "org:read",
        "project:read",
      ];
      (ctx.props as Record<string, unknown>).grantedSkills = undefined;

      const response = await mcpHandler.fetch!(request, createTestEnv(), ctx);

      expect(response.status).toBe(401);
      expect(await response.text()).toContain("re-authorize");
      expect(response.headers.get("WWW-Authenticate")).toContain(
        "invalid_token",
      );
      expect(sentryMetricsCount).toHaveBeenCalledWith(
        "app.oauth.grant_revoked",
        1,
        {
          attributes: expect.objectContaining({
            [OAUTH_GRANT_REVOKED_REASON_ATTRIBUTE]: "stale_props_no_refresh",
            [OAUTH_GRANT_AGE_BUCKET_ATTRIBUTE]: "1d_7d",
            [OAUTH_UPSTREAM_EXPIRES_IN_BUCKET_ATTRIBUTE]: "1d_7d",
          }),
        },
      );
    });

    it("should revoke and reject stale grants missing a refresh token", async () => {
      const now = Date.now();
      const request = createMcpRequest(
        "tools/list",
        {},
        {
          bearerToken: "test-user-123:specific-grant-id:secret",
        },
      );
      const ctx = createMcpContext({
        refreshToken: undefined as unknown as string,
        sessionStartedAt: now - 2 * 24 * 60 * 60 * 1000,
        upstreamExpiresAt: now + 3 * 24 * 60 * 60 * 1000,
      });
      const env = createTestEnv();

      const response = await mcpHandler.fetch!(request, env, ctx);

      expect(response.status).toBe(401);
      expect(await response.text()).toContain("re-authorize");
      expect(response.headers.get("WWW-Authenticate")).toContain(
        "invalid_token",
      );
      expect(ctx.waitUntil).toHaveBeenCalled();
      expect(sentryMetricsCount).toHaveBeenCalledWith(
        "app.oauth.grant_revoked",
        1,
        {
          attributes: expect.objectContaining({
            [OAUTH_GRANT_REVOKED_REASON_ATTRIBUTE]: "stale_props_no_refresh",
            [OAUTH_GRANT_AGE_BUCKET_ATTRIBUTE]: "1d_7d",
            [OAUTH_UPSTREAM_EXPIRES_IN_BUCKET_ATTRIBUTE]: "1d_7d",
          }),
        },
      );

      await (ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(env.OAUTH_PROVIDER.revokeGrant).toHaveBeenCalledTimes(1);
      expect(env.OAUTH_PROVIDER.revokeGrant).toHaveBeenCalledWith(
        "specific-grant-id",
        "test-user-123",
      );
      expect(env.OAUTH_PROVIDER.listUserGrants).not.toHaveBeenCalled();
    });

    it("targets the exact grant when multiple grants exist for the same client", async () => {
      const request = createMcpRequest(
        "tools/list",
        {},
        {
          bearerToken: "test-user-123:request-specific-grant:secret",
        },
      );
      const ctx = createMcpContext({
        refreshToken: undefined as unknown as string,
      });
      const env = createTestEnv();
      (
        env.OAUTH_PROVIDER.listUserGrants as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        items: [
          { id: "other-active-session-grant", clientId: "test-client" },
          { id: "request-specific-grant", clientId: "test-client" },
        ],
      });

      await mcpHandler.fetch!(request, env, ctx);
      await (ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];

      expect(env.OAUTH_PROVIDER.revokeGrant).toHaveBeenCalledExactlyOnceWith(
        "request-specific-grant",
        "test-user-123",
      );
    });

    it("skips revoke when bearer token is missing or malformed", async () => {
      const request = createMcpRequest("tools/list");
      const ctx = createMcpContext({
        refreshToken: undefined as unknown as string,
      });
      const env = createTestEnv();

      const response = await mcpHandler.fetch!(request, env, ctx);
      await (ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];

      expect(response.status).toBe(401);
      expect(env.OAUTH_PROVIDER.revokeGrant).not.toHaveBeenCalled();
    });

    it("should reject tokens with no valid skills", async () => {
      const request = createMcpRequest("tools/list");
      const ctx = createMcpContext({ grantedSkills: [] });

      const response = await mcpHandler.fetch!(request, createTestEnv(), ctx);

      expect(response.status).toBe(400);
      expect(await response.text()).toContain("No valid skills");
    });

    it("accepts legacy preprod grants as inspect", async () => {
      const request = createMcpRequest("tools/list");
      const ctx = createMcpContext({ grantedSkills: ["preprod"] });

      const response = await mcpHandler.fetch!(request, createTestEnv(), ctx);

      expect(response.status).toBe(200);
      const body = await parseSSEResponse<{
        result?: { tools: Array<{ name: string }> };
      }>(response);
      const toolNames = body.result?.tools.map((tool) => tool.name) ?? [];

      expect(toolNames).toContain("search_traces");
      expect(toolNames).not.toContain("search_docs");
    });

    it("applies the authenticated MCP rate limit per user", async () => {
      const mockUserRateLimiter = {
        limit: vi.fn().mockResolvedValue({ success: true }),
      } as unknown as RateLimit;
      const request = createMcpRequest("tools/list");
      const ctx = createMcpContext();
      const env = createTestEnv();
      env.MCP_USER_RATE_LIMITER = mockUserRateLimiter;

      const response = await mcpHandler.fetch!(request, env, ctx);

      expect(response.status).toBe(200);
      expect(mockUserRateLimiter.limit).toHaveBeenCalledWith({
        key: expect.stringMatching(/^mcp:user:[0-9a-f]{16}$/),
      });
    });

    it("returns 429 when the authenticated user exceeds the MCP rate limit", async () => {
      const request = createMcpRequest("tools/list");
      const ctx = createMcpContext();
      const env = createTestEnv();
      env.MCP_USER_RATE_LIMITER = {
        limit: vi.fn().mockResolvedValue({ success: false }),
      } as unknown as RateLimit;

      const response = await mcpHandler.fetch!(request, env, ctx);

      expect(response.status).toBe(429);
      expect(await response.text()).toContain("Rate limit exceeded");
    });

    it("accepts Sentry-Bearer direct tokens without OAuth props or refresh tokens", async () => {
      const request = createMcpRequest("tools/list");
      const ctx = {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext;

      const response = await handleSentryBearerMcpRequest(
        request,
        createTestEnv(),
        ctx,
        "sntryu_test-token",
      );

      expect(response.status).toBe(200);
      const body = await parseSSEResponse<{
        result?: { tools: Array<{ name: string }> };
      }>(response);
      const toolNames = body.result?.tools.map((tool) => tool.name) ?? [];

      expect(toolNames).toContain("search_traces");
      expect(toolNames).toContain("update_issue");
    });

    it("passes direct tokens and sanitized UTM source to upstream Sentry API calls", async () => {
      const request = createMcpRequest(
        "tools/call",
        {
          name: "execute_sentry_tool",
          arguments: {
            name: "whoami",
            arguments: {},
          },
        },
        { headers: { "X-Sentry-Utm-Source": "plugin" } },
      );
      const ctx = {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext;
      const env = createTestEnv();
      env.SENTRY_HOST = "direct-token.test";

      const response = await handleSentryBearerMcpRequest(
        request,
        env,
        ctx,
        DIRECT_AUTH_ASSERTION_TOKEN,
      );

      expect(response.status).toBe(200);
      const structuredContent = {
        user: {
          id: "123456",
          name: "Test User",
          email: "test@example.com",
        },
        sessionConstraints: null,
      };
      const body = await parseSSEResponse<{
        jsonrpc: "2.0";
        id: number;
        result: {
          content: Array<{ type: "text"; text: string }>;
          structuredContent: typeof structuredContent;
        };
      }>(response);

      expect(body).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(structuredContent, null, 2),
            },
          ],
          structuredContent,
        },
      });
    });

    it("applies the Sentry-Bearer MCP rate limit per token", async () => {
      const mockTokenRateLimiter = {
        limit: vi.fn().mockResolvedValue({ success: true }),
      } as unknown as RateLimit;
      const request = createMcpRequest("tools/list");
      const ctx = {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext;
      const env = createTestEnv();
      env.MCP_USER_RATE_LIMITER = mockTokenRateLimiter;

      const response = await handleSentryBearerMcpRequest(
        request,
        env,
        ctx,
        "sntryu_test-token",
      );

      expect(response.status).toBe(200);
      expect(mockTokenRateLimiter.limit).toHaveBeenCalledWith({
        key: expect.stringMatching(/^mcp:sentry-token:[0-9a-f]{16}$/),
      });
    });

    it("returns 429 with Sentry-Bearer scope when a direct token exceeds the MCP rate limit", async () => {
      const request = createMcpRequest("tools/list");
      const ctx = {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext;
      const env = createTestEnv();
      env.MCP_USER_RATE_LIMITER = {
        limit: vi.fn().mockResolvedValue({ success: false }),
      } as unknown as RateLimit;

      const response = await handleSentryBearerMcpRequest(
        request,
        env,
        ctx,
        "sntryu_test-token",
      );

      expect(response.status).toBe(429);
      expect(await response.text()).toContain("Rate limit exceeded");
      expect(response.headers.get("x-sentry-rate-limit-scope")).toBe(
        "sentry_access",
      );
    });

    it("narrows Sentry-Bearer tools with direct skills query params", async () => {
      const request = createMcpRequest(
        "tools/list",
        {},
        { path: "/mcp?skills=inspect" },
      );
      const ctx = {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext;

      const response = await handleSentryBearerMcpRequest(
        request,
        createTestEnv(),
        ctx,
        "sntryu_test-token",
      );

      expect(response.status).toBe(200);
      const body = await parseSSEResponse<{
        result?: { tools: Array<{ name: string }> };
      }>(response);
      const toolNames = body.result?.tools.map((tool) => tool.name) ?? [];

      expect(toolNames).toContain("search_traces");
      expect(toolNames).not.toContain("update_issue");
    });

    it("removes Sentry-Bearer tools with direct disable-skills query params", async () => {
      const request = createMcpRequest(
        "tools/list",
        {},
        { path: "/mcp?disable-skills=triage" },
      );
      const ctx = {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext;

      const response = await handleSentryBearerMcpRequest(
        request,
        createTestEnv(),
        ctx,
        "sntryu_test-token",
      );

      expect(response.status).toBe(200);
      const body = await parseSSEResponse<{
        result?: { tools: Array<{ name: string }> };
      }>(response);
      const toolNames = body.result?.tools.map((tool) => tool.name) ?? [];

      expect(toolNames).toContain("search_traces");
      expect(toolNames).not.toContain("update_issue");
    });

    it("rejects invalid Sentry-Bearer skills query params", async () => {
      const request = createMcpRequest(
        "tools/list",
        {},
        { path: "/mcp?skills=bogus" },
      );
      const ctx = {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext;

      const response = await handleSentryBearerMcpRequest(
        request,
        createTestEnv(),
        ctx,
        "sntryu_test-token",
      );

      expect(response.status).toBe(400);
      expect(await response.text()).toContain("invalid skills");
    });

    it("rejects empty Sentry-Bearer skills query params", async () => {
      const request = createMcpRequest(
        "tools/list",
        {},
        { path: "/mcp?skills=" },
      );
      const ctx = {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext;

      const response = await handleSentryBearerMcpRequest(
        request,
        createTestEnv(),
        ctx,
        "sntryu_test-token",
      );

      expect(response.status).toBe(400);
      expect(await response.text()).toContain(
        "skills must include at least one valid skill",
      );
    });
  });

  describe("URL constraints", () => {
    it("should handle /mcp without constraints", async () => {
      const request = createMcpRequest(
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
        { path: "/mcp" },
      );
      const ctx = createMcpContext();

      const response = await mcpHandler.fetch!(request, createTestEnv(), ctx);

      expect(response.status).toBe(200);
      const body = await parseSSEResponse<{
        result?: { protocolVersion: string };
      }>(response);
      expect(body.result?.protocolVersion).toBeDefined();
    });

    it("should return 404 for invalid URL pattern", async () => {
      const request = new Request("http://localhost/invalid-path", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
      });
      const ctx = createMcpContext();

      const response = await mcpHandler.fetch!(request, createTestEnv(), ctx);

      expect(response.status).toBe(404);
    });

    it("should handle /mcp/:org with valid organization", async () => {
      const request = createMcpRequest(
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
        { path: "/mcp/sentry-mcp-evals" },
      );
      const ctx = createMcpContext();

      const response = await mcpHandler.fetch!(request, createTestEnv(), ctx);

      expect(response.status).toBe(200);
      const body = await parseSSEResponse<{
        result?: { protocolVersion: string };
      }>(response);
      expect(body.result?.protocolVersion).toBeDefined();
    });

    it("should return 404 for non-existent organization", async () => {
      const request = createMcpRequest(
        "initialize",
        {},
        { path: "/mcp/nonexistent-org" },
      );
      const ctx = createMcpContext();

      const response = await mcpHandler.fetch!(request, createTestEnv(), ctx);

      expect(response.status).toBe(404);
      expect(await response.text()).toContain("not found");
    });

    it("does not pre-verify Sentry-Bearer URL constraints", async () => {
      const request = createMcpRequest(
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
        { path: "/mcp/nonexistent-org" },
      );
      const ctx = {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext;

      const response = await handleSentryBearerMcpRequest(
        request,
        createTestEnv(),
        ctx,
        "sntryu_test-token",
      );

      expect(response.status).toBe(200);
      const body = await parseSSEResponse<{
        result?: { protocolVersion: string };
      }>(response);
      expect(body.result?.protocolVersion).toBeDefined();
    });

    it("returns 403 when the token is org-scoped but the MCP URL uses a different organization", async () => {
      const request = createMcpRequest(
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
        { path: "/mcp/other-org" },
      );
      const ctx = createMcpContext({
        constraintOrganizationSlug: "my-org",
      });

      const response = await mcpHandler.fetch!(request, createTestEnv(), ctx);

      expect(response.status).toBe(403);
      expect(await response.text()).toContain("scoped to an organization");
    });

    it("returns 403 when the token is project-scoped but the MCP URL uses a different project", async () => {
      const request = createMcpRequest(
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
        { path: "/mcp/my-org/wrong-project" },
      );
      const ctx = createMcpContext({
        constraintOrganizationSlug: "my-org",
        constraintProjectSlug: "expected-project",
      });

      const response = await mcpHandler.fetch!(request, createTestEnv(), ctx);

      expect(response.status).toBe(403);
      expect(await response.text()).toContain("scoped to a project");
    });

    it("returns 403 when the token is project-scoped but the MCP URL omits the project segment", async () => {
      const request = createMcpRequest(
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
        { path: "/mcp/my-org" },
      );
      const ctx = createMcpContext({
        constraintOrganizationSlug: "my-org",
        constraintProjectSlug: "my-project",
      });

      const response = await mcpHandler.fetch!(request, createTestEnv(), ctx);

      expect(response.status).toBe(403);
      expect(await response.text()).toContain("scoped to a project");
    });
  });

  describe("MCP protocol", () => {
    it("should respond to tools/list with available tools", async () => {
      const request = createMcpRequest("tools/list");
      const ctx = createMcpContext();

      const response = await mcpHandler.fetch!(request, createTestEnv(), ctx);

      expect(response.status).toBe(200);
      const body = await parseSSEResponse<{
        result?: { tools: Array<{ name: string }> };
      }>(response);
      expect(body.result?.tools).toBeDefined();
      expect(Array.isArray(body.result?.tools)).toBe(true);
      expect(body.result?.tools.length).toBeGreaterThan(0);
    });

    it("should filter tools based on granted skills", async () => {
      const request = createMcpRequest("tools/list");
      const ctx = createMcpContext({ grantedSkills: ["docs"] });

      const response = await mcpHandler.fetch!(request, createTestEnv(), ctx);

      expect(response.status).toBe(200);
      const body = await parseSSEResponse<{
        result?: { tools: Array<{ name: string }> };
      }>(response);
      const toolNames = body.result?.tools.map((tool) => tool.name) ?? [];

      expect(toolNames).toContain("search_sentry_tools");
      expect(toolNames).not.toContain("search_docs");
      expect(toolNames).not.toContain("get_doc");
      expect(toolNames).not.toContain("get_issue_details");

      const searchRequest = createMcpRequest("tools/call", {
        name: "search_sentry_tools",
        arguments: {
          query: "documentation",
          limit: 10,
        },
      });

      const searchResponse = await mcpHandler.fetch!(
        searchRequest,
        createTestEnv(),
        ctx,
      );

      expect(searchResponse.status).toBe(200);
      const searchBody = await parseSSEResponse<{
        result?: {
          structuredContent?: { results?: Array<{ name: string }> };
        };
      }>(searchResponse);
      const catalogToolNames =
        searchBody.result?.structuredContent?.results?.map(
          (tool) => tool.name,
        ) ?? [];

      expect(catalogToolNames).toContain("search_docs");
      expect(catalogToolNames).toContain("get_doc");
    });
  });
});
