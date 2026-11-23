import { createExecutionContext, env } from "cloudflare:test";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCOPES } from "../constants";
import { PKCE_CODE_CHALLENGE, PKCE_CODE_VERIFIER } from "../test-utils/pkce";
import app from "./app";
import handler from "./index";
import mcpHandler from "./lib/mcp-handler";
import { tokenExchangeCallback } from "./oauth";
import type { Env, WorkerProps } from "./types";

const workerEnv = {
  ...(env as Record<string, unknown>),
  CF_VERSION_METADATA: {
    id: "test-version-id",
  },
} as Env;

const REDIRECT_URI = "https://example.com/callback";
const DEFAULT_WORKER_PROPS: WorkerProps = {
  id: "test-user-123",
  accessToken: "upstream-access-token",
  refreshToken: "upstream-refresh-token",
  accessTokenExpiresAt: Date.now() + 10 * 60 * 1000,
  clientId: "",
  scope: "org:read",
  grantedSkills: ["inspect", "docs"],
};

function createOAuthApi() {
  return getOAuthApi(
    {
      apiRoute: "/mcp",
      apiHandler: mcpHandler,
      defaultHandler: app,
      authorizeEndpoint: "/oauth/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      tokenExchangeCallback: (options) =>
        tokenExchangeCallback(
          options,
          workerEnv,
          new Request("https://mcp.sentry.dev/oauth/token", {
            headers: { "CF-Connecting-IP": "192.0.2.1" },
          }),
          "unknown",
        ),
      scopesSupported: Object.keys(SCOPES),
    },
    workerEnv,
  );
}

function createAuthRequest(clientId: string, resource: string) {
  const url = new URL("https://mcp.sentry.dev/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", "org:read");
  url.searchParams.set("state", "test-state");
  url.searchParams.set("resource", resource);
  url.searchParams.set("code_challenge", PKCE_CODE_CHALLENGE);
  url.searchParams.set("code_challenge_method", "S256");

  return new Request(url);
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

function createRefreshTokenRequest(clientId: string, refreshToken: string) {
  return new Request("https://mcp.sentry.dev/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
    }).toString(),
  });
}

