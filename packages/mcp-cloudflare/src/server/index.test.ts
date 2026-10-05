import type { ExecutionContext } from "@cloudflare/workers-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./types";

const {
  MockOAuthProvider,
  mockOAuthProviderFetch,
  mockHandleSentryBearerMcpRequest,
  mockGetClientIp,
  mockCheckRateLimit,
  mockActiveSpan,
  mockMetricsCount,
} = vi.hoisted(() => {
  const mockOAuthProviderFetch = vi.fn();
  const MockOAuthProvider = vi.fn(function MockOAuthProvider() {
    return { fetch: mockOAuthProviderFetch };
  });
  const mockGetClientIp = vi.fn<(request: Request) => string | null>(
    () => null,
  );

  return {
    MockOAuthProvider,
    mockOAuthProviderFetch,
    mockHandleSentryBearerMcpRequest: vi.fn(),
    mockGetClientIp,
    mockCheckRateLimit: vi.fn(),
    mockActiveSpan: {
      setAttribute: vi.fn(),
    },
    mockMetricsCount: vi.fn(),
  };
});

vi.mock("@cloudflare/workers-oauth-provider", () => ({
  default: MockOAuthProvider,
}));

vi.mock("@sentry/cloudflare", () => ({
  getActiveSpan: vi.fn(() => mockActiveSpan),
  metrics: {
    count: mockMetricsCount,
  },
  setUser: vi.fn(),
  withSentry: vi.fn((_config, handler) => handler),
}));

vi.mock("./app", () => ({
  default: { fetch: vi.fn() },
}));

vi.mock("./lib/mcp-handler", () => ({
  default: { fetch: vi.fn() },
  handleSentryBearerMcpRequest: mockHandleSentryBearerMcpRequest,
}));

vi.mock("./oauth", () => ({
  tokenExchangeCallback: vi.fn(),
}));

vi.mock("./sentry.config", () => ({
  default: vi.fn(() => ({})),
}));

vi.mock("./utils/client-ip", () => ({
  getClientIp: mockGetClientIp,
}));

vi.mock("./utils/rate-limiter", () => ({
  checkRateLimit: mockCheckRateLimit,
  MCP_RATE_LIMIT_EXCEEDED_MESSAGE:
    "Rate limit exceeded. Please wait before trying again.",
}));

import handler from "./index";
import {
  OAUTH_ERROR_ATTRIBUTE,
  OAUTH_ERROR_REASON_ATTRIBUTE,
  OAUTH_REQUEST_HEADER_SHAPE_ATTRIBUTE,
} from "./oauth/telemetry";

