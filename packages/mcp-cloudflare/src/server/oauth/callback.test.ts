import { createExecutionContext, env } from "cloudflare:test";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SCOPES } from "../../constants";
import { PKCE_CODE_CHALLENGE, PKCE_CODE_VERIFIER } from "../../test-utils/pkce";
import app from "../app";
import handler from "../index";
import mcpHandler from "../lib/mcp-handler";
import type { Env } from "../types";
import oauthRoute from "./index";
import { type OAuthState, signState } from "./state";

const { exchangeCodeForAccessToken, logError, logIssue, logWarn } = vi.hoisted(
  () => ({
    exchangeCodeForAccessToken: vi.fn(),
    logError: vi.fn(),
    logIssue: vi.fn(),
    logWarn: vi.fn(),
  }),
);

vi.mock("@sentry/mcp-core/telem/logging", () => ({
  logError,
  logWarn,
  logIssue,
}));

vi.mock("./helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./helpers")>();

  return {
    ...actual,
    exchangeCodeForAccessToken,
  };
});

const REDIRECT_URI = "https://example.com/callback";
const COOKIE_SECRET = "test-cookie-secret-key-for-hmac";

function createTestApp() {
  const hono = new Hono<{ Bindings: Env }>();
  hono.route("/oauth", oauthRoute);
  return hono;
}

function createOAuthApi(testEnv: Env) {
  return getOAuthApi(
    {
      apiRoute: "/mcp",
      apiHandler: mcpHandler,
      defaultHandler: app,
      authorizeEndpoint: "/oauth/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      scopesSupported: Object.keys(SCOPES),
    },
    testEnv,
  );
}

function createTestEnv(): Env {
  const baseEnv = {
    ...(env as Record<string, unknown>),
    CF_VERSION_METADATA: {
      id: "test-version-id",
    },
    COOKIE_SECRET,
    SENTRY_CLIENT_ID: "test-client-id",
    SENTRY_CLIENT_SECRET: "test-client-secret",
    SENTRY_HOST: "sentry.io",
  } as Env;

  return {
    ...baseEnv,
    OAUTH_PROVIDER: createOAuthApi(baseEnv),
  };
}

async function createClient(testEnv: Env, name = "Test Client") {
  return testEnv.OAUTH_PROVIDER.createClient({
    clientName: name,
    redirectUris: [REDIRECT_URI],
    tokenEndpointAuthMethod: "none",
  });
}

async function createSignedCallbackState(
  clientId: string,
  resource?: string,
  skills: string[] = ["inspect"],
): Promise<string> {
  const now = Date.now();
  const payload: OAuthState = {
    req: {
      clientId,
      redirectUri: REDIRECT_URI,
      responseType: "code",
      scope: ["org:read"],
      skills,
      codeChallenge: PKCE_CODE_CHALLENGE,
      codeChallengeMethod: "S256",
      ...(resource ? { resource } : {}),
    },
    iat: now,
    exp: now + 10 * 60 * 1000,
  } as unknown as OAuthState;

  return signState(payload, COOKIE_SECRET);
}

async function approveClient(
  oauthApp: ReturnType<typeof createTestApp>,
  testEnv: Env,
  clientId: string,
  resource?: string,
) {
  const approvalState = await signState(
    {
      req: {
        oauthReqInfo: {
          clientId,
          redirectUri: REDIRECT_URI,
          responseType: "code",
          scope: ["org:read"],
          ...(resource ? { resource } : {}),
        },
      },
      iat: Date.now(),
      exp: Date.now() + 10 * 60 * 1000,
    },
    COOKIE_SECRET,
  );
  const formData = new FormData();
  formData.append("state", approvalState);
  formData.append("skill", "inspect");

  const response = await oauthApp.fetch(
    new Request("http://localhost/oauth/authorize", {
      method: "POST",
      body: formData,
    }),
    testEnv,
  );

  expect(response.status).toBe(302);

  return response.headers.get("Set-Cookie")?.split(";")[0];
}

