import type { TokenExchangeCallbackOptions } from "@cloudflare/workers-oauth-provider";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerProps } from "../types";
const { logIssue, logWarn, sentryMetricsCount, sentrySetUser } = vi.hoisted(
  () => ({
    logIssue: vi.fn(),
    logWarn: vi.fn(),
    sentryMetricsCount: vi.fn(),
    sentrySetUser: vi.fn(),
  }),
);

vi.mock("@sentry/mcp-core/telem/logging", () => ({
  logIssue,
  logWarn,
}));

vi.mock("@sentry/cloudflare", () => ({
  metrics: {
    count: sentryMetricsCount,
  },
  setUser: sentrySetUser,
}));

import {
  OAUTH_GRANT_AGE_BUCKET_ATTRIBUTE,
  OAUTH_GRANT_SHAPE_ATTRIBUTE,
  OAUTH_REFRESH_OUTCOME_ATTRIBUTE,
  OAUTH_UPSTREAM_EXPIRES_IN_BUCKET_ATTRIBUTE,
} from "./telemetry";
import {
  appendAuthorizationResponseIss,
  createResourceValidationError,
  exchangeCodeForAccessToken,
  getAuthorizationServerIssuer,
  getOAuthCallbackFailureDetails,
  getTokenExchangeFailureDetails,
  tokenExchangeCallback,
  validateResourceParameter,
} from "./helpers";

const GRANT_TYPES = {
  AUTHORIZATION_CODE:
    "authorization_code" as TokenExchangeCallbackOptions["grantType"],
  REFRESH_TOKEN: "refresh_token" as TokenExchangeCallbackOptions["grantType"],
};

function createRefreshOptions(
  propsOverrides?: Partial<WorkerProps>,
): TokenExchangeCallbackOptions {
  return {
    grantType: GRANT_TYPES.REFRESH_TOKEN,
    clientId: "test-client-id",
    userId: "test-user-id",
    scope: ["org:read", "project:read"],
    requestedScope: ["org:read", "project:read"],
    props: {
      id: "user-id",
      clientId: "test-client-id",
      scope: "org:read project:read",
      accessToken: "old-access-token",
      refreshToken: "old-refresh-token",
      ...propsOverrides,
    } as WorkerProps,
  };
}

const TEST_ENV = { SENTRY_HOST: "sentry.io" };

function createTokenExchangeTelemetryRequest(): Request {
  return new Request("https://mcp.sentry.dev/oauth/token", {
    headers: {
      "CF-Connecting-IP": "192.0.2.1",
    },
  });
}

function callTokenExchangeCallback(
  options: TokenExchangeCallbackOptions,
  clientFamily = "unknown",
): ReturnType<typeof tokenExchangeCallback> {
  return tokenExchangeCallback(
    options,
    TEST_ENV,
    createTokenExchangeTelemetryRequest(),
    clientFamily,
  );
}

