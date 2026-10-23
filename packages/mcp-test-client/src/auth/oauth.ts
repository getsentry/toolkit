import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { URL } from "node:url";
import chalk from "chalk";
import open from "open";
import { DEFAULT_OAUTH_SCOPES } from "../constants.js";
import { logError, logInfo, logSuccess, logToolResult } from "../logger.js";
import {
  resolveAuthorizationServerUrl,
  resolveProtectedResourceUrl,
} from "../mcp-url.js";
import { ConfigManager } from "./config.js";
import {
  defaultOAuthRedirectUri,
  isLoopbackHost,
  type OAuthRedirect,
  resolveOAuthRedirect,
} from "./redirect.js";

export interface OAuthConfig {
  mcpHost: string;
  scopes?: string[];
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export interface ClientRegistrationResponse {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
  client_uri?: string;
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
  registration_client_uri?: string;
  client_id_issued_at?: number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function renderOAuthCallbackPage(
  heading: string,
  messages: readonly string[],
  title = heading,
): string {
  const paragraphs = messages
    .map((message) => `        <p>${escapeHtml(message)}</p>`)
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    <style>
      body {
        box-sizing: border-box;
        min-height: 100vh;
        margin: 0;
        padding: 1.5rem;
        display: grid;
        place-items: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        background: #160f24;
        color: #d4d1ec;
      }
      main {
        width: min(100%, 600px);
        text-align: center;
      }
      h1 {
        margin: 0 0 1rem;
        color: #ffffff;
        font-size: 2rem;
        line-height: 1.2;
      }
      p {
        margin: 0.5rem 0;
        line-height: 1.6;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(heading)}</h1>
${paragraphs}
    </main>
  </body>
</html>`;
}

export class OAuthClient {
  private config: OAuthConfig;
  private server: Server | null = null;
  private configManager: ConfigManager;
  private redirect: OAuthRedirect;

  constructor(config: OAuthConfig) {
    this.config = {
      ...config,
      scopes: config.scopes || DEFAULT_OAUTH_SCOPES,
    };
    this.configManager = new ConfigManager();
    this.redirect = resolveOAuthRedirect();
  }

  private getProtectedResourceUrl(): URL {
    return resolveProtectedResourceUrl(this.config.mcpHost);
  }

  private getAuthorizationServerUrl(pathname: string): string {
    return new URL(pathname, resolveAuthorizationServerUrl(this.config.mcpHost))
      .href;
  }

  private getConfigKey(): string {
    return this.getProtectedResourceUrl().href;
  }

  /**
   * Generate PKCE code verifier and challenge
   */
  private generatePKCE(): { verifier: string; challenge: string } {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    return { verifier, challenge };
  }

  /**
   * Generate random state for CSRF protection
   */
  private generateState(): string {
    return randomBytes(16).toString("base64url");
  }

  /**
   * Register the client with the OAuth server using Dynamic Client Registration
   */
  private async registerClient(): Promise<string> {
    const registrationUrl = this.getAuthorizationServerUrl("/oauth/register");

    const registrationData = {
      client_name: "Sentry MCP CLI",
      client_uri: "https://github.com/getsentry/sentry-mcp",
      redirect_uris: [this.redirect.redirectUri],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none", // PKCE, no client secret
      scope: this.config.scopes!.join(" "),
    };

    const response = await fetch(registrationUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "Sentry MCP CLI",
      },
      body: JSON.stringify(registrationData),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Client registration failed: ${response.status} - ${error}`,
      );
    }

