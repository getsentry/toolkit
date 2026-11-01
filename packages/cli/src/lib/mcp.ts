import { normalizeAuthToken } from "./auth-header.js";
import { getConfiguredSentryUrl } from "./constants.js";
import { getAccountScope } from "./db/account-scope.js";
import { accountIdentity, getAccountRow } from "./db/accounts.js";
import {
  getEffectiveAccountRow,
  type RefreshTokenResult,
  refreshToken,
} from "./db/auth.js";
import { getEnv, withEnv } from "./env.js";
import { AuthError, HostScopeError } from "./errors.js";
import {
  deprecatedScopeFlags,
  type McpFlags,
  mergeMcpArgs,
  parseMcpEnv,
} from "./mcp/args.js";
import { finalizeMcpConfig } from "./mcp/config.js";
import { parseSntrysClaim } from "./token-claims.js";
import { getActiveTokenHost, isHostTrusted } from "./token-host.js";

type McpTarget = {
  sentryHost: string;
  sentryProtocol: "http" | "https";
};

function hasSentryTarget(flags: McpFlags): boolean {
  return flags.host !== undefined || flags.url !== undefined;
}

/**
 * Translate the CLI's URL setting into MCP's host/protocol flags.
 *
 * The MCP config intentionally rejects insecure `--url` values, while the
 * CLI uses them for self-hosted defaults. Setting `--host` (plus
 * `--insecure-http` for http) keeps the selected CLI host without letting
 * SENTRY_URL override --insecure-http.
 */
export function withConfiguredTarget(
  flags: McpFlags,
  sentryUrl = getConfiguredSentryUrl(),
): McpFlags {
  if (!sentryUrl || hasSentryTarget(flags)) {
    return flags;
  }

  // oxlint-disable-next-line sentry-cli/no-silent-catch -- invalid URLs are passed through as --url for the config's normal validation error.
  try {
    const url = new URL(sentryUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ...flags, url: sentryUrl };
    }
    return {
      ...flags,
      host: url.host,
      "insecure-http": flags["insecure-http"] || url.protocol === "http:",
    };
  } catch {
    return { ...flags, url: sentryUrl };
  }
}

/**
 * The CLI credential a server process started with. Every later refresh stays
 * on it, so another process running `sentry auth switch` or logging in to a
 * different account cannot change who the running server acts as.
 */
export type McpCredentialPin =
  | { kind: "stored"; accountId: string; userId: string | null }
  | { kind: "env" };

export type McpCliCredential = { token: string; pin: McpCredentialPin };

const ACCOUNT_CHANGED_MESSAGE =
  "The account this MCP server started with is no longer available. Restart the MCP server to use the current CLI login.";

const ENV_PIN: McpCredentialPin = { kind: "env" };

/**
 * Point this process's credential reads at the pinned credential, or fail
 * closed when it is gone. The host check alone cannot tell two accounts on
 * the same server apart.
 */
function applyCredentialPin(pin: McpCredentialPin): void {
  const scope = getAccountScope();
  if (pin.kind === "env") {
    scope.accountId = undefined;
    scope.envToken = true;
    return;
  }
  const row = getAccountRow(pin.accountId);
  // A login can replace an account's credentials in place, so also require
  // the same user when the account recorded one.
  if (!row?.token || (pin.userId && row.user_id !== pin.userId)) {
    throw new AuthError("expired", ACCOUNT_CHANGED_MESSAGE, {
      skipAutoAuth: true,
    });
  }
  scope.envToken = undefined;
  scope.accountId = pin.accountId;
}

/**
 * The stored account to start with: the effective one, chosen before the
 * refresh reads it so the startup token and the pin come from the same row.
 */
function startupPin(): McpCredentialPin | undefined {
  const row = getEffectiveAccountRow();
  return row?.token
    ? { kind: "stored", accountId: row.account_id, userId: row.user_id }
    : undefined;
}

/**
 * Whether `result` is the pinned credential. A stored pin must match the
 * account row's current credential: if the row vanished mid-refresh, the
 * CLI falls back to another account, and that token must not be used.
 */
function isPinnedCredential(
  result: RefreshTokenResult,
  pin: McpCredentialPin,
): boolean {
  if (pin.kind === "env") {
    return result.source !== "oauth";
  }
  if (result.source !== "oauth") {
    return false;
  }
  // SQLite yields null, not undefined, for a missing row.
  const row = getAccountRow(pin.accountId);
  return row ? accountIdentity(row) === result.identity : false;
}