describe("tokenExchangeCallback", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    logIssue.mockReset();
    logWarn.mockReset();
    logIssue.mockReturnValue(undefined);
    logWarn.mockReturnValue(undefined);
    sentryMetricsCount.mockReset();
    sentrySetUser.mockReset();
  });

  it("should return undefined for non-refresh_token grant types", async () => {
    const options: TokenExchangeCallbackOptions = {
      grantType: GRANT_TYPES.AUTHORIZATION_CODE,
      clientId: "test-client-id",
      userId: "test-user-id",
      scope: ["org:read", "project:read"],
      requestedScope: ["org:read", "project:read"],
      props: {} as WorkerProps,
    };

    const result = await callTokenExchangeCallback(options);
    expect(result).toBeUndefined();
  });

  it("should return undefined when no refresh token in props", async () => {
    const options = createRefreshOptions({ refreshToken: undefined });

    const result = await callTokenExchangeCallback(options);
    expect(result).toBeUndefined();
  });

  it("sets user ID and IP address for refresh token telemetry", async () => {
    const options = createRefreshOptions({
      accessTokenExpiresAt: Date.now() + 10 * 60 * 1000,
    });
    const request = new Request("https://mcp.sentry.dev/oauth/token", {
      headers: {
        "CF-Connecting-IP": "192.0.2.1",
      },
    });

    await tokenExchangeCallback(options, TEST_ENV, request, "claude");

    expect(sentrySetUser).toHaveBeenCalledWith({
      id: "user-id",
      ip_address: "192.0.2.1",
    });
  });

  it("should mark the grant invalid when the upstream token is truly expired", async () => {
    const pastExpiry = Date.now() - 60 * 1000; // 1 minute ago
    const options = createRefreshOptions({
      accessTokenExpiresAt: pastExpiry,
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "Invalid token" }), {
        status: 401,
      }),
    );

    const result = await callTokenExchangeCallback(options);
    expect(result).toEqual({
      newProps: expect.objectContaining({
        upstreamTokenInvalid: true,
      }),
      accessTokenProps: expect.objectContaining({
        upstreamTokenInvalid: true,
      }),
    });
  });

  it("should mark the grant invalid for 400 probe failures", async () => {
    const pastExpiry = Date.now() - 60 * 1000;
    const options = createRefreshOptions({
      accessTokenExpiresAt: pastExpiry,
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "Invalid token" }), {
        status: 400,
        statusText: "Bad Request",
      }),
    );

    const result = await callTokenExchangeCallback(options);
    expect(result).toEqual({
      newProps: expect.objectContaining({
        upstreamTokenInvalid: true,
      }),
      accessTokenProps: expect.objectContaining({
        upstreamTokenInvalid: true,
      }),
    });
  });

  it("should treat 5xx probe failures as indeterminate", async () => {
    const pastExpiry = Date.now() - 60 * 1000;
    const options = createRefreshOptions({
      accessTokenExpiresAt: pastExpiry,
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "Upstream unavailable" }), {
        status: 503,
        statusText: "Service Unavailable",
      }),
    );

    const result = await callTokenExchangeCallback(options);
    expect(result).toBeUndefined();
  });

  it("should return undefined when upstream probe fails with network error", async () => {
    const pastExpiry = Date.now() - 60 * 1000;
    const options = createRefreshOptions({
      accessTokenExpiresAt: pastExpiry,
    });

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));

    const result = await callTokenExchangeCallback(options);
    expect(result).toBeUndefined();
  });

  it("should treat 429 probe failures as indeterminate", async () => {
    const pastExpiry = Date.now() - 60 * 1000;
    const options = createRefreshOptions({
      accessTokenExpiresAt: pastExpiry,
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "Rate limited" }), {
        status: 429,
        statusText: "Too Many Requests",
      }),
    );

    const result = await callTokenExchangeCallback(options);
    expect(result).toBeUndefined();
  });

  it("should return cached token TTL when token is locally valid", async () => {
    const now = Date.now();
    const futureExpiry = Date.now() + 10 * 60 * 1000;
    const options = createRefreshOptions({
      accessTokenExpiresAt: futureExpiry,
      sessionStartedAt: now - 2 * 24 * 60 * 60 * 1000,
      upstreamExpiresAt: now + 3 * 24 * 60 * 60 * 1000,
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await callTokenExchangeCallback(options);
    expect(result).toEqual({
      newProps: expect.objectContaining({
        accessToken: "old-access-token",
      }),
      accessTokenTTL: expect.any(Number),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sentryMetricsCount).toHaveBeenCalledWith(
      "app.oauth.token_exchange",
      1,
      {
        attributes: expect.objectContaining({
          [OAUTH_REFRESH_OUTCOME_ATTRIBUTE]: "cached_valid_local",
          [OAUTH_GRANT_AGE_BUCKET_ATTRIBUTE]: "1d_7d",
          [OAUTH_UPSTREAM_EXPIRES_IN_BUCKET_ATTRIBUTE]: "1d_7d",
          "app.client.registration.method":
            expect.stringMatching(/^(cimd|dcr|unknown)$/),
        }),
      },
    );
  });

  it("should clear upstreamTokenInvalid after a successful probe", async () => {
    const pastExpiry = Date.now() - 60 * 1000;
    const options = createRefreshOptions({
      accessTokenExpiresAt: pastExpiry,
      upstreamTokenInvalid: true,
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "12345",
          email: "test@example.com",
          name: "Test User",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await callTokenExchangeCallback(options);
    expect(result).toEqual({
      newProps: expect.not.objectContaining({
        upstreamTokenInvalid: true,
      }),
      accessTokenTTL: expect.any(Number),
    });
  });

  it("should mark the grant invalid when a near-expiry token probes invalid", async () => {
    const nearExpiry = Date.now() + 1 * 60 * 1000; // 1 minute from now (< 2 min safety window)
    const options = createRefreshOptions({
      accessTokenExpiresAt: nearExpiry,
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "Invalid token" }), {
        status: 401,
      }),
    );

    const result = await callTokenExchangeCallback(options);
    expect(result).toEqual({
      newProps: expect.objectContaining({
        upstreamTokenInvalid: true,
      }),
      accessTokenProps: expect.objectContaining({
        upstreamTokenInvalid: true,
      }),
    });
  });

  it("should mark the grant invalid when a no-expiry token probes invalid", async () => {
    const options = createRefreshOptions({
      accessTokenExpiresAt: undefined,
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "Invalid token" }), {
        status: 401,
      }),
    );

    const result = await callTokenExchangeCallback(options);
    expect(result).toEqual({
      newProps: expect.objectContaining({
        upstreamTokenInvalid: true,
      }),
      accessTokenProps: expect.objectContaining({
        upstreamTokenInvalid: true,
      }),
    });
    expect(globalThis.fetch).toHaveBeenCalled();
  });
});