function createMcpRequest(
  path: string,
  accessToken: string,
  method: string,
  params: Record<string, unknown>,
) {
  return new Request(`https://mcp.sentry.dev${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "CF-Connecting-IP": "192.0.2.1",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  resource?: string;
}

async function issueTokens(
  resource: string,
  propsOverrides?: Partial<WorkerProps>,
): Promise<{ clientId: string; tokens: TokenResponse }> {
  const oauthApi = createOAuthApi();
  const client = await oauthApi.createClient({
    clientName: "MCP Integration Test Client",
    redirectUris: [REDIRECT_URI],
    tokenEndpointAuthMethod: "none",
  });
  const authRequest = await oauthApi.parseAuthRequest(
    createAuthRequest(client.clientId, resource),
  );
  const props: WorkerProps = {
    ...DEFAULT_WORKER_PROPS,
    ...propsOverrides,
    clientId: client.clientId,
  };
  const { redirectTo } = await oauthApi.completeAuthorization({
    request: authRequest,
    userId: props.id,
    metadata: {
      clientName: client.clientName,
    },
    scope: ["org:read"],
    props,
  });
  const redirectUrl = new URL(redirectTo);
  const code = redirectUrl.searchParams.get("code");

  expect(code).toBeTruthy();

  const tokenCtx = createExecutionContext();
  const tokenResponse = await handler.fetch(
    createTokenExchangeRequest(client.clientId, code!),
    workerEnv,
    tokenCtx,
  );

  expect(tokenResponse.status).toBe(200);

  const tokens = await tokenResponse.json<TokenResponse>();

  expect(tokens.token_type).toBe("bearer");
  expect(tokens.resource).toBe(resource);

  return { clientId: client.clientId, tokens };
}

async function issueAccessToken(resource: string) {
  const { tokens } = await issueTokens(resource);
  return tokens.access_token;
}

async function parseSseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));

  if (!dataLine) {
    throw new Error(`No SSE payload found in response: ${text}`);
  }

  return JSON.parse(dataLine.slice(6)) as T;
}

describe("/mcp", () => {
  it("authenticates through /oauth/token and serves MCP requests at /mcp", async () => {
    const accessToken = await issueAccessToken("https://mcp.sentry.dev/mcp");

    const ctx = createExecutionContext();
    const response = await handler.fetch(
      createMcpRequest("/mcp", accessToken, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "integration-test-client", version: "1.0.0" },
      }),
      workerEnv,
      ctx,
    );

    expect(response.status).toBe(200);

    const body = await parseSseJson<{
      result?: { protocolVersion: string };
    }>(response);
    expect(body.result?.protocolVersion).toBeDefined();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("authenticates through /oauth/token and serves scoped MCP requests", async () => {
    const accessToken = await issueAccessToken(
      "https://mcp.sentry.dev/mcp/sentry-mcp-evals",
    );

    const ctx = createExecutionContext();
    const response = await handler.fetch(
      createMcpRequest("/mcp/sentry-mcp-evals", accessToken, "tools/list", {}),
      workerEnv,
      ctx,
    );

    expect(response.status).toBe(200);

    const body = await parseSseJson<{
      result?: { tools: Array<{ name: string }> };
    }>(response);
    expect(body.result?.tools.length).toBeGreaterThan(0);
  });

  it("does not accept a scoped token at a different tenant path", async () => {
    const accessToken = await issueAccessToken(
      "https://mcp.sentry.dev/mcp/org-a/project-a",
    );

    const ctx = createExecutionContext();
    const response = await handler.fetch(
      createMcpRequest("/mcp/org-b/project-b", accessToken, "tools/list", {}),
      workerEnv,
      ctx,
    );

    expect(response.status).toBe(401);
  });

  it("refreshes token and serves MCP requests when upstream token is valid", async () => {
    const { clientId, tokens } = await issueTokens(
      "https://mcp.sentry.dev/mcp",
      { accessTokenExpiresAt: Date.now() + 10 * 60 * 1000 },
    );

    expect(tokens.refresh_token).toBeTruthy();

    // Refresh the token
    const refreshCtx = createExecutionContext();
    const refreshResponse = await handler.fetch(
      createRefreshTokenRequest(clientId, tokens.refresh_token!),
      workerEnv,
      refreshCtx,
    );

    expect(refreshResponse.status).toBe(200);

    const refreshed = await refreshResponse.json<TokenResponse>();
    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.access_token).not.toBe(tokens.access_token);

    // Use the refreshed token for an MCP request
    const mcpCtx = createExecutionContext();
    const mcpResponse = await handler.fetch(
      createMcpRequest("/mcp", refreshed.access_token, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "integration-test-client", version: "1.0.0" },
      }),
      workerEnv,
      mcpCtx,
    );

    expect(mcpResponse.status).toBe(200);

    const body = await parseSseJson<{
      result?: { protocolVersion: string };
    }>(mcpResponse);
    expect(body.result?.protocolVersion).toBeDefined();
  });

  it("refreshes via upstream probe and serves MCP requests when clock says expired", async () => {
    const { clientId, tokens } = await issueTokens(
      "https://mcp.sentry.dev/mcp",
      { accessTokenExpiresAt: Date.now() - 60 * 1000 },
    );

    expect(tokens.refresh_token).toBeTruthy();

    // Mock only Sentry API calls, let everything else through
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.includes("/api/0/")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ id: "1", name: "Test", email: "test@test.com" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return originalFetch(input, init);
    });

    // Refresh the token (probe succeeds)
    const refreshCtx = createExecutionContext();
    const refreshResponse = await handler.fetch(
      createRefreshTokenRequest(clientId, tokens.refresh_token!),
      workerEnv,
      refreshCtx,
    );

    expect(refreshResponse.status).toBe(200);

    const refreshed = await refreshResponse.json<TokenResponse>();
    expect(refreshed.access_token).toBeTruthy();

    // Verify the upstream probe was actually called
    const fetchCalls = vi.mocked(globalThis.fetch).mock.calls;
    const probeCalled = fetchCalls.some(([input]) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      return url.includes("/api/0/");
    });
    expect(probeCalled).toBe(true);

    // Restore fetch so MCP request works normally
    vi.restoreAllMocks();

    // Use the refreshed token for an MCP request
    const mcpCtx = createExecutionContext();
    const mcpResponse = await handler.fetch(
      createMcpRequest("/mcp", refreshed.access_token, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "integration-test-client", version: "1.0.0" },
      }),
      workerEnv,
      mcpCtx,
    );

    expect(mcpResponse.status).toBe(200);

    const body = await parseSseJson<{
      result?: { protocolVersion: string };
    }>(mcpResponse);
    expect(body.result?.protocolVersion).toBeDefined();
  });

  it("reissues an MCP token on refresh when the upstream token probes invalid, and the resulting token fails even at root /mcp", async () => {
    const { clientId, tokens } = await issueTokens(
      "https://mcp.sentry.dev/mcp",
      {
        accessTokenExpiresAt: Date.now() - 60 * 1000,
      },
    );

    expect(tokens.refresh_token).toBeTruthy();

    const originalFetch = globalThis.fetch;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input, init) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;

        if (url.includes("/api/0/")) {
          return Promise.resolve(
            new Response(JSON.stringify({ detail: "Invalid token" }), {
              status: 401,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }

        return originalFetch(input, init);
      });

    const refreshCtx = createExecutionContext();
    const refreshResponse = await handler.fetch(
      createRefreshTokenRequest(clientId, tokens.refresh_token!),
      workerEnv,
      refreshCtx,
    );

    expect(refreshResponse.status).toBe(200);

    const refreshed = await refreshResponse.json<TokenResponse>();
    expect(refreshed.access_token).toBeTruthy();

    const mcpCtx = createExecutionContext();
    const mcpResponse = await handler.fetch(
      createMcpRequest("/mcp", refreshed.access_token, "tools/list", {}),
      workerEnv,
      mcpCtx,
    );

    expect(mcpResponse.status).toBe(401);
    fetchSpy.mockRestore();
  });

  it("reissues an MCP token on refresh when verification is indeterminate, and the resulting token fails at constrained /mcp", async () => {
    const { clientId, tokens } = await issueTokens(
      "https://mcp.sentry.dev/mcp",
      {
        accessTokenExpiresAt: Date.now() - 60 * 1000,
      },
    );

    expect(tokens.refresh_token).toBeTruthy();

    const originalFetch = globalThis.fetch;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input, init) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;

        if (url.includes("/api/0/")) {
          return Promise.reject(new Error("Network error"));
        }

        return originalFetch(input, init);
      });

    const refreshCtx = createExecutionContext();
    const refreshResponse = await handler.fetch(
      createRefreshTokenRequest(clientId, tokens.refresh_token!),
      workerEnv,
      refreshCtx,
    );

    expect(refreshResponse.status).toBe(200);

    const refreshed = await refreshResponse.json<TokenResponse>();
    expect(refreshed.access_token).toBeTruthy();

    const mcpCtx = createExecutionContext();
    const mcpResponse = await handler.fetch(
      createMcpRequest(
        "/mcp/sentry-mcp-evals",
        refreshed.access_token,
        "tools/list",
        {},
      ),
      workerEnv,
      mcpCtx,
    );

    expect(mcpResponse.status).toBe(502);
    fetchSpy.mockRestore();
  });
});
