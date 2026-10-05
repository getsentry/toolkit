import { AuthorizationError } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SKILL_PREFERENCES_COOKIE_NAME } from "../lib/approval-dialog";
import type { Env } from "../types";
import oauthRoute from "./index";
import { signState, verifyAndParseState } from "./state";

// Mock the OAuth provider
const mockOAuthProvider = {
  parseAuthRequest: vi.fn(),
  lookupClient: vi.fn(),
  completeAuthorization: vi.fn(),
};

// Create test app with mocked environment
function createTestApp(env: Partial<Env> = {}) {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/oauth", oauthRoute);
  return app;
}

function skillInputAttributes(html: string, skillId: string): string {
  const match = html.match(
    new RegExp(
      `<input type="checkbox" name="skill" value="${skillId}"([^>]*)>`,
    ),
  );
  return match?.[1] ?? "";
}

function expectSkillChecked(html: string, skillId: string): void {
  expect(skillInputAttributes(html, skillId)).toContain("checked");
}

function expectSkillUnchecked(html: string, skillId: string): void {
  expect(skillInputAttributes(html, skillId)).not.toContain("checked");
}

function extractCookiePair(setCookie: string, cookieName: string): string {
  const marker = `${cookieName}=`;
  const start = setCookie.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = setCookie.slice(start);
  const end = rest.indexOf(";");
  return end === -1 ? rest : rest.slice(0, end);
}

async function createSkillPreferenceCookie(
  app: ReturnType<typeof createTestApp>,
  testEnv: Partial<Env>,
  clientId: string,
  skills: string[],
): Promise<string> {
  const formData = new FormData();
  const signedState = await signState(
    {
      req: {
        oauthReqInfo: {
          clientId,
          redirectUri: "https://example.com/callback",
          scope: ["read"],
        },
      },
      iat: Date.now(),
      exp: Date.now() + 10 * 60 * 1000,
    },
    testEnv.COOKIE_SECRET!,
  );
  formData.append("state", signedState);
  for (const skill of skills) {
    formData.append("skill", skill);
  }

  const response = await app.fetch(
    new Request("http://localhost/oauth/authorize", {
      method: "POST",
      body: formData,
    }),
    testEnv as Env,
  );
  expect(response.status).toBe(302);

  return extractCookiePair(
    response.headers.get("Set-Cookie") ?? "",
    SKILL_PREFERENCES_COOKIE_NAME,
  );
}