describe("exchangeCodeForAccessToken", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    logIssue.mockReset();
    logWarn.mockReset();
    logIssue.mockReturnValue(undefined);
    logWarn.mockReturnValue(undefined);
  });

  it("accepts upstream token responses when user email is not an email address", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "test-access-token",
          refresh_token: "test-refresh-token",
          token_type: "bearer",
          expires_in: 3600,
          expires_at: "2026-04-13T16:36:23.087Z",
          user: {
            email: "github-sso-user",
            id: "123",
            name: "GitHub SSO User",
          },
          scope: "org:read project:read",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const [payload, response] = await exchangeCodeForAccessToken({
      client_id: "test-client-id",
      client_secret: "test-client-secret",
      code: "test-code",
      upstream_url: "https://sentry.io/oauth/token",
      redirect_uri: "https://mcp.sentry.dev/oauth/callback",
    });

    expect(response).toBeNull();
    expect(payload).toEqual({
      access_token: "test-access-token",
      refresh_token: "test-refresh-token",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: "2026-04-13T16:36:23.087Z",
      user: {
        email: "github-sso-user",
        id: "123",
        name: "GitHub SSO User",
      },
      scope: "org:read project:read",
    });
    expect(logIssue).not.toHaveBeenCalled();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("returns a specific invalid_grant message without an event ID", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Authorization code expired",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const [payload, response] = await exchangeCodeForAccessToken({
      client_id: "test-client-id",
      client_secret: "test-client-secret",
      code: "expired-code",
      upstream_url: "https://sentry.io/oauth/token",
      redirect_uri: "https://mcp.sentry.dev/oauth/callback",
    });

    expect(payload).toBeNull();
    expect(response).not.toBeNull();
    expect(response!.status).toBe(400);

    const body = await response!.text();
    expect(body).toContain(
      "The authorization code was invalid or expired. Please try connecting your account again.",
    );
    expect(body).toContain("OAuth Error:</strong> invalid_grant");
    expect(body).not.toContain("Event ID:");
    expect(logWarn).toHaveBeenCalledWith(
      "[oauth] Failed to exchange code for access token",
      expect.objectContaining({
        loggerScope: ["cloudflare", "oauth", "callback"],
      }),
    );
    expect(logIssue).not.toHaveBeenCalled();
  });

  it("treats invalid_grant without an upstream description as a system failure", async () => {
    logIssue.mockReturnValue("oauth-invalid-grant-event-id");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "invalid_grant",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const [payload, response] = await exchangeCodeForAccessToken({
      client_id: "test-client-id",
      client_secret: "test-client-secret",
      code: "test-code",
      upstream_url: "https://sentry.io/oauth/token",
      redirect_uri: "https://mcp.sentry.dev/oauth/callback",
    });

    expect(payload).toBeNull();
    expect(response).not.toBeNull();
    expect(response!.status).toBe(502);

    const body = await response!.text();
    expect(body).toContain(
      "The authorization code could not be validated. Please try again.",
    );
    expect(body).toContain(
      "Event ID:</strong> <code>oauth-invalid-grant-event-id</code>",
    );
    expect(logIssue).toHaveBeenCalledWith(
      "[oauth] Failed to exchange code for access token",
      expect.objectContaining({
        loggerScope: ["cloudflare", "oauth", "callback"],
      }),
    );
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("returns an event ID for upstream token exchange system failures", async () => {
    logIssue.mockReturnValue("oauth-token-event-id");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("upstream unavailable", {
        status: 503,
        statusText: "Service Unavailable",
        headers: { "Content-Type": "text/plain" },
      }),
    );

    const [payload, response] = await exchangeCodeForAccessToken({
      client_id: "test-client-id",
      client_secret: "test-client-secret",
      code: "test-code",
      upstream_url: "https://sentry.io/oauth/token",
      redirect_uri: "https://mcp.sentry.dev/oauth/callback",
    });

    expect(payload).toBeNull();
    expect(response).not.toBeNull();
    expect(response!.status).toBe(502);

    const body = await response!.text();
    expect(body).toContain(
      "There was an internal error authenticating your account. Please try again shortly.",
    );
    expect(body).toContain(
      "Event ID:</strong> <code>oauth-token-event-id</code>",
    );
    expect(logIssue).toHaveBeenCalledWith(
      "[oauth] Failed to exchange code for access token",
      expect.objectContaining({
        loggerScope: ["cloudflare", "oauth", "callback"],
      }),
    );
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("returns an event ID for unknown upstream http failures", async () => {
    logIssue.mockReturnValue("oauth-forbidden-event-id");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<title>403</title>403 Forbidden", {
        status: 403,
        statusText: "Forbidden",
        headers: { "Content-Type": "text/html; charset=UTF-8" },
      }),
    );

    const [payload, response] = await exchangeCodeForAccessToken({
      client_id: "test-client-id",
      client_secret: "test-client-secret",
      code: "test-code",
      upstream_url: "https://sentry.io/oauth/token",
      redirect_uri: "https://mcp.sentry.dev/oauth/callback",
    });

    expect(payload).toBeNull();
    expect(response).not.toBeNull();
    expect(response!.status).toBe(502);

    const body = await response!.text();
    expect(body).toContain(
      "There was an internal error authenticating your account. Please try again shortly.",
    );
    expect(body).toContain(
      "Event ID:</strong> <code>oauth-forbidden-event-id</code>",
    );
    expect(logIssue).toHaveBeenCalledWith(
      "[oauth] Failed to exchange code for access token",
      expect.objectContaining({
        loggerScope: ["cloudflare", "oauth", "callback"],
      }),
    );
    expect(logWarn).not.toHaveBeenCalled();
  });
});