async function callCallback(
  oauthApp: ReturnType<typeof createTestApp>,
  testEnv: Env,
  options: {
    state: string;
    cookie?: string;
    code?: string;
    error?: string;
    errorDescription?: string;
  },
) {
  const url = new URL("http://localhost/oauth/callback");
  url.searchParams.set("state", options.state);
  if (options.code) {
    url.searchParams.set("code", options.code);
  }
  if (options.error) {
    url.searchParams.set("error", options.error);
  }
  if (options.errorDescription) {
    url.searchParams.set("error_description", options.errorDescription);
  }

  return oauthApp.fetch(
    new Request(url, {
      method: "GET",
      headers: options.cookie ? { Cookie: options.cookie } : undefined,
    }),
    testEnv,
  );
}

function createTokenExchangeRequest(clientId: string, code: string) {
  return new Request("https://mcp.sentry.dev/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: PKCE_CODE_VERIFIER,
    }).toString(),
  });
}

function createMcpInitializeRequest(accessToken: string, path = "/mcp") {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "CF-Connecting-IP": "192.0.2.1",
      Host: "localhost",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "callback-test-client", version: "1.0.0" },
      },
    }),
  });
}

async function parseSseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));

  if (!dataLine) {
    throw new Error(`No SSE payload found in response: ${text}`);
  }

  return JSON.parse(dataLine.slice(6)) as T;
}