describe("oauth authorize routes", () => {
  let app: ReturnType<typeof createTestApp>;
  let testEnv: Partial<Env>;

  beforeEach(() => {
    vi.clearAllMocks();
    testEnv = {
      OAUTH_PROVIDER: mockOAuthProvider as unknown as Env["OAUTH_PROVIDER"],
      COOKIE_SECRET: "test-cookie-secret-key-for-hmac",
      SENTRY_CLIENT_ID: "test-client-id",
      SENTRY_CLIENT_SECRET: "test-client-secret",
      SENTRY_HOST: "sentry.io",
    };
    app = createTestApp(testEnv);
  });

  describe("GET /oauth/authorize", () => {
    it("renders approval dialog HTML with state field", async () => {
      mockOAuthProvider.parseAuthRequest.mockResolvedValueOnce({
        clientId: "test-client",
        redirectUri: "https://example.com/callback",
        scope: ["read"],
        state: "orig",
      });
      mockOAuthProvider.lookupClient.mockResolvedValueOnce({
        clientId: "test-client",
        clientName: "Test Client",
        redirectUris: ["https://example.com/callback"],
        tokenEndpointAuthMethod: "client_secret_basic",
      });

      const request = new Request("http://localhost/oauth/authorize", {
        method: "GET",
      });
      const response = await app.fetch(request, testEnv as Env);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("<form");
      expect(html).toContain('name="state"');
    });

    it("renders only the requested redirect URI when the client has multiple registered URIs", async () => {
      mockOAuthProvider.parseAuthRequest.mockResolvedValueOnce({
        clientId: "test-client",
        redirectUri: "https://example.com/requested-callback",
        scope: ["read"],
        state: "orig",
      });
      mockOAuthProvider.lookupClient.mockResolvedValueOnce({
        clientId: "test-client",
        clientName: "Test Client",
        redirectUris: [
          "https://example.com/requested-callback",
          "https://example.com/another-callback",
          "https://example.com/fallback-callback",
        ],
        tokenEndpointAuthMethod: "client_secret_basic",
      });

      const request = new Request("http://localhost/oauth/authorize", {
        method: "GET",
      });
      const response = await app.fetch(request, testEnv as Env);

      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("https://example.com/requested-callback");
      expect(html).not.toContain("https://example.com/another-callback");
      expect(html).not.toContain("https://example.com/fallback-callback");
      expect(
        html.match(/After approval, you will be redirected to/g),
      ).toHaveLength(1);
      // The true host is surfaced in the warning sentence.
      expect(html).toContain(
        "After approval, you will be redirected to <strong>example.com</strong>.",
      );
    });

    it("renders a local 400 for an AuthorizationError with no redirectUri, without throwing", async () => {
      mockOAuthProvider.parseAuthRequest.mockRejectedValueOnce(
        new AuthorizationError("invalid_request", {
          description: "client_id is required",
        }),
      );

      const request = new Request("http://localhost/oauth/authorize", {
        method: "GET",
      });
      const response = await app.fetch(request, testEnv as Env);

      expect(response.status).toBe(400);
      expect(await response.text()).toBe("client_id is required");
    });

    it("redirects an AuthorizationError back to the client once redirectUri is validated", async () => {
      mockOAuthProvider.parseAuthRequest.mockRejectedValueOnce(
        new AuthorizationError("invalid_scope", {
          description: "Requested scope is not supported",
          redirectUri: "https://example.com/callback",
          state: "orig",
        }),
      );

      const request = new Request("http://localhost/oauth/authorize", {
        method: "GET",
      });
      const response = await app.fetch(request, testEnv as Env);

      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location")!);
      expect(location.origin + location.pathname).toBe(
        "https://example.com/callback",
      );
      expect(location.searchParams.get("error")).toBe("invalid_scope");
      expect(location.searchParams.get("error_description")).toBe(
        "Requested scope is not supported",
      );
      expect(location.searchParams.get("state")).toBe("orig");
      // No issuer on the error itself; falls back to the request origin so
      // the redirect still carries RFC 9207 `iss`.
      expect(location.searchParams.get("iss")).toBe("http://localhost");
    });

    it("rejects redirect URIs with a userinfo component", async () => {
      mockOAuthProvider.parseAuthRequest.mockResolvedValueOnce({
        clientId: "test-client",
        redirectUri: "https://mcp.sentry.dev@example.io/callback",
        scope: ["read"],
        state: "orig",
      });

      const request = new Request("http://localhost/oauth/authorize", {
        method: "GET",
      });
      const response = await app.fetch(request, testEnv as Env);

      expect(response.status).toBe(400);
      expect(await response.text()).toBe("Invalid redirect URI");
      expect(mockOAuthProvider.lookupClient).not.toHaveBeenCalled();
    });

    it("preselects remembered skills for the matching client ID", async () => {
      mockOAuthProvider.lookupClient.mockResolvedValue({
        clientId: "test-client",
        clientName: "Test Client",
        redirectUris: ["https://example.com/callback"],
        tokenEndpointAuthMethod: "client_secret_basic",
      });
      const preferenceCookie = await createSkillPreferenceCookie(
        app,
        testEnv,
        "test-client",
        ["triage", "project-management"],
      );
      mockOAuthProvider.parseAuthRequest.mockResolvedValueOnce({
        clientId: "test-client",
        redirectUri: "https://example.com/callback",
        scope: ["read"],
        state: "orig",
      });

      const response = await app.fetch(
        new Request("http://localhost/oauth/authorize", {
          method: "GET",
          headers: { Cookie: preferenceCookie },
        }),
        testEnv as Env,
      );
      const html = await response.text();

      expect(response.status).toBe(200);
      expectSkillUnchecked(html, "inspect");
      expectSkillUnchecked(html, "seer");
      expectSkillChecked(html, "triage");
      expectSkillChecked(html, "project-management");
    });

    it("does not reuse remembered skills for a different client ID", async () => {
      mockOAuthProvider.lookupClient.mockResolvedValue({
        clientId: "test-client",
        clientName: "Test Client",
        redirectUris: ["https://example.com/callback"],
        tokenEndpointAuthMethod: "client_secret_basic",
      });
      const preferenceCookie = await createSkillPreferenceCookie(
        app,
        testEnv,
        "test-client",
        ["triage"],
      );
      mockOAuthProvider.parseAuthRequest.mockResolvedValueOnce({
        clientId: "other-client",
        redirectUri: "https://example.com/callback",
        scope: ["read"],
        state: "orig",
      });
      mockOAuthProvider.lookupClient.mockResolvedValueOnce({
        clientId: "other-client",
        clientName: "Other Client",
        redirectUris: ["https://example.com/callback"],
        tokenEndpointAuthMethod: "client_secret_basic",
      });

      const response = await app.fetch(
        new Request("http://localhost/oauth/authorize", {
          method: "GET",
          headers: { Cookie: preferenceCookie },
        }),
        testEnv as Env,
      );
      const html = await response.text();

      expect(response.status).toBe(200);
      expectSkillChecked(html, "inspect");
      expectSkillChecked(html, "seer");
      expectSkillChecked(html, "triage");
      expectSkillChecked(html, "project-management");
    });

    it("ignores tampered remembered skill cookies and falls back to all approvable skills", async () => {
      mockOAuthProvider.parseAuthRequest.mockResolvedValueOnce({
        clientId: "test-client",
        redirectUri: "https://example.com/callback",
        scope: ["read"],
        state: "orig",
      });
      mockOAuthProvider.lookupClient.mockResolvedValueOnce({
        clientId: "test-client",
        clientName: "Test Client",
        redirectUris: ["https://example.com/callback"],
        tokenEndpointAuthMethod: "client_secret_basic",
      });

      const response = await app.fetch(
        new Request("http://localhost/oauth/authorize", {
          method: "GET",
          headers: {
            Cookie: `${SKILL_PREFERENCES_COOKIE_NAME}=bad-signature.${btoa(
              JSON.stringify({
                clients: [["test-client", ["triage"]]],
              }),
            )}`,
          },
        }),
        testEnv as Env,
      );
      const html = await response.text();

      expect(response.status).toBe(200);
      expectSkillChecked(html, "inspect");
      expectSkillChecked(html, "seer");
      expectSkillChecked(html, "triage");
      expectSkillChecked(html, "project-management");
    });
  });

  describe("POST /oauth/authorize", () => {
    beforeEach(() => {
      mockOAuthProvider.lookupClient.mockResolvedValue({
        clientId: "test-client",
        clientName: "Test Client",
        redirectUris: ["https://example.com/callback"],
        tokenEndpointAuthMethod: "client_secret_basic",
      });
    });
    it("rejects redirect URIs with a userinfo component", async () => {
      const oauthReqInfo = {
        clientId: "test-client",
        redirectUri: "https://mcp.sentry.dev@example.io/callback",
        scope: ["read"],
        state: "original-state",
      };
      const formData = new FormData();
      const signedState = await signState(
        {
          req: { oauthReqInfo },
          iat: Date.now(),
          exp: Date.now() + 10 * 60 * 1000,
        },
        testEnv.COOKIE_SECRET!,
      );
      formData.append("state", signedState);
      const request = new Request("http://localhost/oauth/authorize", {
        method: "POST",
        body: formData,
      });
      const response = await app.fetch(request, testEnv as Env);

      expect(response.status).toBe(400);
      expect(await response.text()).toBe("Invalid redirect URI");
    });

    it("accepts an ephemeral loopback port against a portless CIMD registration", async () => {
      mockOAuthProvider.lookupClient.mockResolvedValue({
        clientId: "https://claude.ai/oauth/claude-code-client-metadata",
        clientName: "Claude Code",
        redirectUris: [
          "http://localhost/callback",
          "http://127.0.0.1/callback",
        ],
        tokenEndpointAuthMethod: "none",
      });
      const oauthReqInfo = {
        clientId: "https://claude.ai/oauth/claude-code-client-metadata",
        redirectUri: "http://localhost:3118/callback",
        scope: ["org:read"],
        state: "original-state",
      };
      const formData = new FormData();
      const signedState = await signState(
        {
          req: { oauthReqInfo },
          iat: Date.now(),
          exp: Date.now() + 10 * 60 * 1000,
        },
        testEnv.COOKIE_SECRET!,
      );
      formData.append("state", signedState);
      formData.append("skill", "triage");
      const request = new Request("http://localhost/oauth/authorize", {
        method: "POST",
        body: formData,
      });
      const response = await app.fetch(request, testEnv as Env);

      expect(response.status).toBe(302);
    });

    it("should encode skills in the redirect state", async () => {
      const oauthReqInfo = {
        clientId: "test-client",
        redirectUri: "https://example.com/callback",
        scope: ["read", "write"],
        state: "original-state",
      };
      const formData = new FormData();
      // Use HMAC-signed state matching what the app will verify
      const signedState = await signState(
        {
          req: { oauthReqInfo },
          iat: Date.now(),
          exp: Date.now() + 10 * 60 * 1000,
        },
        testEnv.COOKIE_SECRET!,
      );
      formData.append("state", signedState);
      formData.append("skill", "triage");
      formData.append("skill", "project-management");
      const request = new Request("http://localhost/oauth/authorize", {
        method: "POST",
        body: formData,
      });
      const response = await app.fetch(request, testEnv as Env);
      expect(response.status).toBe(302);
      const location = response.headers.get("location");
      expect(location).toBeTruthy();
      const redirectUrl = new URL(location!);
      expect(redirectUrl.hostname).toBe("sentry.io");
      expect(redirectUrl.pathname).toBe("/oauth/authorize/");
      expect(redirectUrl.searchParams.get("scope")?.split(" ")).toContain(
        "alerts:write",
      );
      const stateParam = redirectUrl.searchParams.get("state");
      expect(stateParam).toBeTruthy();
      const decodedState = await verifyAndParseState(
        stateParam!,
        testEnv.COOKIE_SECRET!,
      );
      expect((decodedState.req as any).skills).toEqual([
        "triage",
        "project-management",
      ]);
      expect((decodedState.req as any).clientId).toBe("test-client");
      expect((decodedState.req as any).redirectUri).toBe(
        "https://example.com/callback",
      );
      expect((decodedState.req as any).scope).toEqual(["read", "write"]);
    });

    it("uses submitted skills rather than remembered skills for redirect state", async () => {
      mockOAuthProvider.lookupClient.mockResolvedValue({
        clientId: "test-client",
        clientName: "Test Client",
        redirectUris: ["https://example.com/callback"],
        tokenEndpointAuthMethod: "client_secret_basic",
      });
      const preferenceCookie = await createSkillPreferenceCookie(
        app,
        testEnv,
        "test-client",
        ["project-management"],
      );
      const oauthReqInfo = {
        clientId: "test-client",
        redirectUri: "https://example.com/callback",
        scope: ["read", "write"],
        state: "original-state",
      };
      const formData = new FormData();
      const signedState = await signState(
        {
          req: { oauthReqInfo },
          iat: Date.now(),
          exp: Date.now() + 10 * 60 * 1000,
        },
        testEnv.COOKIE_SECRET!,
      );
      formData.append("state", signedState);
      formData.append("skill", "triage");

      const response = await app.fetch(
        new Request("http://localhost/oauth/authorize", {
          method: "POST",
          headers: { Cookie: preferenceCookie },
          body: formData,
        }),
        testEnv as Env,
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location");
      const redirectUrl = new URL(location!);
      const stateParam = redirectUrl.searchParams.get("state");
      const decodedState = await verifyAndParseState(
        stateParam!,
        testEnv.COOKIE_SECRET!,
      );
      expect((decodedState.req as any).skills).toEqual(["triage"]);
    });

    it("should handle no skills selected", async () => {
      const oauthReqInfo = {
        clientId: "test-client",
        redirectUri: "https://example.com/callback",
        scope: ["read"],
        state: "original-state",
      };
      const formData = new FormData();
      const signedState = await signState(
        {
          req: { oauthReqInfo },
          iat: Date.now(),
          exp: Date.now() + 10 * 60 * 1000,
        },
        testEnv.COOKIE_SECRET!,
      );
      formData.append("state", signedState);
      const request = new Request("http://localhost/oauth/authorize", {
        method: "POST",
        body: formData,
      });
      const response = await app.fetch(request, testEnv as Env);
      expect(response.status).toBe(302);
      const location = response.headers.get("location");
      expect(location).toBeTruthy();
      const redirectUrl = new URL(location!);
      const stateParam = redirectUrl.searchParams.get("state");
      const decodedState = await verifyAndParseState(
        stateParam!,
        testEnv.COOKIE_SECRET!,
      );
      expect((decodedState.req as any).skills).toEqual([]);
    });

    it("should handle only triage skill", async () => {
      const oauthReqInfo = {
        clientId: "test-client",
        redirectUri: "https://example.com/callback",
        scope: ["read", "write"],
        state: "original-state",
      };
      const formData = new FormData();
      const signedState = await signState(
        {
          req: { oauthReqInfo },
          iat: Date.now(),
          exp: Date.now() + 10 * 60 * 1000,
        },
        testEnv.COOKIE_SECRET!,
      );
      formData.append("state", signedState);
      formData.append("skill", "triage");
      const request = new Request("http://localhost/oauth/authorize", {
        method: "POST",
        body: formData,
      });
      const response = await app.fetch(request, testEnv as Env);
      expect(response.status).toBe(302);
      const location = response.headers.get("location");
      const redirectUrl = new URL(location!);
      const stateParam = redirectUrl.searchParams.get("state");
      const decodedState = await verifyAndParseState(
        stateParam!,
        testEnv.COOKIE_SECRET!,
      );
      expect((decodedState.req as any).skills).toEqual(["triage"]);
    });

    it("should include Set-Cookie header for approval", async () => {
      const oauthReqInfo = {
        clientId: "test-client",
        redirectUri: "https://example.com/callback",
        scope: ["read"],
      };
      const formData = new FormData();
      const signedState = await signState(
        {
          req: { oauthReqInfo },
          iat: Date.now(),
          exp: Date.now() + 10 * 60 * 1000,
        },
        testEnv.COOKIE_SECRET!,
      );
      formData.append("state", signedState);
      const request = new Request("http://localhost/oauth/authorize", {
        method: "POST",
        body: formData,
      });
      const response = await app.fetch(request, testEnv as Env);
      const setCookie = response.headers.get("Set-Cookie");
      expect(setCookie).toBeTruthy();
      expect(setCookie).toContain("mcp-approved-clients=");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("Secure");
      expect(setCookie).toContain("SameSite=Lax");
    });

    it("redirects cancel to the client with access_denied", async () => {
      const oauthReqInfo = {
        clientId: "test-client",
        redirectUri: "https://example.com/callback",
        scope: ["read"],
        state: "original-state",
      };
      const formData = new FormData();
      const signedState = await signState(
        {
          req: { oauthReqInfo },
          iat: Date.now(),
          exp: Date.now() + 10 * 60 * 1000,
        },
        testEnv.COOKIE_SECRET!,
      );
      formData.append("state", signedState);
      formData.append("decision", "deny");
      const request = new Request("http://localhost/oauth/authorize", {
        method: "POST",
        body: formData,
      });
      const response = await app.fetch(request, testEnv as Env);

      expect(response.status).toBe(302);
      expect(response.headers.get("Set-Cookie")).toBeNull();
      const redirectUrl = new URL(response.headers.get("location")!);
      expect(redirectUrl.origin).toBe("https://example.com");
      expect(redirectUrl.pathname).toBe("/callback");
      expect(redirectUrl.searchParams.get("error")).toBe("access_denied");
      expect(redirectUrl.searchParams.get("state")).toBe("original-state");
    });
  });

  describe("POST /oauth/authorize (CSRF/validation)", () => {
    it("should reject invalid encoded state (bad base64/json)", async () => {
      const formData = new FormData();
      formData.append("state", "%%%INVALID-BASE64%%%");
      const request = new Request("http://localhost/oauth/authorize", {
        method: "POST",
        body: formData,
      });
      const response = await app.fetch(request, testEnv as Env);
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toBe("Invalid request");
    });
  });

  describe("Resource parameter validation (RFC 8707)", () => {
    describe("GET /oauth/authorize", () => {
      it("should allow request without resource parameter", async () => {
        mockOAuthProvider.parseAuthRequest.mockResolvedValueOnce({
          clientId: "test-client",
          redirectUri: "https://example.com/callback",
          scope: ["read"],
        });
        mockOAuthProvider.lookupClient.mockResolvedValueOnce({
          clientId: "test-client",
          clientName: "Test Client",
          redirectUris: ["https://example.com/callback"],
        });

        const request = new Request("http://localhost/oauth/authorize", {
          method: "GET",
        });
        const response = await app.fetch(request, testEnv as Env);

        // Should proceed normally (render approval dialog)
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("<form");
        expect(html).not.toContain("Session scope");
      });

      it("should allow request with valid resource parameter", async () => {
        mockOAuthProvider.parseAuthRequest.mockResolvedValueOnce({
          clientId: "test-client",
          redirectUri: "https://example.com/callback",
          scope: ["read"],
          resource: "http://localhost/mcp",
        });
        mockOAuthProvider.lookupClient.mockResolvedValueOnce({
          clientId: "test-client",
          clientName: "Test Client",
          redirectUris: ["https://example.com/callback"],
        });

        const request = new Request(
          "http://localhost/oauth/authorize?resource=http://localhost/mcp",
          { method: "GET" },
        );
        const response = await app.fetch(request, testEnv as Env);

        // Should proceed normally
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).not.toContain("Session scope");
      });

      it("should reject request with origin-only resource parameter", async () => {
        mockOAuthProvider.parseAuthRequest.mockResolvedValueOnce({
          clientId: "test-client",
          redirectUri: "https://example.com/callback",
          scope: ["read"],
          resource: "http://localhost",
        });
        mockOAuthProvider.lookupClient.mockResolvedValueOnce({
          clientId: "test-client",
          clientName: "Test Client",
          redirectUris: ["https://example.com/callback"],
        });

        const request = new Request(
          "http://localhost/oauth/authorize?resource=http://localhost",
          { method: "GET" },
        );
        const response = await app.fetch(request, testEnv as Env);

        expect(response.status).toBe(302);
        const location = response.headers.get("location");
        const locationUrl = new URL(location!);
        expect(locationUrl.searchParams.get("error")).toBe("invalid_target");
      });

      it("should reject request with origin-only resource parameter and trailing slash", async () => {
        mockOAuthProvider.parseAuthRequest.mockResolvedValueOnce({
          clientId: "test-client",
          redirectUri: "https://example.com/callback",
          scope: ["read"],
          resource: "http://localhost/",
        });
        mockOAuthProvider.lookupClient.mockResolvedValueOnce({
          clientId: "test-client",
          clientName: "Test Client",
          redirectUris: ["https://example.com/callback"],
        });

        const url = new URL("http://localhost/oauth/authorize");
        url.searchParams.set("resource", "http://localhost/");

        const request = new Request(url, { method: "GET" });
        const response = await app.fetch(request, testEnv as Env);

        expect(response.status).toBe(302);
        const location = response.headers.get("location");
        const locationUrl = new URL(location!);
        expect(locationUrl.searchParams.get("error")).toBe("invalid_target");
      });

      it("should allow request with path-specific query resource parameter", async () => {
        mockOAuthProvider.parseAuthRequest.mockResolvedValueOnce({
          clientId: "test-client",
          redirectUri: "https://example.com/callback",
          scope: ["read"],
          resource: "http://localhost/mcp?experimental=1",
        });
        mockOAuthProvider.lookupClient.mockResolvedValueOnce({
          clientId: "test-client",
          clientName: "Test Client",
          redirectUris: ["https://example.com/callback"],
        });

        const url = new URL("http://localhost/oauth/authorize");
        url.searchParams.set("resource", "http://localhost/mcp?experimental=1");

        const request = new Request(url, { method: "GET" });
        const response = await app.fetch(request, testEnv as Env);

        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).not.toContain("Session scope");
      });

      // Regression: Claude plugin MCP URL is /mcp?utm_source=plugin. The AS
      // must accept that exact resource indicator and must not emit
      // invalid_target just because the issuer is query-free.
      it("should allow request with plugin utm_source resource parameter", async () => {
        mockOAuthProvider.parseAuthRequest.mockResolvedValueOnce({
          clientId: "test-client",
          redirectUri: "https://example.com/callback",
          scope: ["read"],
          resource: "http://localhost/mcp?utm_source=plugin",
        });
        mockOAuthProvider.lookupClient.mockResolvedValueOnce({
          clientId: "test-client",
          clientName: "Test Client",
          redirectUris: ["https://example.com/callback"],
        });

        const url = new URL("http://localhost/oauth/authorize");
        url.searchParams.set(
          "resource",
          "http://localhost/mcp?utm_source=plugin",
        );

        const request = new Request(url, { method: "GET" });
        const response = await app.fetch(request, testEnv as Env);

        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("<form");
        expect(html).not.toContain("invalid_target");
        expect(html).not.toContain("Session scope");
      });

      it("should allow request with organization-scoped resource parameter", async () => {
        mockOAuthProvider.parseAuthRequest.mockResolvedValueOnce({
          clientId: "test-client",
          redirectUri: "https://example.com/callback",
          scope: ["read"],
          resource: "http://localhost/mcp/test-org",
        });
        mockOAuthProvider.lookupClient.mockResolvedValueOnce({
          clientId: "test-client",
          clientName: "Test Client",
          redirectUris: ["https://example.com/callback"],
        });

        const url = new URL("http://localhost/oauth/authorize");
        url.searchParams.set("resource", "http://localhost/mcp/test-org");

        const request = new Request(url, { method: "GET" });
        const response = await app.fetch(request, testEnv as Env);

        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain(">test-org</strong> organization");
      });

      it("should allow request with project-scoped resource parameter", async () => {
        mockOAuthProvider.parseAuthRequest.mockResolvedValueOnce({
          clientId: "test-client",
          redirectUri: "https://example.com/callback",
          scope: ["read"],
          resource: "http://localhost/mcp/test-org/test-project",
        });
        mockOAuthProvider.lookupClient.mockResolvedValueOnce({
          clientId: "test-client",
          clientName: "Test Client",
          redirectUris: ["https://example.com/callback"],
        });

        const url = new URL("http://localhost/oauth/authorize");
        url.searchParams.set(
          "resource",
          "http://localhost/mcp/test-org/test-project",
        );

        const request = new Request(url, { method: "GET" });
        const response = await app.fetch(request, testEnv as Env);

        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain(">test-project</strong> project");
        expect(html).toContain(">test-org</strong> organization");
      });

      it("should reject request with invalid resource hostname", async () => {
        mockOAuthProvider.parseAuthRequest.mockResolvedValueOnce({
          clientId: "test-client",
          redirectUri: "https://example.com/callback",
          scope: ["read"],
          state: "test-state",
        });

        const request = new Request(
          "http://localhost/oauth/authorize?resource=https://attacker.com/mcp&redirect_uri=https://example.com/callback&state=test-state",
          { method: "GET" },
        );
        const response = await app.fetch(request, testEnv as Env);

        // Should redirect with error
        expect(response.status).toBe(302);
        const location = response.headers.get("location");
        expect(location).toBeTruthy();

        const locationUrl = new URL(location!);
        expect(locationUrl.origin).toBe("https://example.com");
        expect(locationUrl.searchParams.get("error")).toBe("invalid_target");
        expect(locationUrl.searchParams.get("error_description")).toContain(
          "resource parameter",
        );
        expect(locationUrl.searchParams.get("state")).toBe("test-state");
      });

      it("should reject request with invalid resource path", async () => {
        mockOAuthProvider.parseAuthRequest.mockResolvedValueOnce({
          clientId: "test-client",
          redirectUri: "https://example.com/callback",
          scope: ["read"],
        });

        const request = new Request(
          "http://localhost/oauth/authorize?resource=http://localhost/api&redirect_uri=https://example.com/callback",
          { method: "GET" },
        );
        const response = await app.fetch(request, testEnv as Env);

        // Should redirect with error
        expect(response.status).toBe(302);
        const location = response.headers.get("location");
        const locationUrl = new URL(location!);
        expect(locationUrl.searchParams.get("error")).toBe("invalid_target");
      });

      it("should reject request with empty fragment resource", async () => {
        mockOAuthProvider.parseAuthRequest.mockResolvedValueOnce({
          clientId: "test-client",
          redirectUri: "https://example.com/callback",
          scope: ["read"],
          state: "test-state",
        });

        const url = new URL("http://localhost/oauth/authorize");
        url.searchParams.set("resource", "http://localhost#");
        url.searchParams.set("redirect_uri", "https://example.com/callback");
        url.searchParams.set("state", "test-state");

        const request = new Request(url, { method: "GET" });
        const response = await app.fetch(request, testEnv as Env);

        expect(response.status).toBe(302);
        const location = response.headers.get("location");
        const locationUrl = new URL(location!);
        expect(locationUrl.searchParams.get("error")).toBe("invalid_target");
        expect(locationUrl.searchParams.get("state")).toBe("test-state");
      });

      it("should return 400 if invalid resource but no redirect_uri", async () => {
        mockOAuthProvider.parseAuthRequest.mockResolvedValueOnce({
          clientId: "test-client",
          scope: ["read"],
        });

        const request = new Request(
          "http://localhost/oauth/authorize?resource=https://attacker.com/mcp",
          { method: "GET" },
        );
        const response = await app.fetch(request, testEnv as Env);

        // Should return direct error
        expect(response.status).toBe(400);
        const text = await response.text();
        expect(text).toContain("Invalid resource parameter");
      });
    });

    describe("POST /oauth/authorize", () => {
      beforeEach(() => {
        mockOAuthProvider.lookupClient.mockResolvedValue({
          clientId: "test-client",
          clientName: "Test Client",
          redirectUris: ["https://example.com/callback"],
        });
      });

      it("should allow request without resource parameter", async () => {
        const oauthReqInfo = {
          clientId: "test-client",
          redirectUri: "https://example.com/callback",
          scope: ["read"],
        };
        const formData = new FormData();
        const signedState = await signState(
          {
            req: { oauthReqInfo },
            iat: Date.now(),
            exp: Date.now() + 10 * 60 * 1000,
          },
          testEnv.COOKIE_SECRET!,
        );
        formData.append("state", signedState);

        const request = new Request("http://localhost/oauth/authorize", {
          method: "POST",
          body: formData,
        });
        const response = await app.fetch(request, testEnv as Env);

        // Should proceed normally (redirect to Sentry)
        expect(response.status).toBe(302);
        const location = response.headers.get("location");
        expect(location).toContain("sentry.io");
      });

      it("should allow request with valid resource parameter", async () => {
        const oauthReqInfo = {
          clientId: "test-client",
          redirectUri: "https://example.com/callback",
          scope: ["read"],
          resource: "http://localhost/mcp",
        };
        const formData = new FormData();
        const signedState = await signState(
          {
            req: { oauthReqInfo },
            iat: Date.now(),
            exp: Date.now() + 10 * 60 * 1000,
          },
          testEnv.COOKIE_SECRET!,
        );
        formData.append("state", signedState);

        const request = new Request("http://localhost/oauth/authorize", {
          method: "POST",
          body: formData,
        });
        const response = await app.fetch(request, testEnv as Env);

        // Should proceed normally
        expect(response.status).toBe(302);
        const location = response.headers.get("location");
        expect(location).toContain("sentry.io");
      });

      it("should reject request with origin-only resource parameter", async () => {
        const oauthReqInfo = {
          clientId: "test-client",
          redirectUri: "https://example.com/callback",
          scope: ["read"],
          resource: "http://localhost",
        };
        const formData = new FormData();
        const signedState = await signState(
          {
            req: { oauthReqInfo },
            iat: Date.now(),
            exp: Date.now() + 10 * 60 * 1000,
          },
          testEnv.COOKIE_SECRET!,
        );
        formData.append("state", signedState);

        const request = new Request("http://localhost/oauth/authorize", {
          method: "POST",
          body: formData,
        });
        const response = await app.fetch(request, testEnv as Env);

        expect(response.status).toBe(302);
        const location = response.headers.get("location");
        const locationUrl = new URL(location!);
        expect(locationUrl.searchParams.get("error")).toBe("invalid_target");
      });

      it("should allow request with path-specific query resource parameter", async () => {
        const oauthReqInfo = {
          clientId: "test-client",
          redirectUri: "https://example.com/callback",
          scope: ["read"],
          resource: "http://localhost/mcp?experimental=1",
        };
        const formData = new FormData();
        const signedState = await signState(
          {
            req: { oauthReqInfo },
            iat: Date.now(),
            exp: Date.now() + 10 * 60 * 1000,
          },
          testEnv.COOKIE_SECRET!,
        );
        formData.append("state", signedState);

        const request = new Request("http://localhost/oauth/authorize", {
          method: "POST",
          body: formData,
        });
        const response = await app.fetch(request, testEnv as Env);

        expect(response.status).toBe(302);
        const location = response.headers.get("location");
        expect(location).toContain("sentry.io");
      });

      // Regression: consent approval must also accept the plugin-attributed
      // resource and continue upstream rather than redirecting invalid_target.
      it("should allow approval with plugin utm_source resource parameter", async () => {
        const oauthReqInfo = {
          clientId: "test-client",
          redirectUri: "https://example.com/callback",
          scope: ["read"],
          resource: "http://localhost/mcp?utm_source=plugin",
        };
        const formData = new FormData();
        const signedState = await signState(
          {
            req: { oauthReqInfo },
            iat: Date.now(),
            exp: Date.now() + 10 * 60 * 1000,
          },
          testEnv.COOKIE_SECRET!,
        );
        formData.append("state", signedState);

        const request = new Request("http://localhost/oauth/authorize", {
          method: "POST",
          body: formData,
        });
        const response = await app.fetch(request, testEnv as Env);

        expect(response.status).toBe(302);
        const location = response.headers.get("location");
        expect(location).toBeTruthy();
        const locationUrl = new URL(location!);
        expect(locationUrl.searchParams.get("error")).not.toBe(
          "invalid_target",
        );
        expect(location).toContain("sentry.io");
      });

      it("should allow request with organization-scoped resource parameter", async () => {
        const oauthReqInfo = {
          clientId: "test-client",
          redirectUri: "https://example.com/callback",
          scope: ["read"],
          resource: "http://localhost/mcp/test-org",
        };
        const formData = new FormData();
        const signedState = await signState(
          {
            req: { oauthReqInfo },
            iat: Date.now(),
            exp: Date.now() + 10 * 60 * 1000,
          },
          testEnv.COOKIE_SECRET!,
        );
        formData.append("state", signedState);

        const request = new Request("http://localhost/oauth/authorize", {
          method: "POST",
          body: formData,
        });
        const response = await app.fetch(request, testEnv as Env);

        expect(response.status).toBe(302);
        const location = response.headers.get("location");
        expect(location).toContain("sentry.io");
      });

      it("should allow request with project-scoped resource parameter", async () => {
        const oauthReqInfo = {
          clientId: "test-client",
          redirectUri: "https://example.com/callback",
          scope: ["read"],
          resource: "http://localhost/mcp/test-org/test-project",
        };
        const formData = new FormData();
        const signedState = await signState(
          {
            req: { oauthReqInfo },
            iat: Date.now(),
            exp: Date.now() + 10 * 60 * 1000,
          },
          testEnv.COOKIE_SECRET!,
        );
        formData.append("state", signedState);

        const request = new Request("http://localhost/oauth/authorize", {
          method: "POST",
          body: formData,
        });
        const response = await app.fetch(request, testEnv as Env);

        expect(response.status).toBe(302);
        const location = response.headers.get("location");
        expect(location).toContain("sentry.io");
      });

      it("should reject request with invalid resource hostname", async () => {
        const oauthReqInfo = {
          clientId: "test-client",
          redirectUri: "https://example.com/callback",
          scope: ["read"],
          resource: "https://attacker.com/mcp",
          state: "test-state",
        };
        const formData = new FormData();
        const signedState = await signState(
          {
            req: { oauthReqInfo },
            iat: Date.now(),
            exp: Date.now() + 10 * 60 * 1000,
          },
          testEnv.COOKIE_SECRET!,
        );
        formData.append("state", signedState);

        const request = new Request("http://localhost/oauth/authorize", {
          method: "POST",
          body: formData,
        });
        const response = await app.fetch(request, testEnv as Env);

        // Should redirect with error
        expect(response.status).toBe(302);
        const location = response.headers.get("location");
        expect(location).toBeTruthy();

        const locationUrl = new URL(location!);
        expect(locationUrl.origin).toBe("https://example.com");
        expect(locationUrl.searchParams.get("error")).toBe("invalid_target");
        expect(locationUrl.searchParams.get("state")).toBe("test-state");
      });

      it("should reject request with invalid resource path", async () => {
        const oauthReqInfo = {
          clientId: "test-client",
          redirectUri: "https://example.com/callback",
          scope: ["read"],
          resource: "http://localhost/oauth",
        };
        const formData = new FormData();
        const signedState = await signState(
          {
            req: { oauthReqInfo },
            iat: Date.now(),
            exp: Date.now() + 10 * 60 * 1000,
          },
          testEnv.COOKIE_SECRET!,
        );
        formData.append("state", signedState);

        const request = new Request("http://localhost/oauth/authorize", {
          method: "POST",
          body: formData,
        });
        const response = await app.fetch(request, testEnv as Env);

        // Should redirect with error
        expect(response.status).toBe(302);
        const location = response.headers.get("location");
        const locationUrl = new URL(location!);
        expect(locationUrl.searchParams.get("error")).toBe("invalid_target");
      });

      it("should reject request with empty fragment resource", async () => {
        const oauthReqInfo = {
          clientId: "test-client",
          redirectUri: "https://example.com/callback",
          scope: ["read"],
          resource: "http://localhost#",
          state: "test-state",
        };
        const formData = new FormData();
        const signedState = await signState(
          {
            req: { oauthReqInfo },
            iat: Date.now(),
            exp: Date.now() + 10 * 60 * 1000,
          },
          testEnv.COOKIE_SECRET!,
        );
        formData.append("state", signedState);

        const request = new Request("http://localhost/oauth/authorize", {
          method: "POST",
          body: formData,
        });
        const response = await app.fetch(request, testEnv as Env);

        expect(response.status).toBe(302);
        const location = response.headers.get("location");
        const locationUrl = new URL(location!);
        expect(locationUrl.searchParams.get("error")).toBe("invalid_target");
        expect(locationUrl.searchParams.get("state")).toBe("test-state");
      });

      it("should prevent open redirect with unregistered redirectUri and invalid resource", async () => {
        // Validates redirectUri before resource to prevent open redirects
        const oauthReqInfo = {
          clientId: "test-client",
          redirectUri: "https://attacker.com/malicious",
          scope: ["read"],
          resource: "https://attacker.com/mcp",
          state: "test-state",
        };
        const formData = new FormData();
        const signedState = await signState(
          {
            req: { oauthReqInfo },
            iat: Date.now(),
            exp: Date.now() + 10 * 60 * 1000,
          },
          testEnv.COOKIE_SECRET!,
        );
        formData.append("state", signedState);

        const request = new Request("http://localhost/oauth/authorize", {
          method: "POST",
          body: formData,
        });
        const response = await app.fetch(request, testEnv as Env);

        expect(response.status).toBe(400);
        const text = await response.text();
        expect(text).toContain("Invalid redirect URI");
      });
    });
  });
});
