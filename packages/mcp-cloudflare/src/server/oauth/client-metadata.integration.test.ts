import { createExecutionContext, env } from "cloudflare:test";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCOPES } from "../../constants";
import { createPkcePair, PKCE_CODE_CHALLENGE } from "../../test-utils/pkce";
import app from "../app";
import handler from "../index";
import mcpHandler from "../lib/mcp-handler";
import type { Env, WorkerProps } from "../types";
import { CLIENT_ID_METADATA_DOCUMENTS } from "./client-metadata";

const CODEX_CLIENT_ID = "https://chatgpt.com/oauth/codex/client.json";
const ORIGIN = "https://mcp.sentry.dev";
const REDIRECT_URI = "http://127.0.0.1:43127/callback";
const workerEnv = {
  ...(env as Record<string, unknown>),
  CF_VERSION_METADATA: { id: "test-version-id" },
} as Env;

function createOAuthApi(
  documents: Readonly<Record<string, unknown>> = CLIENT_ID_METADATA_DOCUMENTS,
) {
  return getOAuthApi(
    {
      apiRoute: "/mcp",
      apiHandler: mcpHandler,
      defaultHandler: app,
      authorizeEndpoint: "/oauth/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      clientIdMetadataDocumentEnabled: true,
      clientIdMetadataDocuments: documents,
      scopesSupported: Object.keys(SCOPES),
    },
    workerEnv,
  );
}

function createAuthorizationRequest(
  clientId = CODEX_CLIENT_ID,
  overrides: Record<string, string | undefined> = {},
) {
  const url = new URL("/oauth/authorize", ORIGIN);
  const params: Record<string, string | undefined> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: "org:read",
    state: "test-state",
    resource: `${ORIGIN}/mcp`,
    code_challenge: PKCE_CODE_CHALLENGE,
    code_challenge_method: "S256",
    ...overrides,
  };
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  return new Request(url);
}

async function createAuthorizationCode(
  oauthApi: ReturnType<typeof createOAuthApi>,
  clientId = CODEX_CLIENT_ID,
) {
  const { codeVerifier, codeChallenge } = await createPkcePair();
  const request = await oauthApi.parseAuthRequest(
    createAuthorizationRequest(clientId, { code_challenge: codeChallenge }),
  );
  const { redirectTo } = await oauthApi.completeAuthorization({
    request,
    userId: "test-user-123",
    metadata: {},
    scope: ["org:read"],
    props: {
      id: "test-user-123",
      clientId,
      accessToken: "upstream-access-token",
      refreshToken: "upstream-refresh-token",
      accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
      scope: "org:read",
      grantedSkills: ["inspect"],
    } satisfies WorkerProps,
    revokeExistingGrants: false,
  });
  const redirect = new URL(redirectTo);
  expect(redirect.origin + redirect.pathname).toBe(REDIRECT_URI);
  expect(redirect.searchParams.get("state")).toBe("test-state");
  const code = redirect.searchParams.get("code");
  if (!code) throw new Error("Authorization did not issue a code");
  return { code, codeVerifier };
}