describe("worker entrypoint", () => {
  const env = {
    MCP_RATE_LIMITER: {},
  } as Env;
  const ctx = {
    props: undefined,
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetClientIp.mockReturnValue(null);
    mockCheckRateLimit.mockResolvedValue({ allowed: true });
  });

  it("returns restrictive preflight CORS for public metadata endpoints", async () => {
    const response = await handler.fetch!(
      new Request(
        "https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp",
        { method: "OPTIONS" },
      ),
      env,
      ctx,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, OPTIONS",
    );
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
      "Content-Type",
    );
    expect(MockOAuthProvider).not.toHaveBeenCalled();
  });

  it("does not expose root protected resource metadata", async () => {
    const response = await handler.fetch!(
      new Request(
        "https://mcp.sentry.dev/.well-known/oauth-protected-resource",
      ),
      env,
      ctx,
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(MockOAuthProvider).not.toHaveBeenCalled();
  });

  it("serves path-scoped protected resource metadata before the oauth provider", async () => {
    const response = await handler.fetch!(
      new Request(
        "https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp/sentry/mcp-server?experimental=1",
      ),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      resource: "https://mcp.sentry.dev/mcp/sentry/mcp-server?experimental=1",
      authorization_servers: ["https://mcp.sentry.dev"],
      scopes_supported: [
        "org:read",
        "project:write",
        "team:write",
        "event:write",
        "alerts:write",
      ],
      bearer_methods_supported: ["header"],
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(MockOAuthProvider).not.toHaveBeenCalled();
  });

  it("strips CORS headers from non-public OAuth endpoints", async () => {
    mockOAuthProviderFetch.mockResolvedValueOnce(
      new Response("ok", {
        headers: {
          "Access-Control-Allow-Origin": "https://evil.com",
          "Access-Control-Allow-Methods": "*",
          "Access-Control-Allow-Headers": "Authorization, *",
          "Access-Control-Max-Age": "86400",
          "Access-Control-Expose-Headers": "X-Trace-Id",
        },
      }),
    );

    const response = await handler.fetch!(
      new Request("https://mcp.sentry.dev/oauth/token"),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
    expect(response.headers.has("Access-Control-Allow-Methods")).toBe(false);
    expect(response.headers.has("Access-Control-Allow-Headers")).toBe(false);
    expect(response.headers.has("Access-Control-Max-Age")).toBe(false);
    expect(response.headers.has("Access-Control-Expose-Headers")).toBe(false);
  });

  it("enables Client ID Metadata Documents on the oauth provider", async () => {
    mockOAuthProviderFetch.mockResolvedValueOnce(new Response("ok"));

    await handler.fetch!(
      new Request("https://mcp.sentry.dev/oauth/token"),
      env,
      ctx,
    );

    expect(MockOAuthProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        clientIdMetadataDocumentEnabled: true,
        clientRegistrationEndpoint: "/oauth/register",
      }),
    );
  });

  it("does not advertise RFC 9207 iss support on root authorization server metadata", async () => {
    mockOAuthProviderFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          issuer: "https://mcp.sentry.dev",
          authorization_endpoint: "https://mcp.sentry.dev/oauth/authorize",
          token_endpoint: "https://mcp.sentry.dev/oauth/token",
          client_id_metadata_document_supported: true,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const response = await handler.fetch!(
      new Request(
        "https://mcp.sentry.dev/.well-known/oauth-authorization-server",
      ),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      issuer: "https://mcp.sentry.dev",
      authorization_endpoint: "https://mcp.sentry.dev/oauth/authorize",
      token_endpoint: "https://mcp.sentry.dev/oauth/token",
      client_id_metadata_document_supported: true,
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("leaves non-metadata provider responses unchanged when patching root AS metadata", async () => {
    mockOAuthProviderFetch.mockResolvedValueOnce(
      new Response("ok", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    const response = await handler.fetch!(
      new Request("https://mcp.sentry.dev/oauth/token"),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("patches MCP 401 responses with protected resource metadata", async () => {
    mockOAuthProviderFetch.mockResolvedValueOnce(
      new Response("unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Bearer error="invalid_token"',
          "Access-Control-Allow-Origin": "https://evil.com",
        },
      }),
    );

    const response = await handler.fetch!(
      new Request("https://mcp.sentry.dev/mcp"),
      env,
      ctx,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe(
      'Bearer error="invalid_token", resource_metadata="https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp"',
    );
    expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
  });

  it("passes tracked app responses through the default handler", async () => {
    mockOAuthProviderFetch.mockResolvedValueOnce(new Response("ok"));

    const response = await handler.fetch!(
      new Request("https://mcp.sentry.dev/api/chat", { method: "POST" }),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
  });

  it("routes Sentry-Bearer MCP requests directly without OAuth", async () => {
    mockHandleSentryBearerMcpRequest.mockResolvedValueOnce(new Response("ok"));

    const request = new Request("https://mcp.sentry.dev/mcp", {
      method: "POST",
      headers: {
        Authorization: "Sentry-Bearer sntryu_test-token",
        "User-Agent": "Claude-Code/1.0",
      },
    });

    const response = await handler.fetch!(request, env, ctx);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(mockHandleSentryBearerMcpRequest).toHaveBeenCalledWith(
      request,
      env,
      ctx,
      "sntryu_test-token",
    );
    expect(MockOAuthProvider).not.toHaveBeenCalled();
  });

  it("rejects malformed Sentry-Bearer MCP authorization without OAuth", async () => {
    const response = await handler.fetch!(
      new Request("https://mcp.sentry.dev/mcp", {
        method: "POST",
        headers: {
          Authorization: "Sentry-Bearer",
        },
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(401);
    expect(await response.text()).toContain("Missing or invalid");
    expect(response.headers.get("WWW-Authenticate")).toContain("Sentry-Bearer");
    expect(mockHandleSentryBearerMcpRequest).not.toHaveBeenCalled();
    expect(MockOAuthProvider).not.toHaveBeenCalled();
  });

  it("rejects Sentry-Bearer MCP authorization with extra credentials without OAuth", async () => {
    const response = await handler.fetch!(
      new Request("https://mcp.sentry.dev/mcp", {
        method: "POST",
        headers: {
          Authorization: "Sentry-Bearer sntryu_test-token extra",
        },
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(401);
    expect(await response.text()).toContain("Missing or invalid");
    expect(response.headers.get("WWW-Authenticate")).toContain("Sentry-Bearer");
    expect(mockHandleSentryBearerMcpRequest).not.toHaveBeenCalled();
    expect(MockOAuthProvider).not.toHaveBeenCalled();
  });

  it("returns 429 when MCP/OAuth IP limiting blocks the request", async () => {
    mockGetClientIp.mockReturnValue("192.0.2.1");
    mockCheckRateLimit.mockResolvedValueOnce({
      allowed: false,
      errorMessage: "Rate limit exceeded. Please wait before trying again.",
    });

    const response = await handler.fetch!(
      new Request("https://mcp.sentry.dev/oauth/token", { method: "POST" }),
      env,
      ctx,
    );

    expect(response.status).toBe(429);
  });

  it("patches scoped MCP 401 responses with path-specific protected resource metadata", async () => {
    mockOAuthProviderFetch.mockResolvedValueOnce(
      new Response("unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Bearer error="invalid_token"',
        },
      }),
    );

    const response = await handler.fetch!(
      new Request(
        "https://mcp.sentry.dev/mcp/sentry/mcp-server?experimental=1",
      ),
      env,
      ctx,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe(
      'Bearer error="invalid_token", resource_metadata="https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp/sentry/mcp-server?experimental=1"',
    );
  });

  // Regression: unauthenticated plugin MCP URLs must challenge with PRM that
  // preserves ?utm_source=plugin so OAuth discovery keeps the same resource.
  it("patches plugin utm_source MCP 401 responses with query-preserving protected resource metadata", async () => {
    mockOAuthProviderFetch.mockResolvedValueOnce(
      new Response("unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Bearer error="invalid_token"',
        },
      }),
    );

    const response = await handler.fetch!(
      new Request("https://mcp.sentry.dev/mcp?utm_source=plugin"),
      env,
      ctx,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe(
      'Bearer error="invalid_token", resource_metadata="https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp?utm_source=plugin"',
    );
  });

  it("patches organization-scoped MCP 401 responses with path-specific protected resource metadata", async () => {
    mockOAuthProviderFetch.mockResolvedValueOnce(
      new Response("unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Bearer error="invalid_token"',
        },
      }),
    );

    const response = await handler.fetch!(
      new Request("https://mcp.sentry.dev/mcp/sentry"),
      env,
      ctx,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe(
      'Bearer error="invalid_token", resource_metadata="https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp/sentry"',
    );
  });

  it("replaces an existing resource_metadata with the path-specific one (RFC 9110 §11.2)", async () => {
    // The Cloudflare OAuth provider library emits its own resource_metadata
    // pointing at the origin (which 404s on this deployment). We must replace
    // it rather than append, so the challenge contains exactly one
    // resource_metadata parameter.
    mockOAuthProviderFetch.mockResolvedValueOnce(
      new Response("unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate":
            'Bearer realm="OAuth", resource_metadata="https://mcp.sentry.dev/.well-known/oauth-protected-resource", error="invalid_token", error_description="Missing or invalid access token"',
        },
      }),
    );

    const response = await handler.fetch!(
      new Request("https://mcp.sentry.dev/mcp"),
      env,
      ctx,
    );

    expect(response.status).toBe(401);
    const header = response.headers.get("WWW-Authenticate")!;
    expect(header).toBe(
      'Bearer realm="OAuth", error="invalid_token", error_description="Missing or invalid access token", resource_metadata="https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp"',
    );
    // Defensive: ensure resource_metadata only appears once.
    expect(header.match(/resource_metadata\s*=/gi)?.length).toBe(1);
  });

  it("removes pre-existing resource_metadata even when it appears first in the challenge", async () => {
    mockOAuthProviderFetch.mockResolvedValueOnce(
      new Response("unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate":
            'Bearer resource_metadata="https://mcp.sentry.dev/.well-known/oauth-protected-resource", error="invalid_token"',
        },
      }),
    );

    const response = await handler.fetch!(
      new Request("https://mcp.sentry.dev/mcp"),
      env,
      ctx,
    );

    expect(response.status).toBe(401);
    const header = response.headers.get("WWW-Authenticate")!;
    expect(header).toBe(
      'Bearer error="invalid_token", resource_metadata="https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp"',
    );
    expect(header.match(/resource_metadata\s*=/gi)?.length).toBe(1);
  });

  it("rejects client registration with a userinfo-spoofed redirect URI", async () => {
    const response = await handler.fetch!(
      new Request("https://mcp.sentry.dev/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Sentry MCP",
          redirect_uris: ["https://mcp.sentry.dev@example.io/callback"],
        }),
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_redirect_uri");
    expect(mockOAuthProviderFetch).not.toHaveBeenCalled();
  });

  it("allows client registration with legitimate redirect URIs", async () => {
    mockOAuthProviderFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ client_id: "abc" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const response = await handler.fetch!(
      new Request("https://mcp.sentry.dev/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Test Client",
          redirect_uris: ["https://example.com/callback"],
        }),
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(201);
    expect(mockOAuthProviderFetch).toHaveBeenCalled();
  });

  it("ignores commas inside quoted error_description values when parsing the challenge", async () => {
    mockOAuthProviderFetch.mockResolvedValueOnce(
      new Response("unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate":
            'Bearer realm="OAuth", resource_metadata="https://mcp.sentry.dev/.well-known/oauth-protected-resource", error="invalid_token", error_description="Missing, invalid, or expired access token"',
        },
      }),
    );

    const response = await handler.fetch!(
      new Request("https://mcp.sentry.dev/mcp"),
      env,
      ctx,
    );

    expect(response.status).toBe(401);
    const header = response.headers.get("WWW-Authenticate")!;
    expect(header).toBe(
      'Bearer realm="OAuth", error="invalid_token", error_description="Missing, invalid, or expired access token", resource_metadata="https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp"',
    );
    expect(header.match(/resource_metadata\s*=/gi)?.length).toBe(1);
  });

  it("annotates OAuth provider invalid-token responses without logging token values", async () => {
    mockOAuthProviderFetch.mockResolvedValueOnce(
      new Response("unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate":
            'Bearer realm="OAuth", resource_metadata="https://mcp.sentry.dev/.well-known/oauth-protected-resource", error="invalid_token", error_description="Missing or invalid access token"',
        },
      }),
    );

    const response = await handler.fetch!(
      new Request("https://mcp.sentry.dev/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer user-id:grant-id:secret",
          "User-Agent": "Claude-Code/1.0",
        },
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(401);
    expect(mockActiveSpan.setAttribute).toHaveBeenCalledWith(
      OAUTH_ERROR_ATTRIBUTE,
      "invalid_access",
    );
    expect(mockActiveSpan.setAttribute).toHaveBeenCalledWith(
      OAUTH_ERROR_REASON_ATTRIBUTE,
      "missing_or_invalid_access",
    );
    expect(mockActiveSpan.setAttribute).toHaveBeenCalledWith(
      OAUTH_REQUEST_HEADER_SHAPE_ATTRIBUTE,
      "wrapper",
    );
    expect(mockMetricsCount).toHaveBeenCalledWith("app.server.response", 1, {
      attributes: expect.objectContaining({
        "app.client.family": "claude-code",
        [OAUTH_ERROR_ATTRIBUTE]: "invalid_access",
        [OAUTH_ERROR_REASON_ATTRIBUTE]: "missing_or_invalid_access",
        [OAUTH_REQUEST_HEADER_SHAPE_ATTRIBUTE]: "wrapper",
        "http.response.status_code": 401,
      }),
    });
  });
});