describe("oauth callback routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logError.mockReturnValue(undefined);
    logIssue.mockReturnValue(undefined);
    logWarn.mockReturnValue(undefined);
    exchangeCodeForAccessToken.mockResolvedValue([
      {
        access_token: "sentry-access-token",
        refresh_token: "sentry-refresh-token",
        expires_in: 3600,
        user: {
          id: "user-123",
          name: "Test User",
        },
      },
      null,
    ]);
  });

  describe("GET /oauth/callback", () => {
    it("rejects callback with invalid state param", async () => {
      const oauthApp = createTestApp();
      const response = await oauthApp.fetch(
        new Request(
          "http://localhost/oauth/callback?code=test-code&state=%%%INVALID%%%",
        ),
        createTestEnv(),
      );

      expect(response.status).toBe(400);
      expect(await response.text()).toBe("Invalid state");
    });

    it("accepts an ephemeral loopback port against a portless CIMD registration", async () => {
      const loopbackRedirectUri = "http://localhost:3118/callback";
      const testEnv = createTestEnv();
      const oauthApp = createTestApp();
      const client = await testEnv.OAUTH_PROVIDER.createClient({
        clientName: "Claude Code",
        redirectUris: [
          "http://localhost/callback",
          "http://127.0.0.1/callback",
        ],
        tokenEndpointAuthMethod: "none",
      });

      const approvalState = await signState(
        {
          req: {
            oauthReqInfo: {
              clientId: client.clientId,
              redirectUri: loopbackRedirectUri,
              responseType: "code",
              scope: ["org:read"],
            },
          },
          iat: Date.now(),
          exp: Date.now() + 10 * 60 * 1000,
        },
        COOKIE_SECRET,
      );
      const formData = new FormData();
      formData.append("state", approvalState);
      formData.append("skill", "inspect");
      const approval = await oauthApp.fetch(
        new Request("http://localhost/oauth/authorize", {
          method: "POST",
          body: formData,
        }),
        testEnv,
      );
      expect(approval.status).toBe(302);
      const cookie = approval.headers.get("Set-Cookie")?.split(";")[0];

      const now = Date.now();
      const state = await signState(
        {
          req: {
            clientId: client.clientId,
            redirectUri: loopbackRedirectUri,
            responseType: "code",
            scope: ["org:read"],
            skills: ["inspect"],
            codeChallenge: PKCE_CODE_CHALLENGE,
            codeChallengeMethod: "S256",
          },
          iat: now,
          exp: now + 10 * 60 * 1000,
        } as unknown as OAuthState,
        COOKIE_SECRET,
      );

      const response = await callCallback(oauthApp, testEnv, {
        state,
        cookie,
        code: "test-code",
      });

      expect(response.status).toBe(302);
    });

    it("renders a safe upstream oauth error page and skips token exchange", async () => {
      const testEnv = createTestEnv();
      const oauthApp = createTestApp();
      const client = await createClient(testEnv);
      const cookie = await approveClient(oauthApp, testEnv, client.clientId);
      const state = await createSignedCallbackState(client.clientId);

      const response = await callCallback(oauthApp, testEnv, {
        state,
        cookie,
        error: "access_denied",
        errorDescription: "The user denied access",
      });

      const body = await response.text();
      expect(response.status).toBe(400);
      expect(body).toContain("OAuth Error:</strong> access_denied");
      expect(body).toContain("Authorization was denied");
      expect(body).not.toContain("Event ID:");
      expect(logWarn).toHaveBeenCalledWith(
        "[oauth] Upstream authorization callback error",
        expect.objectContaining({
          loggerScope: ["cloudflare", "oauth", "callback"],
        }),
      );
      expect(logIssue).not.toHaveBeenCalled();
      expect(exchangeCodeForAccessToken).not.toHaveBeenCalled();
    });

    it("renders an event ID for upstream system oauth errors", async () => {
      logIssue.mockReturnValue("oauth-event-id");

      const testEnv = createTestEnv();
      const oauthApp = createTestApp();
      const client = await createClient(testEnv);
      const cookie = await approveClient(oauthApp, testEnv, client.clientId);
      const state = await createSignedCallbackState(client.clientId);

      const response = await callCallback(oauthApp, testEnv, {
        state,
        cookie,
        error: "server_error",
      });

      const body = await response.text();
      expect(response.status).toBe(502);
      expect(body).toContain("Sentry OAuth encountered an internal error");
      expect(body).toContain("Event ID:</strong> <code>oauth-event-id</code>");
      expect(logIssue).toHaveBeenCalledWith(
        "[oauth] Upstream authorization callback error",
        expect.objectContaining({
          loggerScope: ["cloudflare", "oauth", "callback"],
        }),
      );
      expect(logWarn).not.toHaveBeenCalled();
      expect(exchangeCodeForAccessToken).not.toHaveBeenCalled();
    });

    it("treats invalid_request callback errors as user-correctable", async () => {
      const testEnv = createTestEnv();
      const oauthApp = createTestApp();
      const client = await createClient(testEnv);
      const cookie = await approveClient(oauthApp, testEnv, client.clientId);
      const state = await createSignedCallbackState(client.clientId);

      const response = await callCallback(oauthApp, testEnv, {
        state,
        cookie,
        error: "invalid_request",
      });

      const body = await response.text();
      expect(response.status).toBe(400);
      expect(body).toContain(
        "The authorization request was rejected. Please try again.",
      );
      expect(body).not.toContain("Event ID:");
      expect(logWarn).toHaveBeenCalledWith(
        "[oauth] Upstream authorization callback error",
        expect.objectContaining({
          loggerScope: ["cloudflare", "oauth", "callback"],
        }),
      );
      expect(logIssue).not.toHaveBeenCalled();
      expect(exchangeCodeForAccessToken).not.toHaveBeenCalled();
    });

    it("treats unknown callback errors as system failures", async () => {
      logIssue.mockReturnValue("oauth-event-id");

      const testEnv = createTestEnv();
      const oauthApp = createTestApp();
      const client = await createClient(testEnv);
      const cookie = await approveClient(oauthApp, testEnv, client.clientId);
      const state = await createSignedCallbackState(client.clientId);

      const response = await callCallback(oauthApp, testEnv, {
        state,
        cookie,
        error: "provider_broke_it",
      });

      const body = await response.text();
      expect(response.status).toBe(502);
      expect(body).toContain(
        "There was an internal error authenticating your account. Please try again shortly.",
      );
      expect(body).toContain("Event ID:</strong> <code>oauth-event-id</code>");
      expect(logIssue).toHaveBeenCalledWith(
        "[oauth] Upstream authorization callback error",
        expect.objectContaining({
          loggerScope: ["cloudflare", "oauth", "callback"],
        }),
      );
      expect(logWarn).not.toHaveBeenCalled();
      expect(exchangeCodeForAccessToken).not.toHaveBeenCalled();
    });

    it("renders a safe error page when the callback is missing a code", async () => {
      const testEnv = createTestEnv();
      const oauthApp = createTestApp();
      const client = await createClient(testEnv);
      const cookie = await approveClient(oauthApp, testEnv, client.clientId);
      const state = await createSignedCallbackState(client.clientId);

      const response = await callCallback(oauthApp, testEnv, {
        state,
        cookie,
      });

      const body = await response.text();
      expect(response.status).toBe(400);
      expect(body).toContain("did not include an authorization code");
      expect(exchangeCodeForAccessToken).not.toHaveBeenCalled();
    });

    it("rejects callback without approved client cookie", async () => {
      const testEnv = createTestEnv();
      const oauthApp = createTestApp();
      const client = await createClient(testEnv);
      const state = await createSignedCallbackState(client.clientId);

      const response = await callCallback(oauthApp, testEnv, {
        state,
        code: "test-code",
      });

      expect(response.status).toBe(403);
      expect(await response.text()).toBe(
        "Authorization failed: Client not approved",
      );
    });

    it("rejects callback with invalid client approval cookie", async () => {
      const testEnv = createTestEnv();
      const oauthApp = createTestApp();
      const client = await createClient(testEnv);
      const state = await createSignedCallbackState(client.clientId);

      const response = await callCallback(oauthApp, testEnv, {
        state,
        code: "test-code",
        cookie: "mcp-approved-clients=invalid-cookie-value",
      });

      expect(response.status).toBe(403);
      expect(await response.text()).toBe(
        "Authorization failed: Client not approved",
      );
    });

    it("rejects callback with legacy preprod skill selection", async () => {
      const testEnv = createTestEnv();
      const oauthApp = createTestApp();
      const client = await createClient(testEnv);
      const cookie = await approveClient(oauthApp, testEnv, client.clientId);
      const state = await createSignedCallbackState(
        client.clientId,
        undefined,
        ["preprod"],
      );

      const response = await callCallback(oauthApp, testEnv, {
        state,
        code: "test-code",
        cookie,
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain(
        "You must select at least one valid permission",
      );
    });

    it("rejects callback with cookie for different client", async () => {
      const testEnv = createTestEnv();
      const oauthApp = createTestApp();
      const approvedClient = await createClient(testEnv, "Approved Client");
      const otherClient = await createClient(testEnv, "Other Client");
      const cookie = await approveClient(
        oauthApp,
        testEnv,
        approvedClient.clientId,
      );
      const state = await createSignedCallbackState(otherClient.clientId);

      const response = await callCallback(oauthApp, testEnv, {
        state,
        code: "test-code",
        cookie,
      });

      expect(response.status).toBe(403);
      expect(await response.text()).toBe(
        "Authorization failed: Client not approved",
      );
    });

    it("rejects callback when state signature is tampered", async () => {
      const testEnv = createTestEnv();
      const oauthApp = createTestApp();
      const client = await createClient(testEnv);
      const cookie = await approveClient(oauthApp, testEnv, client.clientId);
      const signedState = await createSignedCallbackState(client.clientId);
      const [signature, payload] = signedState.split(".");
      const tamperedDigit = signature.endsWith("a") ? "b" : "a";
      const tamperedState = `${signature.slice(0, -1)}${tamperedDigit}.${payload}`;

      const response = await callCallback(oauthApp, testEnv, {
        state: tamperedState,
        code: "test-code",
        cookie,
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toBe("Invalid state");
    });

    it.each([
      undefined,
      "http://localhost/mcp",
      "http://localhost/mcp?experimental=1",
      "http://localhost/mcp/test-org",
      "http://localhost/mcp/test-org/test-project",
    ])("accepts callback with resource %s", async (resource) => {
      const testEnv = createTestEnv();
      const oauthApp = createTestApp();
      const client = await createClient(testEnv);
      const cookie = await approveClient(
        oauthApp,
        testEnv,
        client.clientId,
        resource,
      );
      const state = await createSignedCallbackState(client.clientId, resource);

      const response = await callCallback(oauthApp, testEnv, {
        state,
        code: "test-code",
        cookie,
      });

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain(REDIRECT_URI);
      expect(response.headers.get("location")).toContain("code=");
      expect(
        new URL(response.headers.get("location")!).searchParams.get("iss"),
      ).toBe("http://localhost");
    });

    it("completes callback, exchanges the code, and uses the resulting token at /mcp", async () => {
      const testEnv = createTestEnv();
      const oauthApp = createTestApp();
      const client = await createClient(testEnv);
      const cookie = await approveClient(
        oauthApp,
        testEnv,
        client.clientId,
        "http://localhost/mcp",
      );
      const state = await createSignedCallbackState(
        client.clientId,
        "http://localhost/mcp",
      );

      const callbackResponse = await callCallback(oauthApp, testEnv, {
        state,
        code: "test-code",
        cookie,
      });

      expect(callbackResponse.status).toBe(302);

      const redirectUrl = new URL(callbackResponse.headers.get("location")!);
      const authorizationCode = redirectUrl.searchParams.get("code");

      expect(authorizationCode).toBeTruthy();
      expect(redirectUrl.searchParams.get("iss")).toBe("http://localhost");

      const tokenCtx = createExecutionContext();
      const tokenResponse = await handler.fetch!(
        createTokenExchangeRequest(client.clientId, authorizationCode!),
        testEnv,
        tokenCtx,
      );

      expect(tokenResponse.status).toBe(200);

      const tokenPayload = (await tokenResponse.json()) as {
        access_token: string;
        token_type: string;
        resource?: string;
      };

      expect(tokenPayload.access_token).toBeTruthy();
      expect(tokenPayload.token_type).toBe("bearer");
      expect(tokenPayload.resource).toBe("http://localhost/mcp");

      const mcpCtx = createExecutionContext();
      const mcpResponse = await handler.fetch!(
        createMcpInitializeRequest(tokenPayload.access_token),
        testEnv,
        mcpCtx,
      );

      expect(mcpResponse.status).toBe(200);
      const body = await parseSseJson<{
        result?: { protocolVersion: string };
      }>(mcpResponse);
      expect(body.result?.protocolVersion).toBeDefined();
    });

    it("stores the scopes Sentry actually granted alongside skill-derived grantedScopes", async () => {
      // Sentry returns the token's real scopes in the token response. With
      // only `inspect` selected, skill-derived grantedScopes are read-only,
      // but the upstream token can still carry write scopes.
      exchangeCodeForAccessToken.mockResolvedValueOnce([
        {
          access_token: "sentry-access-token",
          refresh_token: "sentry-refresh-token",
          expires_in: 3600,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          token_type: "bearer",
          user: { id: "user-123", name: "Test User" },
          scope: "team:write org:read event:write  project:write alerts:write",
        },
        null,
      ]);

      const testEnv = createTestEnv();
      const completeAuthorization = vi.spyOn(
        testEnv.OAUTH_PROVIDER,
        "completeAuthorization",
      );
      const oauthApp = createTestApp();
      const client = await createClient(testEnv);
      const cookie = await approveClient(oauthApp, testEnv, client.clientId);
      const state = await createSignedCallbackState(client.clientId);

      const callbackResponse = await callCallback(oauthApp, testEnv, {
        state,
        code: "test-code",
        cookie,
      });

      expect(callbackResponse.status).toBe(302);
      expect(completeAuthorization).toHaveBeenCalledOnce();
      const props = completeAuthorization.mock.calls[0]![0].props as Record<
        string,
        unknown
      >;

      expect(props.upstreamScopes).toEqual([
        "alerts:write",
        "event:write",
        "org:read",
        "project:write",
        "team:write",
      ]);
      expect(props.grantedSkills).toEqual(["inspect"]);
      expect(props.grantedScopes).not.toEqual(props.upstreamScopes);
    });

    it("omits upstreamScopes when Sentry's token response has no scope", async () => {
      const testEnv = createTestEnv();
      const completeAuthorization = vi.spyOn(
        testEnv.OAUTH_PROVIDER,
        "completeAuthorization",
      );
      const oauthApp = createTestApp();
      const client = await createClient(testEnv);
      const cookie = await approveClient(oauthApp, testEnv, client.clientId);
      const state = await createSignedCallbackState(client.clientId);

      const callbackResponse = await callCallback(oauthApp, testEnv, {
        state,
        code: "test-code",
        cookie,
      });

      expect(callbackResponse.status).toBe(302);
      const props = completeAuthorization.mock.calls[0]![0].props as Record<
        string,
        unknown
      >;
      expect(props.upstreamScopes).toBeUndefined();
    });

    it("completes callback for a scoped resource, exchanges the code, and uses the token at the same scoped /mcp path", async () => {
      const scopedResource =
        "http://localhost/mcp/sentry-mcp-evals/cloudflare-mcp";
      const testEnv = createTestEnv();
      const oauthApp = createTestApp();
      const client = await createClient(testEnv);
      const cookie = await approveClient(
        oauthApp,
        testEnv,
        client.clientId,
        scopedResource,
      );
      const state = await createSignedCallbackState(
        client.clientId,
        scopedResource,
      );

      const callbackResponse = await callCallback(oauthApp, testEnv, {
        state,
        code: "test-code",
        cookie,
      });

      expect(callbackResponse.status).toBe(302);

      const redirectUrl = new URL(callbackResponse.headers.get("location")!);
      const authorizationCode = redirectUrl.searchParams.get("code");

      expect(authorizationCode).toBeTruthy();
      expect(redirectUrl.searchParams.get("iss")).toBe("http://localhost");

      const tokenCtx = createExecutionContext();
      const tokenResponse = await handler.fetch!(
        createTokenExchangeRequest(client.clientId, authorizationCode!),
        testEnv,
        tokenCtx,
      );

      expect(tokenResponse.status).toBe(200);

      const tokenPayload = (await tokenResponse.json()) as {
        access_token: string;
        resource?: string;
      };

      expect(tokenPayload.resource).toBe(scopedResource);

      const mcpCtx = createExecutionContext();
      const mcpResponse = await handler.fetch!(
        createMcpInitializeRequest(
          tokenPayload.access_token,
          "/mcp/sentry-mcp-evals/cloudflare-mcp",
        ),
        testEnv,
        mcpCtx,
      );

      expect(mcpResponse.status).toBe(200);
      const body = await parseSseJson<{
        result?: { protocolVersion: string };
      }>(mcpResponse);
      expect(body.result?.protocolVersion).toBeDefined();
    });

    it.each([
      "http://localhost/",
      "https://attacker.com/mcp",
      "http://localhost/api",
      "http://localhost#",
    ])("rejects callback with invalid resource %s", async (resource) => {
      const testEnv = createTestEnv();
      const oauthApp = createTestApp();
      const client = await createClient(testEnv);
      const cookie = await approveClient(oauthApp, testEnv, client.clientId);
      const state = await createSignedCallbackState(client.clientId, resource);

      const response = await callCallback(oauthApp, testEnv, {
        state,
        code: "test-code",
        cookie,
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain("Invalid resource parameter");
    });
  });
});
