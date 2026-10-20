import { isSentryHost } from "@sentry/toolkit-core/sentry-host";
import type { PartiallyResolvedConfig, ResolvedConfig } from "../cli/types";
import { OAUTH_HOST } from "./constants";
import { authenticate } from "./device-code-flow";
import { readCachedToken, writeCachedToken } from "./token-cache";
import { toCachedToken } from "./types";

function withToken(
  partial: PartiallyResolvedConfig,
  accessToken: string,
): ResolvedConfig {
  return { ...partial, accessToken };
}

/**
 * Resolves the access token for the session.
 *
 * If an access token is already provided, returns immediately.
 * If the host is sentry.io, attempts to use a cached token or
 * initiates the device code flow (only when stderr is a TTY).
 * For non-sentry.io hosts, throws an error requiring --access-token.
 */
export async function resolveAccessToken(
  partial: PartiallyResolvedConfig,
): Promise<ResolvedConfig> {
  if (partial.accessToken) {
    return withToken(partial, partial.accessToken);
  }

  if (!isSentryHost(partial.sentryHost)) {
    throw new Error(
      "Error: No access token was provided. Device code authentication is only supported for sentry.io.\n" +
        "Pass one with `--access-token` or via `SENTRY_ACCESS_TOKEN`.",
    );
  }

  const { clientId, sentryHost } = partial;

  // Try cached token first (works in both interactive and non-interactive contexts)
  try {
    const cached = await readCachedToken(sentryHost, clientId);
    if (cached) {
      process.stderr.write(
        `Using cached authentication for ${cached.user_email}\n`,
      );
      return withToken(partial, cached.access_token);
    }
  } catch {
    // Cache read failure is non-fatal
  }

  // Device code flow requires a human to visit a URL and authorize.
  // In non-interactive contexts (CI, piped stdio), fail immediately
  // instead of hanging on the polling loop until expiry.
  if (!process.stderr.isTTY) {
    throw new Error(
      "Error: No access token was provided.\n" +
        "Run `sentry-mcp auth login` interactively first, or pass `--access-token` / `SENTRY_ACCESS_TOKEN`.",
    );
  }

  const tokenResponse = await authenticate({ clientId, host: OAUTH_HOST });

  try {
    await writeCachedToken(toCachedToken(tokenResponse, sentryHost, clientId));
  } catch {
    process.stderr.write("Warning: Could not cache authentication token.\n");
  }

  return withToken(partial, tokenResponse.access_token);
}