/**
 * Resolve a credential for the local MCP server from the CLI's authenticated
 * session, preserving the CLI's host-scoping protections.
 *
 * Without `pin`, resolves the effective CLI account and pins it. With `pin`,
 * refreshes only that credential. Pass `force` to bypass the refresh
 * threshold — used after an upstream 401 so a long-running server picks up a
 * fresh token without being restarted.
 */
export async function resolveCliMcpCredential(
  config: McpTarget,
  options: { force?: boolean; pin?: McpCredentialPin } = {},
): Promise<McpCliCredential> {
  const targetUrl = `${config.sentryProtocol}://${config.sentryHost}`;
  const requested = options.pin ?? startupPin();
  if (requested) {
    applyCredentialPin(requested);
  }
  const result = await refreshToken({ force: options.force });
  const tokenHost = getActiveTokenHost();

  if (!(tokenHost && isHostTrusted(targetUrl, tokenHost))) {
    throw new HostScopeError(
      "Cannot start MCP server with the active CLI credentials",
      targetUrl,
      tokenHost,
    );
  }

  // At startup, an unusable stored credential falls back to the env token,
  // the same as other CLI commands. Later, that fallback is a different
  // identity, so it is refused like any other account change.
  const pin =
    !options.pin && result.source !== "oauth"
      ? ENV_PIN
      : (requested ?? ENV_PIN);
  if (!isPinnedCredential(result, pin)) {
    throw new AuthError("expired", ACCOUNT_CHANGED_MESSAGE, {
      skipAutoAuth: true,
    });
  }

  // Env tokens and stored rows bypass the refresh path's normalization, so a
  // credential with pasted newlines or padding could reach the MCP server. Trim
  // and validate here before it becomes an Authorization header.
  return { token: normalizeAuthToken(result.token), pin };
}

/**
 * Resolve the MCP credential, falling back to the interactive login flow when
 * the CLI has no usable session and the terminal is interactive.
 *
 * Mirrors how the rest of the CLI recovers from `not_authenticated`/`expired`
 * errors: in a TTY it launches the OAuth device flow (browser), then retries.
 * In a non-interactive context (e.g. an IDE launching `sentry mcp` over pipes)
 * it rethrows the original {@link AuthError} so the client sees which login
 * command to run instead of a hung browser prompt.
 */
async function resolveMcpCredentialWithLogin(
  config: McpTarget,
): Promise<McpCliCredential> {
  try {
    return await resolveCliMcpCredential(config);
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

    return await resolveCliMcpCredential(config);
  }
}

/** A token from the deprecated `--access-token` flag or `SENTRY_ACCESS_TOKEN`. */
type DeprecatedAccessToken = {
  token: string;
  source: "--access-token" | "SENTRY_ACCESS_TOKEN";
};

/** The deprecation hint is printed once per process. */
const deprecationHint = { shown: false };

/** @internal */
export function resetDeprecationHintForTesting(): void {
  deprecationHint.shown = false;
}

/**
 * Read the deprecated `--access-token` / `SENTRY_ACCESS_TOKEN`, flag first.
 * Blank values count as unset, the same as for `SENTRY_AUTH_TOKEN`.
 */
function readDeprecatedAccessToken(
  flags: McpFlags,
  env: NodeJS.ProcessEnv,
): DeprecatedAccessToken | undefined {
  const flag = flags["access-token"];
  if (flag?.trim()) {
    return { token: flag, source: "--access-token" };
  }
  const fromEnv = env.SENTRY_ACCESS_TOKEN;
  if (fromEnv?.trim()) {
    return { token: fromEnv, source: "SENTRY_ACCESS_TOKEN" };
  }
  return;
}

/** Tell the user, on stderr, which setting replaces the deprecated one. */
function warnDeprecatedAccessToken(source: DeprecatedAccessToken["source"]) {
  if (deprecationHint.shown) {
    return;
  }
  deprecationHint.shown = true;
  // stderr only: stdout carries the stdio MCP transport. Never the token.
  process.stderr.write(
    `Deprecation warning: ${source} is deprecated; set SENTRY_AUTH_TOKEN ` +
      "(and SENTRY_FORCE_ENV_TOKEN=1 to override a stored login) instead.\n",
  );
}