describe("getOAuthCallbackFailureDetails", () => {
  it("treats invalid_request as a user-correctable callback failure", () => {
    expect(
      getOAuthCallbackFailureDetails({ oauthError: "invalid_request" }),
    ).toEqual({
      message: "The authorization request was rejected. Please try again.",
      status: 400,
      shouldLogIssue: false,
    });
  });

  it("treats unknown callback errors as system failures", () => {
    expect(
      getOAuthCallbackFailureDetails({ oauthError: "provider_broke_it" }),
    ).toEqual({
      message:
        "There was an internal error authenticating your account. Please try again shortly.",
      status: 502,
      shouldLogIssue: true,
    });
  });
});

describe("getTokenExchangeFailureDetails", () => {
  it("treats invalid_scope as a system failure", () => {
    expect(
      getTokenExchangeFailureDetails({ oauthError: "invalid_scope" }),
    ).toEqual({
      message: "The requested permissions were invalid. Please try again.",
      status: 502,
      shouldLogIssue: true,
    });
  });

  it("treats unknown token exchange failures as system failures", () => {
    expect(getTokenExchangeFailureDetails({})).toEqual({
      message:
        "There was an internal error authenticating your account. Please try again shortly.",
      status: 502,
      shouldLogIssue: true,
    });
  });

  it("only treats invalid_grant as retryable when the description says the code expired", () => {
    expect(
      getTokenExchangeFailureDetails({
        oauthError: "invalid_grant",
        errorDescription: "Authorization code expired",
      }),
    ).toEqual({
      message:
        "The authorization code was invalid or expired. Please try connecting your account again.",
      status: 400,
      shouldLogIssue: false,
    });

    expect(
      getTokenExchangeFailureDetails({
        oauthError: "invalid_grant",
      }),
    ).toEqual({
      message:
        "The authorization code could not be validated. Please try again.",
      status: 502,
      shouldLogIssue: true,
    });
  });
});