    const registrationResponse =
      (await response.json()) as ClientRegistrationResponse;
    return registrationResponse.client_id;
  }

  /**
   * Start local server for OAuth callback
   */
  private async startCallbackServer(): Promise<{
    waitForCallback: () => Promise<{ code: string; state: string }>;
  }> {
    return await new Promise((resolve, reject) => {
      let resolveCallback:
        | ((value: { code: string; state: string }) => void)
        | null = null;
      let rejectCallback: ((error: Error) => void) | null = null;

      this.server = createServer((req, res) => {
        if (!req.url) {
          res.writeHead(400);
          res.end("Bad Request");
          return;
        }

        const url = new URL(req.url, `http://localhost:${this.redirect.port}`);

        if (url.pathname === "/callback") {
          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          const error = url.searchParams.get("error");

          if (error) {
            const errorDescription =
              url.searchParams.get("error_description") || "Unknown error";
            res.writeHead(400, {
              "Content-Type": "text/html; charset=utf-8",
            });
            res.end(
              renderOAuthCallbackPage("Authentication Failed", [
                `Error: ${error}`,
                errorDescription,
                "You can close this window.",
              ]),
            );

            if (rejectCallback) {
              rejectCallback(
                new Error(`OAuth error: ${error} - ${errorDescription}`),
              );
            }
            return;
          }

          if (!code || !state) {
            res.writeHead(400, {
              "Content-Type": "text/html; charset=utf-8",
            });
            res.end(
              renderOAuthCallbackPage("Authentication Failed", [
                "Missing code or state parameter",
                "You can close this window.",
              ]),
            );

            if (rejectCallback) {
              rejectCallback(new Error("Missing code or state parameter"));
            }
            return;
          }

          // Acknowledge the callback but don't show success yet
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
          });
          res.end(
            renderOAuthCallbackPage(
              "Processing Authentication...",
              [
                "Please wait while we complete the authentication process.",
                "You can close this window and return to your terminal.",
              ],
              "Authentication in Progress",
            ),
          );

          if (resolveCallback) {
            resolveCallback({ code, state });
          }
        } else {
          res.writeHead(404);
          res.end("Not Found");
        }
      });

      if (!isLoopbackHost(this.redirect.host)) {
        logInfo(
          chalk.yellow(
            `Serving the OAuth callback on ${this.redirect.host}:${this.redirect.port}, reachable from the network`,
          ),
        );
      }

      this.server.listen(this.redirect.port, this.redirect.host, () => {
        const waitForCallback = () =>
          new Promise<{ code: string; state: string }>((res, rej) => {
            resolveCallback = res;
            rejectCallback = rej;
          });

        resolve({ waitForCallback });
      });

      this.server.on("error", reject);
    });
  }

  /**
   * Exchange authorization code for access token
   */
  private async exchangeCodeForToken(params: {
    code: string;
    codeVerifier: string;
    clientId: string;
  }): Promise<TokenResponse> {
    const tokenUrl = this.getAuthorizationServerUrl("/oauth/token");

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: params.clientId,
      code: params.code,
      redirect_uri: this.redirect.redirectUri,
      code_verifier: params.codeVerifier,
    });

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": "Sentry MCP CLI",
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${response.status} - ${error}`);
    }

    return await (response.json() as Promise<TokenResponse>);
  }

  /**
   * Get or register OAuth client ID for the MCP host
   */
  private async getOrRegisterClientId(): Promise<string> {
    const configKey = this.getConfigKey();

    // Check if we already have a registered client for this host. The OAuth
    // server validates the request against the redirect URIs bound to the
    // client, so a changed redirect URI needs a new registration. Clients
    // registered before the URI was recorded used the default.
    const existing = await this.configManager.getOAuthClient(configKey);
    const registeredRedirectUri =
      existing?.redirectUri ?? defaultOAuthRedirectUri();

    let clientId = existing?.clientId ?? null;
    if (clientId && registeredRedirectUri === this.redirect.redirectUri) {
      return clientId;
    }

    // Register a new client
    logInfo("Registering new OAuth client");
    try {
      clientId = await this.registerClient();

      // Store the client ID for future use
      await this.configManager.setOAuthClientId(
        configKey,
        clientId,
        this.redirect.redirectUri,
      );

      logSuccess("Client registered and saved");
      logToolResult(clientId);
      return clientId;
    } catch (error) {
      throw new Error(
        `Client registration failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get cached access token or perform OAuth flow
   */
  async getAccessToken(): Promise<string> {
    const configKey = this.getConfigKey();

    // Check for cached token first
    const cachedToken = await this.configManager.getAccessToken(configKey);
    if (cachedToken) {
      logInfo("Authenticated with Sentry", "using stored token");
      return cachedToken;
    }

    // No cached token, perform OAuth flow
    return await this.authenticate();
  }

  /**
   * Perform the OAuth flow
   */
  async authenticate(): Promise<string> {
    const configKey = this.getConfigKey();

    // Get or register client ID
    const clientId = await this.getOrRegisterClientId();

    // Start callback server
    const { waitForCallback } = await this.startCallbackServer();

    // Generate PKCE and state
    const { verifier, challenge } = this.generatePKCE();
    const state = this.generateState();

    // Build authorization URL
    const authUrl = new URL(this.getAuthorizationServerUrl("/oauth/authorize"));
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", this.redirect.redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", this.config.scopes!.join(" "));
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    // RFC 8707: send the exact `/mcp/...` protected resource the client wants
    // to use so authorization is scoped to that resource from the start.
    authUrl.searchParams.set("resource", this.getProtectedResourceUrl().href);

    logInfo("Authenticating with Sentry - opening browser");
    console.log(
      chalk.gray("If your browser doesn't open automatically, visit:"),
    );
    console.log(chalk.white(authUrl.toString()));

    // Open browser
    try {
      await open(authUrl.toString());
    } catch (error) {
      // Browser opening failed, user will need to copy/paste
    }

    try {
      // Wait for callback
      const { code, state: receivedState } = await waitForCallback();

      // Verify state
      if (receivedState !== state) {
        throw new Error("State mismatch - possible CSRF attack");
      }

      // Exchange code for token

      try {
        const tokenResponse = await this.exchangeCodeForToken({
          code,
          codeVerifier: verifier,
          clientId,
        });

        // Cache the access token
        await this.configManager.setAccessToken(
          configKey,
          tokenResponse.access_token,
          tokenResponse.expires_in,
        );

        logSuccess("Authentication successful");

        return tokenResponse.access_token;
      } catch (error) {
        logError(
          "Authentication failed",
          error instanceof Error ? error : String(error),
        );
        throw error;
      }
    } finally {
      // Clean up server
      if (this.server) {
        this.server.close();
        this.server = null;
      }
    }
  }
}