/**
 * The environment the deprecated token runs under: the same as
 * `SENTRY_AUTH_TOKEN=<token> SENTRY_FORCE_ENV_TOKEN=1`, so it takes the CLI's
 * env-token path and wins over any stored login. It also replaces an env
 * token that is already set, since the flag (or `SENTRY_ACCESS_TOKEN`) is the
 * more explicit choice for this server.
 *
 * The URL is pinned to the MCP target: `--host`/`--url` have always told the
 * MCP server where to send this token, and the env-token snapshot for this
 * copy then scopes the token to that server. An org auth token's own URL
 * claim still wins, so it cannot be sent anywhere else.
 */
function deprecatedTokenEnv(
  env: NodeJS.ProcessEnv,
  token: string,
  target: McpTarget,
): NodeJS.ProcessEnv {
  const aliased: NodeJS.ProcessEnv = { ...env };
  delete aliased.SENTRY_ACCESS_TOKEN;
  delete aliased.SENTRY_TOKEN;
  aliased.SENTRY_AUTH_TOKEN = token;
  aliased.SENTRY_FORCE_ENV_TOKEN = "1";
  delete aliased.SENTRY_HOST;
  aliased.SENTRY_URL = `${target.sentryProtocol}://${target.sentryHost}`;
  return aliased;
}

/**
 * Run the local stdio server without introducing a second auth flow.
 *
 * Resolves once the client disconnects.
 *
 * @param cwd - The command context's working directory, where a repo-local
 *   `.sentryclirc` is looked up. Unlike `process.cwd()`, it survives a deleted
 *   working directory (see `resolveCwd` in `context.ts`).
 */
export async function serveMcp(flags: McpFlags, cwd: string): Promise<void> {
  const env = getEnv();
  const config = finalizeMcpConfig(
    mergeMcpArgs(withConfiguredTarget(flags), parseMcpEnv(env)),
  );
  for (const { flag, replacement } of deprecatedScopeFlags(flags)) {
    // stderr only: stdout carries the stdio MCP transport.
    process.stderr.write(
      `Deprecation warning: --${flag} is deprecated; use --${replacement} instead.\n`,
    );
  }
  const deprecated = readDeprecatedAccessToken(flags, env);
  if (deprecated) {
    warnDeprecatedAccessToken(deprecated.source);
  }
  // Validate before anything else: a malformed token fails here, and the
  // error never repeats it.
  const deprecatedToken = deprecated
    ? normalizeAuthToken(deprecated.token)
    : undefined;

  // A repo-local `.sentryclirc` can set the target URL, but it is not a trust
  // source: without this gate, a token with no host claim would be sent to
  // whatever server the file names. Apply the same rc-URL check as every
  // other CLI command, unless an explicit `--host`/`--url` flag overrides the
  // target, or the deprecated token is an org token, whose host claim the
  // credential check below matches against the target. Checked against the
  // invocation's own credentials, before the deprecated token replaces them.
  if (
    !(
      hasSentryTarget(flags) ||
      (deprecatedToken && parseSntrysClaim(deprecatedToken))
    )
  ) {
    const { assertRcUrlTrusted } = await import("./sentryclirc.js");
    await assertRcUrlTrusted(cwd);
  }

  const credentialEnv = deprecatedToken
    ? deprecatedTokenEnv(env, deprecatedToken, config)
    : env;

  // Loaded only now: mcp-core's server, the agent providers, and the MCP
  // telemetry are not needed for --help or setup errors.
  const { serveMcpStdio } = await import("./mcp/server.js");
  const { token, pin } = await withEnv(credentialEnv, () =>
    resolveMcpCredentialWithLogin(config),
  );
  await serveMcpStdio(config, {
    accessToken: token,
    // Force a refresh past the usual threshold: the upstream already rejected
    // the current token, so mirror `--follow`'s refresh-on-401 behavior. The
    // pin keeps the refresh on the startup account. Requests can arrive
    // outside this call's async context, so the credential env is explicit.
    refreshAccessToken: () =>
      withEnv(credentialEnv, async () => {
        const refreshed = await resolveCliMcpCredential(config, {
          force: true,
          pin,
        });
        return refreshed.token;
      }),
    env,
  });
}
