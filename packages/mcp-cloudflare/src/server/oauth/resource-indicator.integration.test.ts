import { createExecutionContext, env } from "cloudflare:test";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { describe, expect, it } from "vitest";
import { SCOPES } from "../../constants";
import { createPkcePair } from "../../test-utils/pkce";
import app from "../app";
import handler from "../index";
import mcpHandler from "../lib/mcp-handler";
import type { Env, WorkerProps } from "../types";
import { CLIENT_ID_METADATA_DOCUMENTS } from "./client-metadata";

// Clients disagree about whether the RFC 8707 `resource` carries the query
// string of the configured MCP URL (`?utm_source=plugin`, `?codemode=false`)
// or a trailing slash. A login with one form followed by a token request with
// the other must not fail with `invalid_target`, and the issued token must
// still work on the MCP URL the client dials.

const ORIGIN = "https://mcp.sentry.dev";
const REDIRECT_URI = "http://127.0.0.1:43127/callback";
const workerEnv = {
  ...(env as Record<string, unknown>),
  CF_VERSION_METADATA: { id: "test-version-id" },
} as Env;

function createOAuthApi() {
  return getOAuthApi(
    {
      apiRoute: "/mcp",
      apiHandler: mcpHandler,
      defaultHandler: app,
      authorizeEndpoint: "/oauth/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      clientIdMetadataDocumentEnabled: true,
      clientIdMetadataDocuments: CLIENT_ID_METADATA_DOCUMENTS,
      scopesSupported: Object.keys(SCOPES),
    },
    workerEnv,
  );
}

async function authorize(resource: string) {
  const oauthApi = createOAuthApi();
  const client = await oauthApi.createClient({
    clientName: "resource indicator test client",
    redirectUris: [REDIRECT_URI],
    tokenEndpointAuthMethod: "none",
  });
  const { codeVerifier, codeChallenge } = await createPkcePair();
  const url = new URL("/oauth/authorize", ORIGIN);
  for (const [name, value] of Object.entries({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: REDIRECT_URI,
    scope: "org:read",
    state: "test-state",
    resource,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  })) {
    url.searchParams.set(name, value);
  }
  const request = await oauthApi.parseAuthRequest(new Request(url));
  const { redirectTo } = await oauthApi.completeAuthorization({
    request,
    userId: "test-user-123",
    metadata: {},
    scope: ["org:read"],
    props: {
      id: "test-user-123",
      clientId: client.clientId,
      accessToken: "upstream-access-token",
      refreshToken: "upstream-refresh-token",
      accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
      scope: "org:read",
      grantedSkills: ["inspect"],
    } satisfies WorkerProps,
    revokeExistingGrants: false,
  });
  const code = new URL(redirectTo).searchParams.get("code");
  if (!code) throw new Error("Authorization did not issue a code");
  return { clientId: client.clientId, code, codeVerifier };
}

function requestToken(parameters: Record<string, string>) {
  return handler.fetch(
    new Request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(parameters).toString(),
    }),
    workerEnv,
    createExecutionContext(),
  );
}

async function exchangeCode(
  authorization: Awaited<ReturnType<typeof authorize>>,
  resource: string,
) {
  return await requestToken({
    grant_type: "authorization_code",
    client_id: authorization.clientId,
    redirect_uri: REDIRECT_URI,
    code: authorization.code,
    code_verifier: authorization.codeVerifier,
    resource,
  });
}

function callMcp(path: string, accessToken: string) {
  return handler.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "resource-indicator-test", version: "1.0.0" },
        },
      }),
    }),
    workerEnv,
    createExecutionContext(),
  );
}

async function expectAccepted(path: string, accessToken: string) {
  const response = await callMcp(path, accessToken);
  expect(response.status).toBe(200);
  await response.body?.cancel();
}

describe("RFC 8707 resource indicators that differ only by query or trailing slash", () => {
  it("exchanges a code when the login carried the query and the token request does not", async () => {
    const authorization = await authorize(`${ORIGIN}/mcp?utm_source=plugin`);
    const response = await exchangeCode(authorization, `${ORIGIN}/mcp`);
    expect(response.status).toBe(200);
    const tokens = await response.json<{ access_token: string }>();
    await expectAccepted("/mcp?utm_source=plugin", tokens.access_token);
    await expectAccepted("/mcp", tokens.access_token);
  });

  it("refreshes when the refresh request adds a query the login did not have", async () => {
    const authorization = await authorize(`${ORIGIN}/mcp`);
    const exchange = await exchangeCode(authorization, `${ORIGIN}/mcp`);
    expect(exchange.status).toBe(200);
    const { refresh_token } = await exchange.json<{ refresh_token: string }>();

    const refresh = await requestToken({
      grant_type: "refresh_token",
      client_id: authorization.clientId,
      refresh_token,
      resource: `${ORIGIN}/mcp?codemode=false`,
    });
    expect(refresh.status).toBe(200);
    const tokens = await refresh.json<{ access_token: string }>();
    await expectAccepted("/mcp", tokens.access_token);
    await expectAccepted("/mcp?codemode=false", tokens.access_token);
  });

  it("exchanges a code when only a trailing slash differs", async () => {
    const authorization = await authorize(`${ORIGIN}/mcp/`);
    const response = await exchangeCode(authorization, `${ORIGIN}/mcp`);
    expect(response.status).toBe(200);
    const tokens = await response.json<{ access_token: string }>();
    await expectAccepted("/mcp", tokens.access_token);
  });

  it("accepts an existing token whose audience carries a query on the bare MCP URL", async () => {
    const authorization = await authorize(`${ORIGIN}/mcp?utm_source=plugin`);
    const response = await exchangeCode(
      authorization,
      `${ORIGIN}/mcp?utm_source=plugin`,
    );
    expect(response.status).toBe(200);
    const tokens = await response.json<{ access_token: string }>();
    await expectAccepted("/mcp", tokens.access_token);
  });

  it("still rejects a token request for a different MCP path", async () => {
    const authorization = await authorize(`${ORIGIN}/mcp/sentry`);
    const response = await exchangeCode(authorization, `${ORIGIN}/mcp/other`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_target" });
  });

  it("still rejects a token scoped to one organization on another organization's URL", async () => {
    const authorization = await authorize(
      `${ORIGIN}/mcp/sentry?utm_source=plugin`,
    );
    const response = await exchangeCode(authorization, `${ORIGIN}/mcp/sentry`);
    expect(response.status).toBe(200);
    const tokens = await response.json<{ access_token: string }>();
    const other = await callMcp("/mcp/other", tokens.access_token);
    expect(other.status).toBe(401);
    expect(other.headers.get("WWW-Authenticate")).toContain("Invalid audience");
    await other.body?.cancel();
  });
});
