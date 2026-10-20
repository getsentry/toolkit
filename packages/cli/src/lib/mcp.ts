import { normalizeAuthToken } from "./auth-header.js";
import { getConfiguredSentryUrl } from "./constants.js";
import { refreshToken } from "./db/auth.js";
import { getEnv } from "./env.js";
import { HostScopeError, ValidationError } from "./errors.js";
import { getActiveTokenHost, isHostTrusted } from "./token-host.js";

type McpServerConfig = {
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
  config: McpServerConfig,
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
  config: McpServerConfig,
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

    return resolveCliMcpAccessToken(config);
  }
}

/** Start the local stdio server without introducing a second auth flow. */
export async function startMcpServer(args: string[]): Promise<void> {
  if (args[0] === "auth") {
    throw new ValidationError(
      "Use `sentry auth` to manage credentials for `sentry mcp`.",
    );
  }

  const { runMcpServer } = await import("@sentry/mcp-server");
  const {
    SENTRY_HOST: _sentryHost,
    SENTRY_URL: _sentryUrl,
    ...mcpEnv
  } = getEnv();

  // Remember the resolved target so the 401 handler can refresh against the
  // same host without re-parsing args.
  let resolvedConfig: McpServerConfig | undefined;

  await runMcpServer(prepareMcpServerArgs(args), {
    environment: mcpEnv,
    packageName: "sentry mcp",
    resolveAccessToken: (config) => {
      resolvedConfig = config;
      return resolveMcpAccessTokenWithLogin(config);
    },
    onUpstreamUnauthorized: async (setAccessToken) => {
      if (!resolvedConfig) {
        return;
      }
      // Force a refresh past the usual threshold: the upstream already rejected
      // the current token, so mirror `--follow`'s refresh-on-401 behavior.
      const token = await resolveCliMcpAccessToken(resolvedConfig, {
        force: true,
      });
      setAccessToken(token);
    },
    throwOnError: true,
  });
}
