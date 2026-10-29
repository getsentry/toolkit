import { normalizeAuthToken } from "./auth-header.js";
import { getConfiguredSentryUrl } from "./constants.js";
import { refreshToken } from "./db/auth.js";
import { getEnv } from "./env.js";
import { HostScopeError, ValidationError } from "./errors.js";
import { parseSntrysClaim } from "./token-claims.js";
import { getActiveTokenHost, isHostTrusted } from "./token-host.js";

type McpTarget = {
  sentryHost: string;
  sentryProtocol: "http" | "https";
};

function hasSentryTargetArg(args: readonly string[]): boolean {
  return args.some(
    (arg) =>
      arg === "--host" ||
      arg.startsWith("--host=") ||
      arg === "--url" ||
      arg.startsWith("--url="),
  );
}

/**
 * Translate the CLI's URL setting into MCP's host/protocol flags.
 *
 * The MCP parser intentionally rejects insecure SENTRY_URL values, while the
 * CLI uses them for self-hosted defaults. Passing explicit flags preserves the
 * selected CLI host without letting SENTRY_URL override --insecure-http.
 */
export function prepareMcpServerArgs(
  args: readonly string[],
  sentryUrl = getConfiguredSentryUrl(),
): string[] {
  if (!sentryUrl || hasSentryTargetArg(args)) {
    return [...args];
  }

  // oxlint-disable-next-line sentry-cli/no-silent-catch -- invalid URLs are passed through to the MCP parser for its normal validation error.
  try {
    const url = new URL(sentryUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return [...args, `--url=${sentryUrl}`];
    }
    return [
      ...args,
      `--host=${url.host}`,
      ...(url.protocol === "http:" ? ["--insecure-http"] : []),
    ];
  } catch {
    return [...args, `--url=${sentryUrl}`];
  }
}

/**
 * Resolve a credential for the local MCP server from the CLI's authenticated
 * session, preserving the CLI's host-scoping protections.
 *
 * Pass `force` to bypass the refresh threshold — used after an upstream 401 so
 * a long-running server picks up a fresh token without being restarted.
 */
export async function resolveCliMcpAccessToken(
  config: McpTarget,
  options: { force?: boolean } = {},
): Promise<string> {
  const targetUrl = `${config.sentryProtocol}://${config.sentryHost}`;
  const { token } = await refreshToken({ force: options.force });
  const tokenHost = getActiveTokenHost();

  if (!(tokenHost && isHostTrusted(targetUrl, tokenHost))) {
    throw new HostScopeError(
      "Cannot start MCP server with the active CLI credentials",
      targetUrl,
      tokenHost,
    );
  }

  // Env tokens and stored rows bypass the refresh path's normalization, so a
  // credential with pasted newlines or padding could reach the MCP server. Trim
  // and validate here before it becomes an Authorization header.
  return normalizeAuthToken(token);
}

/**
 * Resolve the MCP credential, falling back to the interactive login flow when
 * the CLI has no usable session and the terminal is interactive.
 *
 * Mirrors how the rest of the CLI recovers from `not_authenticated`/`expired`
 * errors: in a TTY it launches the OAuth device flow (browser), then retries.
 * In a non-interactive context (e.g. an IDE launching `sentry mcp` over pipes)
 * it rethrows the original {@link AuthError} so the client sees a clear
 * "run `sentry auth login`" message instead of a hung browser prompt.
 */
async function resolveMcpAccessTokenWithLogin(
  config: McpTarget,
): Promise<string> {
  try {
    return await resolveCliMcpAccessToken(config);
  } catch (error) {
    const { isatty } = await import("node:tty");
    const { shouldAutoAuth, assertAutoLoginHostTrusted } =
      await import("./auto-auth.js");
    const isInteractive = () => isatty(0);
    if (!shouldAutoAuth(error, isInteractive)) {
      throw error;
    }

    // Never start an OAuth device flow against an unconfirmed self-hosted host.
    assertAutoLoginHostTrusted();

    process.stderr.write(
      error.reason === "expired"
        ? "Authentication expired. Starting login flow...\n\n"
        : "Authentication required. Starting login flow...\n\n",
    );

    const { runInteractiveLogin } = await import("./interactive-login.js");
    const loginResult = await runInteractiveLogin();
    if (!loginResult) {
      throw error;
    }

    return await resolveCliMcpAccessToken(config);
  }
}

/**
 * Validate a static token from `--access-token` / `SENTRY_ACCESS_TOKEN`.
 *
 * The token is used as given and never refreshed. An org auth token
 * (`sntrys_`) records the server it was issued for; refuse to send it to any
 * other host, the same way the CLI scopes its own env tokens.
 */
export function resolveStaticMcpAccessToken(
  config: McpTarget & { accessToken: string },
): string {
  const token = normalizeAuthToken(config.accessToken);
  const claimedHost = parseSntrysClaim(token)?.url;
  const targetUrl = `${config.sentryProtocol}://${config.sentryHost}`;
  if (claimedHost && !isHostTrusted(targetUrl, claimedHost)) {
    throw new HostScopeError(
      "Cannot start MCP server with the provided access token",
      targetUrl,
      claimedHost,
    );
  }
  return token;
}

/** Start the local stdio server without introducing a second auth flow. */
export async function startMcpServer(args: string[]): Promise<void> {
  if (args[0] === "auth") {
    throw new ValidationError(
      "Use `sentry auth` to manage credentials for `sentry mcp`.",
    );
  }

  const env = getEnv();
  const { parseMcpInvocation, serveMcpStdio } = await import("./mcp/server.js");
  const invocation = parseMcpInvocation(prepareMcpServerArgs(args), env);
  if (invocation.kind === "output") {
    process.stdout.write(`${invocation.text}\n`);
    return;
  }

  const { config } = invocation;
  const { accessToken } = config;
  if (accessToken) {
    serveMcpStdio(config, {
      accessToken: resolveStaticMcpAccessToken({ ...config, accessToken }),
      env,
    });
    return;
  }

  serveMcpStdio(config, {
    accessToken: await resolveMcpAccessTokenWithLogin(config),
    // Force a refresh past the usual threshold: the upstream already rejected
    // the current token, so mirror `--follow`'s refresh-on-401 behavior.
    refreshAccessToken: () => resolveCliMcpAccessToken(config, { force: true }),
    env,
  });
}
