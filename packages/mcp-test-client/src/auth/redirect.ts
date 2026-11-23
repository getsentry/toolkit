import {
  DEFAULT_OAUTH_CALLBACK_HOST,
  DEFAULT_OAUTH_REDIRECT_PORT,
} from "../constants.js";

export interface OAuthRedirect {
  /** Port the local callback server listens on. */
  port: number;
  /** Address the local callback server binds to. */
  host: string;
  /** Redirect URI sent to the OAuth server. */
  redirectUri: string;
}

/**
 * Resolve where the OAuth callback is served and how the OAuth server should
 * reach it.
 *
 * Defaults keep the flow on loopback. Running inside a VM or container the
 * browser usually lives on the host, so `MCP_OAUTH_HOST=0.0.0.0` makes the
 * callback server reachable and `MCP_OAUTH_REDIRECT_URI` points the OAuth
 * server at the forwarded address.
 *
 * The redirect URI must be byte-identical across client registration, the
 * authorization request, and the token exchange, so it is resolved once and
 * reused.
 *
 * - `MCP_OAUTH_PORT` -> callback port (default 8765)
 * - `MCP_OAUTH_HOST` -> bind address (default 127.0.0.1)
 * - `MCP_OAUTH_REDIRECT_URI` -> full redirect URI (default derived from port)
 */
export function resolveOAuthRedirect(
  env: NodeJS.ProcessEnv = process.env,
): OAuthRedirect {
  const port = resolvePort(env["MCP_OAUTH_PORT"]);
  const host = env["MCP_OAUTH_HOST"]?.trim() || DEFAULT_OAUTH_CALLBACK_HOST;
  const redirectUri =
    resolveRedirectUri(env["MCP_OAUTH_REDIRECT_URI"]) ??
    `http://localhost:${port}/callback`;

  return { port, host, redirectUri };
}

/**
 * The redirect URI used before it became configurable. Clients registered then
 * have no recorded redirect URI, so this is what they were registered with.
 */
export function defaultOAuthRedirectUri(): string {
  return `http://localhost:${DEFAULT_OAUTH_REDIRECT_PORT}/callback`;
}

/** Whether the callback server is reachable from outside this machine. */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function resolvePort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_OAUTH_REDIRECT_PORT;
  }

  // The browser needs the port before the server binds, so an ephemeral port
  // (0) cannot work here.
  const trimmed = value.trim();
  const port = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `MCP_OAUTH_PORT must be an integer between 1 and 65535, got: ${value}`,
    );
  }

  return port;
}

function resolveRedirectUri(value: string | undefined): string | null {
  const redirectUri = value?.trim();
  if (!redirectUri) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new Error(
      `MCP_OAUTH_REDIRECT_URI must be an absolute URL, got: ${value}`,
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `MCP_OAUTH_REDIRECT_URI must be http or https, got: ${parsed.protocol}`,
    );
  }

  if (parsed.username || parsed.password) {
    throw new Error("MCP_OAUTH_REDIRECT_URI must not contain userinfo");
  }

  return redirectUri;
}