function requestToken(parameters: Record<string, string>) {
  return handler.fetch!(
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
  authorization: Awaited<ReturnType<typeof createAuthorizationCode>>,
  clientId = CODEX_CLIENT_ID,
) {
  return requestToken({
    grant_type: "authorization_code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code: authorization.code,
    code_verifier: authorization.codeVerifier,
  });
}

describe("pre-registered client metadata integration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([undefined, ""])(
    "rejects an incomplete authorization link before fetching metadata: redirect_uri=%j",
    async (redirectUri) => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const response = await handler.fetch!(
        createAuthorizationRequest(`${CODEX_CLIENT_ID}?other-client=1`, {
          redirect_uri: redirectUri,
        }),
        workerEnv,
        createExecutionContext(),
      );

      expect(response.status).toBe(400);
      expect(response.headers.get("Location")).toBeNull();
      expect(await response.text()).toContain(
        "authorization link is incomplete",
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it("preserves the missing client ID error for an incomplete authorization link", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await handler.fetch!(
      createAuthorizationRequest(CODEX_CLIENT_ID, {
        client_id: undefined,
        redirect_uri: undefined,
      }),
      workerEnv,
      createExecutionContext(),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
    expect(await response.text()).toBe("client_id is required");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("authorizes Codex and exchanges and refreshes tokens when upstream metadata is blocked", async () => {
    // The network mock returns 403: a fresh provider without pre-registration
    // cannot resolve this client, so an existing cache cannot hide the outage.
    await expect(
      createOAuthApi({}).parseAuthRequest(createAuthorizationRequest()),
    ).rejects.toThrow("Failed to fetch client metadata: HTTP 403");

    // Exercise production wiring as well as the provider's authorization helpers.
    const consent = await handler.fetch!(
      createAuthorizationRequest(),
      workerEnv,
      createExecutionContext(),
    );
    expect(consent.status).toBe(200);
    expect(await consent.text()).toContain("Codex");

    const authorization = await createAuthorizationCode(createOAuthApi());
    const exchange = await exchangeCode(authorization);
    expect(exchange.status).toBe(200);
    const tokens = (await exchange.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();

    const refresh = await requestToken({
      grant_type: "refresh_token",
      client_id: CODEX_CLIENT_ID,
      refresh_token: tokens.refresh_token,
    });
    expect(refresh.status).toBe(200);
    expect(await refresh.json()).toMatchObject({
      access_token: expect.any(String),
      refresh_token: expect.any(String),
    });
  });

  it("rejects an unregistered redirect URI for a pre-registered client", async () => {
    const response = await handler.fetch!(
      createAuthorizationRequest(CODEX_CLIENT_ID, {
        redirect_uri: "https://example.com/callback",
      }),
      workerEnv,
      createExecutionContext(),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
    expect(await response.text()).toBe("Invalid redirect URI");
  });

  it.each([
    { code_challenge: undefined, code_challenge_method: undefined },
    { code_challenge: "plain-challenge", code_challenge_method: "plain" },
  ])(
    "requires S256 PKCE for a pre-registered public client: %j",
    async (pkce) => {
      await expect(
        createOAuthApi().parseAuthRequest(
          createAuthorizationRequest(CODEX_CLIENT_ID, pkce),
        ),
      ).rejects.toMatchObject({ code: "invalid_request" });
    },
  );

  it("rejects a wrong PKCE verifier at the production token endpoint", async () => {
    const authorization = await createAuthorizationCode(createOAuthApi());
    const response = await exchangeCode({
      ...authorization,
      codeVerifier: "incorrect-pkce-code-verifier-1234567890abcdefghijk",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("still fetches unregistered CIMD URLs and rejects an upstream 403", async () => {
    const clientId = `${CODEX_CLIENT_ID}?other-client=1`;

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const authorizationResponse = await handler.fetch!(
      createAuthorizationRequest(clientId),
      workerEnv,
      createExecutionContext(),
    );
    expect(authorizationResponse.status).toBe(500);
    expect(authorizationResponse.headers.get("Location")).toBeNull();
    expect(await authorizationResponse.text()).toBe("Internal Server Error");
    expect(fetchSpy).toHaveBeenCalled();

    await expect(
      createOAuthApi().parseAuthRequest(createAuthorizationRequest(clientId)),
    ).rejects.toThrow("Failed to fetch client metadata: HTTP 403");
    const response = await requestToken({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: "unrecognized-refresh-token",
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "invalid_client" });
  });

  it("validates the client ID in pre-registered metadata", async () => {
    const oauthApi = createOAuthApi({
      [CODEX_CLIENT_ID]: {
        client_id: "https://example.com/client.json",
        client_name: "Invalid metadata fixture",
        redirect_uris: ["http://127.0.0.1/callback"],
        token_endpoint_auth_method: "none",
      },
    });
    await expect(oauthApi.lookupClient(CODEX_CLIENT_ID)).rejects.toThrow(
      "does not match metadata URL",
    );
  });

  it("preserves dynamic registration and authorization code exchange", async () => {
    const oauthApi = createOAuthApi();
    const client = await oauthApi.createClient({
      clientName: "DCR integration test client",
      redirectUris: [REDIRECT_URI],
      tokenEndpointAuthMethod: "none",
    });
    const authorization = await createAuthorizationCode(
      oauthApi,
      client.clientId,
    );
    const response = await exchangeCode(authorization, client.clientId);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      access_token: expect.any(String),
      refresh_token: expect.any(String),
    });
  });
});
