import open from "open";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthClient, renderOAuthCallbackPage } from "./oauth.js";

vi.mock("open", () => ({
  default: vi.fn().mockResolvedValue(undefined),
}));

/**
 * The private members these tests stub. Indexed access ties each type to
 * OAuthClient, so a rename or signature change fails to compile here.
 */
interface OAuthClientInternals {
  configManager: OAuthClient["configManager"];
  exchangeCodeForToken: OAuthClient["exchangeCodeForToken"];
  generatePKCE: OAuthClient["generatePKCE"];
  generateState: OAuthClient["generateState"];
  getOrRegisterClientId: OAuthClient["getOrRegisterClientId"];
  redirect: OAuthClient["redirect"];
  registerClient: OAuthClient["registerClient"];
  startCallbackServer: OAuthClient["startCallbackServer"];
}

function internals(client: OAuthClient): OAuthClientInternals {
  // TypeScript has no typed view of private members; this one cast is the
  // only place the tests reach past OAuthClient's public API.
  return client as unknown as OAuthClientInternals;
}

/** The URL of the only browser window the flow opened. */
function openedUrl(): URL {
  const calls = vi.mocked(open).mock.calls;
  expect(calls).toHaveLength(1);
  const [target] = calls[0] ?? [];
  if (target === undefined) {
    throw new Error("open() was not called with a URL");
  }
  return new URL(target);
}

describe("OAuthClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env["MCP_OAUTH_REDIRECT_URI"];
  });

  it("includes the protected resource in the authorization request", async () => {
    const client = new OAuthClient({
      mcpHost: "https://mcp.sentry.dev/mcp/sentry/javascript",
    });

    vi.spyOn(internals(client), "getOrRegisterClientId").mockResolvedValue(
      "client-123",
    );
    vi.spyOn(internals(client), "startCallbackServer").mockResolvedValue({
      waitForCallback: async () => ({
        code: "auth-code",
        state: "oauth-state",
      }),
    });
    vi.spyOn(internals(client), "generateState").mockReturnValue("oauth-state");
    vi.spyOn(internals(client), "generatePKCE").mockReturnValue({
      verifier: "verifier",
      challenge: "challenge",
    });
    vi.spyOn(internals(client), "exchangeCodeForToken").mockResolvedValue({
      access_token: "access-token",
      token_type: "Bearer",
    });
    vi.spyOn(
      internals(client).configManager,
      "setAccessToken",
    ).mockResolvedValue(undefined);

    await client.authenticate();

    const authUrl = openedUrl();
    expect(authUrl.origin).toBe("https://mcp.sentry.dev");
    expect(authUrl.pathname).toBe("/oauth/authorize");
    expect(authUrl.searchParams.get("resource")).toBe(
      "https://mcp.sentry.dev/mcp/sentry/javascript",
    );
  });

  it("sends one redirect URI to registration, authorization, and token exchange", async () => {
    const redirectUri = "http://192.168.1.20:8765/callback";
    process.env["MCP_OAUTH_REDIRECT_URI"] = redirectUri;

    const client = new OAuthClient({ mcpHost: "https://mcp.sentry.dev" });

    const registerClient = vi
      .spyOn(internals(client), "registerClient")
      .mockResolvedValue("client-123");
    const exchangeCodeForToken = vi
      .spyOn(internals(client), "exchangeCodeForToken")
      .mockResolvedValue({
        access_token: "access-token",
        token_type: "Bearer",
      });
    vi.spyOn(internals(client), "startCallbackServer").mockResolvedValue({
      waitForCallback: async () => ({
        code: "auth-code",
        state: "oauth-state",
      }),
    });
    vi.spyOn(internals(client), "generateState").mockReturnValue("oauth-state");
    vi.spyOn(internals(client), "generatePKCE").mockReturnValue({
      verifier: "verifier",
      challenge: "challenge",
    });
    vi.spyOn(
      internals(client).configManager,
      "getOAuthClient",
    ).mockResolvedValue(null);
    vi.spyOn(
      internals(client).configManager,
      "setOAuthClientId",
    ).mockResolvedValue(undefined);
    vi.spyOn(
      internals(client).configManager,
      "setAccessToken",
    ).mockResolvedValue(undefined);

    await client.authenticate();

    // Registration is what binds the URI server-side; the other two are
    // validated against it and must match byte for byte.
    expect(registerClient).toHaveBeenCalledTimes(1);
    expect(internals(client).redirect.redirectUri).toBe(redirectUri);
    expect(openedUrl().searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(exchangeCodeForToken).toHaveBeenCalledTimes(1);
  });

  it("re-registers when the redirect URI no longer matches the stored client", async () => {
    process.env["MCP_OAUTH_REDIRECT_URI"] = "http://192.168.1.20:8765/callback";

    const client = new OAuthClient({ mcpHost: "https://mcp.sentry.dev" });

    const registerClient = vi
      .spyOn(internals(client), "registerClient")
      .mockResolvedValue("client-new");
    vi.spyOn(
      internals(client).configManager,
      "getOAuthClient",
    ).mockResolvedValue({
      clientId: "client-old",
      mcpHost: "https://mcp.sentry.dev/mcp",
      redirectUri: "http://localhost:8765/callback",
      registeredAt: new Date().toISOString(),
    });
    const setOAuthClientId = vi
      .spyOn(internals(client).configManager, "setOAuthClientId")
      .mockResolvedValue(undefined);

    const clientId = await internals(client).getOrRegisterClientId();

    expect(registerClient).toHaveBeenCalledTimes(1);
    expect(clientId).toBe("client-new");
    expect(setOAuthClientId).toHaveBeenCalledWith(
      "https://mcp.sentry.dev/mcp",
      "client-new",
      "http://192.168.1.20:8765/callback",
    );
  });

  it("reuses a client registered before the redirect URI was recorded", async () => {
    const client = new OAuthClient({ mcpHost: "https://mcp.sentry.dev" });

    const registerClient = vi.spyOn(internals(client), "registerClient");
    vi.spyOn(
      internals(client).configManager,
      "getOAuthClient",
    ).mockResolvedValue({
      clientId: "client-legacy",
      mcpHost: "https://mcp.sentry.dev/mcp",
      registeredAt: new Date().toISOString(),
    });

    const clientId = await internals(client).getOrRegisterClientId();

    expect(clientId).toBe("client-legacy");
    expect(registerClient).not.toHaveBeenCalled();
  });

  it("renders escaped OAuth callback content in the MCP style", () => {
    const html = renderOAuthCallbackPage(
      "Processing Authentication...",
      ['Error: <access_denied> & "retry"'],
      "Authentication in Progress",
    );

    expect(html).toContain("<title>Authentication in Progress</title>");
    expect(html).toContain("background: #160f24");
    expect(html).toContain("place-items: center");
    expect(html).toContain("text-align: center");
    expect(html).toContain("font-family: -apple-system");
    expect(html).toContain("<h1>Processing Authentication...</h1>");
    expect(html).toContain(
      "Error: &lt;access_denied&gt; &amp; &quot;retry&quot;",
    );
  });
});
