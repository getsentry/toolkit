import { isSentryHost } from "@sentry/toolkit-core/sentry-host";
import { parseEnv } from "../parse";
import { resolveHost } from "../resolve";
import { DEFAULT_SENTRY_CLIENT_ID, OAUTH_HOST } from "../../auth/constants";
import { authenticate } from "../../auth/device-code-flow";
import {
  readCachedToken,
  writeCachedToken,
  clearCachedToken,
} from "../../auth/token-cache";
import { toCachedToken } from "../../auth/types";

type AuthContext = {
  sentryHost: string;
  clientId: string;
};

export function parseFlag(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith(`--${name}=`)) {
      return arg.slice(`--${name}=`.length);
    }
    if (arg === `--${name}` && i + 1 < argv.length) {
      return argv[i + 1];
    }
  }
  return undefined;
}

function resolveAuthContext(argv: string[]): AuthContext {
  const env = parseEnv(process.env);

  // Match the precedence of the server's merge() + finalize() path:
  // merged url (CLI --url ?? env SENTRY_URL) beats merged host (CLI --host ?? env SENTRY_HOST)
  const url = parseFlag(argv, "url") ?? env.url;
  const host = parseFlag(argv, "host") ?? env.host;
  const sentryHost = resolveHost(url, host);

  return { sentryHost, clientId: env.clientId || DEFAULT_SENTRY_CLIENT_ID };
}

async function login(argv: string[]): Promise<void> {
  const { sentryHost, clientId } = resolveAuthContext(argv);

  if (!isSentryHost(sentryHost)) {
    console.error(
      "Error: Device code authentication is only supported for sentry.io.",
    );
    process.exit(1);
  }

  try {
    const tokenResponse = await authenticate({ clientId, host: OAUTH_HOST });
    await writeCachedToken(toCachedToken(tokenResponse, sentryHost, clientId));
  } catch (err) {
    console.error(
      err instanceof Error ? err.message : `Authentication failed: ${err}`,
    );
    process.exit(1);
  }
}

async function logout(argv: string[]): Promise<void> {
  const { sentryHost, clientId } = resolveAuthContext(argv);

  const cached = await readCachedToken(sentryHost, clientId);
  if (cached) {
    await clearCachedToken(sentryHost, clientId);
    console.log(`Logged out (removed cached token for ${cached.user_email}).`);
  } else {
    console.log("No cached authentication found.");
  }
}

async function status(argv: string[]): Promise<void> {
  const { sentryHost, clientId } = resolveAuthContext(argv);

  const cached = await readCachedToken(sentryHost, clientId);
  if (cached) {
    const expiresAt = new Date(cached.expires_at);
    console.log(`Authenticated as ${cached.user_email}`);
    console.log(`  Host:    ${cached.sentry_host}`);
    console.log(`  Scopes:  ${cached.scope}`);
    console.log(`  Expires: ${expiresAt.toLocaleString()}`);
  } else {
    console.log("Not authenticated. Run `sentry-mcp auth login` to sign in.");
  }
}

export async function authCommand(argv: string[]): Promise<void> {
  const sub = argv[0] ?? "login";
  const rest = argv.slice(1);

  switch (sub) {
    case "login":
      return login(rest);
    case "logout":
      return logout(rest);
    case "status":
      return status(rest);
    default:
      console.error(`Unknown auth command: ${sub}`);
      console.error("Available: auth login, auth logout, auth status");
      process.exit(1);
  }
}