describe("validateResourceParameter", () => {
  describe("valid resources", () => {
    it("should allow undefined resource (optional parameter)", () => {
      const result = validateResourceParameter(
        undefined,
        "https://mcp.sentry.dev/oauth/authorize",
      );
      expect(result).toBe(true);
    });

    it("should allow same hostname with /mcp path", () => {
      const result = validateResourceParameter(
        "https://mcp.sentry.dev/mcp",
        "https://mcp.sentry.dev/oauth/authorize",
      );
      expect(result).toBe(true);
    });

    it("should reject same hostname with origin-only resource", () => {
      const result = validateResourceParameter(
        "https://mcp.sentry.dev",
        "https://mcp.sentry.dev/oauth/authorize",
      );
      expect(result).toBe(false);
    });

    it("should reject same hostname with origin-only resource and trailing slash", () => {
      const result = validateResourceParameter(
        "https://mcp.sentry.dev/",
        "https://mcp.sentry.dev/oauth/authorize",
      );
      expect(result).toBe(false);
    });

    it("should allow same hostname with nested /mcp path", () => {
      const result = validateResourceParameter(
        "https://mcp.sentry.dev/mcp/org/project",
        "https://mcp.sentry.dev/oauth/authorize",
      );
      expect(result).toBe(true);
    });

    it("should allow same hostname with organization-scoped /mcp path", () => {
      const result = validateResourceParameter(
        "https://mcp.sentry.dev/mcp/org",
        "https://mcp.sentry.dev/oauth/authorize",
      );
      expect(result).toBe(true);
    });

    it("should allow localhost with /mcp path", () => {
      const result = validateResourceParameter(
        "http://localhost:8787/mcp",
        "http://localhost:8787/oauth/authorize",
      );
      expect(result).toBe(true);
    });

    it("should allow resource with query parameters", () => {
      const result = validateResourceParameter(
        "https://mcp.sentry.dev/mcp?foo=bar",
        "https://mcp.sentry.dev/oauth/authorize",
      );
      expect(result).toBe(true);
    });

    // Regression: Claude plugin attribution URL must remain a valid RFC 8707
    // resource even though path-scoped AS metadata advertises a query-free
    // issuer (RFC 8414 forbids query components on issuer).
    it("should allow plugin utm_source resource parameter", () => {
      const result = validateResourceParameter(
        "https://mcp.sentry.dev/mcp?utm_source=plugin",
        "https://mcp.sentry.dev/oauth/authorize",
      );
      expect(result).toBe(true);
    });

    it("should allow resource with different port when both match", () => {
      const result = validateResourceParameter(
        "https://mcp.sentry.dev:8443/mcp",
        "https://mcp.sentry.dev:8443/oauth/authorize",
      );
      expect(result).toBe(true);
    });

    it("should allow explicit default port 443 for https", () => {
      const result = validateResourceParameter(
        "https://mcp.sentry.dev:443/mcp",
        "https://mcp.sentry.dev/oauth/authorize",
      );
      expect(result).toBe(true);
    });

    it("should allow explicit default port 80 for http", () => {
      const result = validateResourceParameter(
        "http://localhost:80/mcp",
        "http://localhost/oauth/authorize",
      );
      expect(result).toBe(true);
    });

    it("should allow 127.0.0.1 with /mcp path", () => {
      const result = validateResourceParameter(
        "http://127.0.0.1:3000/mcp",
        "http://127.0.0.1:3000/oauth/authorize",
      );
      expect(result).toBe(true);
    });
  });

  describe("invalid resources", () => {
    it("should reject different hostname", () => {
      const result = validateResourceParameter(
        "https://attacker.com/mcp",
        "https://mcp.sentry.dev/oauth/authorize",
      );
      expect(result).toBe(false);
    });

    it("should reject different subdomain", () => {
      const result = validateResourceParameter(
        "https://evil.sentry.dev/mcp",
        "https://mcp.sentry.dev/oauth/authorize",
      );
      expect(result).toBe(false);
    });

    it("should reject invalid path (not /mcp)", () => {
      const result = validateResourceParameter(
        "https://mcp.sentry.dev/api",
        "https://mcp.sentry.dev/oauth/authorize",
      );
      expect(result).toBe(false);
    });

    it("should reject path without /mcp prefix", () => {
      const result = validateResourceParameter(
        "https://mcp.sentry.dev/oauth",
        "https://mcp.sentry.dev/oauth/authorize",
      );
      expect(result).toBe(false);
    });

    it("should reject path with /mcp prefix but no separator", () => {
      const result = validateResourceParameter(
        "https://mcp.sentry.dev/mcpadmin",
        "https://mcp.sentry.dev/oauth/authorize",
      );
      expect(result).toBe(false);
    });

    it("should reject path with /mcp- prefix", () => {
      const result = validateResourceParameter(
        "https://mcp.sentry.dev/mcp-evil",
        "https://mcp.sentry.dev/oauth/authorize",
      );
      expect(result).toBe(false);
    });

    it("should reject malformed URL", () => {
      const result = validateResourceParameter(
        "not-a-url",
        "https://mcp.sentry.dev/oauth/authorize",
      );
      expect(result).toBe(false);
    });

    it("should reject relative path", () => {
      const result = validateResourceParameter(
        "/mcp",
        "https://mcp.sentry.dev/oauth/authorize",
      );
      expect(result).toBe(false);
    });

    it("should reject empty string", () => {
      const result = validateResourceParameter(
        "",
        "https://mcp.sentry.dev/oauth/authorize",
      );
      expect(result).toBe(false);
    });

    it("should reject different port", () => {
      const result = validateResourceParameter(
        "https://mcp.sentry.dev:8080/mcp",
        "https://mcp.sentry.dev:443/oauth/authorize",
      );
      expect(result).toBe(false);
    });

    it("should reject different protocol (http vs https)", () => {
      const result = validateResourceParameter(
        "http://mcp.sentry.dev/mcp",
        "https://mcp.sentry.dev/oauth/authorize",
      );
      expect(result).toBe(false);
    });

    it("should reject javascript: scheme", () => {
      const result = validateResourceParameter(
        "javascript:alert(1)",
        "https://mcp.sentry.dev/oauth/authorize",
      );
      expect(result).toBe(false);
    });

    it("should reject data: scheme", () => {
      const result = validateResourceParameter(
        "data:text/html,<script>alert(1)</script>",
        "https://mcp.sentry.dev/oauth/authorize",
      );
      expect(result).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("should reject URL with fragment (RFC 8707)", () => {
      const result = validateResourceParameter(
        "https://mcp.sentry.dev/mcp#fragment",
        "https://mcp.sentry.dev/oauth/authorize",
      );
      expect(result).toBe(false);
    });

    it("should reject URL with empty fragment (RFC 8707)", () => {
      const result = validateResourceParameter(
        "https://mcp.sentry.dev#",
        "https://mcp.sentry.dev/oauth/authorize",
      );
      expect(result).toBe(false);
    });

    it("should handle URL with trailing slash", () => {
      const result = validateResourceParameter(
        "https://mcp.sentry.dev/mcp/",
        "https://mcp.sentry.dev/oauth/authorize",
      );
      expect(result).toBe(true);
    });

    it("should handle case sensitivity in hostname", () => {
      const result = validateResourceParameter(
        "https://MCP.SENTRY.DEV/mcp",
        "https://mcp.sentry.dev/oauth/authorize",
      );
      expect(result).toBe(true);
    });

    it("should be case-sensitive for path", () => {
      const result = validateResourceParameter(
        "https://mcp.sentry.dev/MCP",
        "https://mcp.sentry.dev/oauth/authorize",
      );
      expect(result).toBe(false);
    });

    it("should reject URL-encoded slashes in path", () => {
      const result = validateResourceParameter(
        "https://mcp.sentry.dev/mcp%2Forg",
        "https://mcp.sentry.dev/oauth/authorize",
      );
      expect(result).toBe(false);
    });

    it("should reject any percent-encoded characters in path", () => {
      const testCases = [
        "https://mcp.sentry.dev/mcp%2Forg",
        "https://mcp.sentry.dev/mcp/%2e%2e",
        "https://mcp.sentry.dev/mcp%20",
        "https://mcp.sentry.dev/mcp/test%00",
      ];

      for (const testCase of testCases) {
        const result = validateResourceParameter(
          testCase,
          "https://mcp.sentry.dev/oauth/authorize",
        );
        expect(result).toBe(false);
      }
    });

    it("should reject dot-segment traversal outside /mcp", () => {
      const testCases = [
        "https://mcp.sentry.dev/mcp/../evil",
        "https://mcp.sentry.dev/mcp/..",
      ];

      for (const testCase of testCases) {
        const result = validateResourceParameter(
          testCase,
          "https://mcp.sentry.dev/oauth/authorize",
        );
        expect(result).toBe(false);
      }
    });
  });
});

describe("getAuthorizationServerIssuer", () => {
  it("returns the request origin as the canonical issuer", () => {
    expect(
      getAuthorizationServerIssuer(
        "https://mcp.sentry.dev/oauth/callback?code=abc",
      ),
    ).toBe("https://mcp.sentry.dev");
    expect(
      getAuthorizationServerIssuer(
        new URL("http://localhost:8787/oauth/authorize"),
      ),
    ).toBe("http://localhost:8787");
  });
});

describe("appendAuthorizationResponseIss", () => {
  it("appends iss to query-mode authorization responses", () => {
    expect(
      appendAuthorizationResponseIss(
        "https://client.example.com/callback?code=abc&state=xyz",
        "https://mcp.sentry.dev",
      ),
    ).toBe(
      "https://client.example.com/callback?code=abc&state=xyz&iss=https%3A%2F%2Fmcp.sentry.dev",
    );
  });

  it("appends iss to fragment-mode authorization responses", () => {
    expect(
      appendAuthorizationResponseIss(
        "https://client.example.com/callback#code=abc&state=xyz",
        "https://mcp.sentry.dev",
      ),
    ).toBe(
      "https://client.example.com/callback#code=abc&state=xyz&iss=https%3A%2F%2Fmcp.sentry.dev",
    );
  });

  it("replaces an existing iss parameter with the canonical issuer", () => {
    expect(
      appendAuthorizationResponseIss(
        "https://client.example.com/callback?code=abc&iss=https%3A%2F%2Fother.example",
        "https://mcp.sentry.dev",
      ),
    ).toBe(
      "https://client.example.com/callback?code=abc&iss=https%3A%2F%2Fmcp.sentry.dev",
    );
  });
});

describe("createResourceValidationError", () => {
  it("should create redirect response with invalid_target error", () => {
    const response = createResourceValidationError(
      "https://client.example.com/callback",
      "state123",
      "https://mcp.sentry.dev/oauth/authorize",
    );

    expect(response.status).toBe(302);

    const location = response.headers.get("Location");
    expect(location).toBeDefined();

    const locationUrl = new URL(location!);
    expect(locationUrl.origin).toBe("https://client.example.com");
    expect(locationUrl.pathname).toBe("/callback");
    expect(locationUrl.searchParams.get("error")).toBe("invalid_target");
    expect(locationUrl.searchParams.get("error_description")).toContain(
      "resource parameter",
    );
    expect(locationUrl.searchParams.get("state")).toBe("state123");
    expect(locationUrl.searchParams.get("iss")).toBe("https://mcp.sentry.dev");
  });

  it("should create redirect without state parameter if not provided", () => {
    const response = createResourceValidationError(
      "https://client.example.com/callback",
      undefined,
      "https://mcp.sentry.dev/oauth/authorize",
    );

    const location = response.headers.get("Location");
    expect(location).toBeDefined();

    const locationUrl = new URL(location!);
    expect(locationUrl.searchParams.get("error")).toBe("invalid_target");
    expect(locationUrl.searchParams.get("state")).toBeNull();
    expect(locationUrl.searchParams.get("iss")).toBe("https://mcp.sentry.dev");
  });

  it("should preserve existing query parameters in redirect URI", () => {
    const response = createResourceValidationError(
      "https://client.example.com/callback?existing=param",
      "state456",
      "https://mcp.sentry.dev/oauth/authorize",
    );

    const location = response.headers.get("Location");
    const locationUrl = new URL(location!);

    expect(locationUrl.searchParams.get("existing")).toBe("param");
    expect(locationUrl.searchParams.get("error")).toBe("invalid_target");
    expect(locationUrl.searchParams.get("state")).toBe("state456");
    expect(locationUrl.searchParams.get("iss")).toBe("https://mcp.sentry.dev");
  });

  it("should have proper error description per RFC 8707", () => {
    const response = createResourceValidationError(
      "https://client.example.com/callback",
      undefined,
      "https://mcp.sentry.dev/oauth/authorize",
    );

    const location = response.headers.get("Location");
    const locationUrl = new URL(location!);

    const errorDescription = locationUrl.searchParams.get("error_description");
    expect(errorDescription).toContain("authorization server");
  });
});
