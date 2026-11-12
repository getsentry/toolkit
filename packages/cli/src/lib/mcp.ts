import { normalizeAuthToken } from "./auth-header.js";
import { getConfiguredSentryUrl } from "./constants.js";
import { getAccountScope } from "./db/account-scope.js";
import type { CredentialRouter } from "@sentry/mcp-core/types";
import {
  type AccountRow,
  accountIdentity,
  getAccountRow,
} from "./db/accounts.js";
import {
  getCredentialContext,
  getEffectiveAccountRow,
  type RefreshTokenResult,
  refreshToken,
  withStoredAccount,
} from "./db/auth.js";
import {
  getBootConfiguredSentryUrl,
  inheritEnvTokenHost,
  scopeEnvTokenToBootHost,
} from "./env-token-host.js";
import { getEnv, withEnv } from "./env.js";
import { AuthError } from "./errors.js";
import {
  deprecatedFlags,
  type McpFlags,
  type McpScope,
  mergeMcpArgs,
  parseMcpEnv,
} from "./mcp/args.js";
import {
  createMcpAccountRouter,
  type StoredAccountPin,
} from "./mcp/account-router.js";
import { finalizeMcpConfig } from "./mcp/config.js";
import { assertRcUrlTrusted, getRcInjectedTokenSource } from "./sentryclirc.js";
import { assertCredentialScope } from "./token-host.js";

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
 * Whether `row` still belongs to the pinned user. A login can replace an
 * account's credentials in place, so the account ID alone is not enough when
 * the account recorded a user.
 */
function isPinnedUser(
  row: AccountRow,
  pin: Extract<McpCredentialPin, { kind: "stored" }>,
): boolean {
  return !pin.userId || row.user_id === pin.userId;
}

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
  if (!(row?.token && isPinnedUser(row, pin))) {
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
 * CLI falls back to another account, and that token must not be used. The
 * row must also still belong to the pinned user, in case a login replaced it
 * between the pin and the credential read.
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
  return row
    ? isPinnedUser(row, pin) && accountIdentity(row) === result.identity
    : false;
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
  // The same host guard the CLI applies to each of its own requests: the
  // server sends this token to the target.
  assertCredentialScope(
    targetUrl,
    getCredentialContext(),
    "Cannot start MCP server with the active CLI credentials",
  );

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
    `Deprecation warning: ${source} is deprecated; set SENTRY_AUTH_TOKEN instead.\n`,
  );
}

/**
 * The environment with the deprecated `--host`/`--url`/`--insecure-http`
 * target applied as `SENTRY_URL`, the setting they stand in for. The
 * credential check, an env token's host scope, and the fallback login all read
 * the instance from there, so they agree with the server's target.
 */
function withTargetEnv(
  env: NodeJS.ProcessEnv,
  flags: McpFlags,
  target: McpTarget,
): NodeJS.ProcessEnv {
  if (!(hasSentryTarget(flags) || flags["insecure-http"])) {
    return env;
  }
  const targeted: NodeJS.ProcessEnv = {
    ...env,
    SENTRY_URL: `${target.sentryProtocol}://${target.sentryHost}`,
  };
  delete targeted.SENTRY_HOST;
  return targeted;
}

/**
 * Whether the env token may be scoped to the server's target instead of its
 * startup host: for an explicit `--host`/`--url`, or for `--insecure-http` on
 * the host the startup `SENTRY_HOST`/`SENTRY_URL` named, which only changes the
 * protocol. `--insecure-http` on any other configured host (a `.sentryclirc`
 * URL or the persisted default) must not.
 */
function mayRescopeEnvToken(flags: McpFlags, target: McpTarget): boolean {
  if (hasSentryTarget(flags)) {
    return true;
  }
  const bootUrl = getBootConfiguredSentryUrl();
  return (
    !!flags["insecure-http"] &&
    bootUrl !== undefined &&
    new URL(bootUrl).host === target.sentryHost
  );
}

/**
 * The environment the client's token runs under: `SENTRY_AUTH_TOKEN` (or
 * `SENTRY_TOKEN`) forced over any stored login, as if `SENTRY_FORCE_ENV_TOKEN=1`
 * were set. An MCP client passes the token in its server config to pick the
 * account, so a stored CLI login must not silently replace it. Other commands
 * keep preferring the stored login.
 *
 * The deprecated `--access-token` / `SENTRY_ACCESS_TOKEN` is an alias for it:
 * it replaces any env token, as the more explicit choice for this server, and
 * then takes the same path, with the same host scoping.
 *
 * A token the `.sentryclirc` shim copied in is not forced: it comes from the
 * repository, not the client, so it must not replace the user's login.
 *
 * With `keepStartupHost`, the token is scoped as if set at startup (see
 * `scopeEnvTokenToBootHost`): by now `SENTRY_URL` can come from a
 * `.sentryclirc` or the persisted default, which must not scope it. See
 * {@link mayRescopeEnvToken} for when the server's target may scope it.
 */
function clientTokenEnv(
  env: NodeJS.ProcessEnv,
  deprecatedToken: string | undefined,
  keepStartupHost: boolean,
): NodeJS.ProcessEnv {
  if (
    !deprecatedToken &&
    (!(env.SENTRY_AUTH_TOKEN?.trim() || env.SENTRY_TOKEN?.trim()) ||
      getRcInjectedTokenSource())
  ) {
    return env;
  }
  const forced: NodeJS.ProcessEnv = { ...env, SENTRY_FORCE_ENV_TOKEN: "1" };
  if (deprecatedToken) {
    delete forced.SENTRY_ACCESS_TOKEN;
    delete forced.SENTRY_TOKEN;
    forced.SENTRY_AUTH_TOKEN = deprecatedToken;
  }
  if (keepStartupHost) {
    scopeEnvTokenToBootHost(forced);
  }
  return forced;
}

/**
 * Run the local stdio server without introducing a second auth flow.
 *
 * Resolves once the client disconnects.
 *
 * @param cwd - The command context's working directory, where a repo-local
 *   `.sentryclirc` is looked up. Unlike `process.cwd()`, it survives a deleted
 *   working directory (see `resolveCwd` in `context.ts`).
 * @param scope - The organization and project of the `[<org>/[<project>]]`
 *   positional, if one was passed
 */
export async function serveMcp(
  flags: McpFlags,
  cwd: string,
  scope?: McpScope,
): Promise<void> {
  const env = getEnv();
  const config = finalizeMcpConfig(
    mergeMcpArgs(withConfiguredTarget(flags), parseMcpEnv(env), scope),
  );
  for (const { flag, replacement } of deprecatedFlags(flags)) {
    // stderr only: stdout carries the stdio MCP transport.
    process.stderr.write(
      `Deprecation warning: --${flag} is deprecated; use ${replacement} instead.\n`,
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
  // target. Checked against the credential this server will use, scoped to
  // its startup host, so the rc URL cannot scope it.
  if (!hasSentryTarget(flags)) {
    await withEnv(clientTokenEnv(env, deprecatedToken, true), () =>
      assertRcUrlTrusted(cwd),
    );
  }

  const credentialEnv = clientTokenEnv(
    withTargetEnv(env, flags, config),
    deprecatedToken,
    !mayRescopeEnvToken(flags, config),
  );

  // Loaded only now: mcp-core's server, the agent providers, and the MCP
  // telemetry are not needed for --help or setup errors.
  const { serveMcpStdio } = await import("./mcp/server.js");
  const { token, pin } = await withEnv(credentialEnv, () =>
    resolveMcpCredentialWithLogin(config),
  );
  // A static token (`--access-token`, `SENTRY_AUTH_TOKEN`) is the only
  // credential; a stored login can route calls to the other stored logins.
  const router =
    pin.kind === "stored" && !deprecatedToken
      ? createRouter(config, credentialEnv, pin)
      : undefined;

  if (router && !config.organizationSlug) {
    await serveMcpStdio(config, {
      accessToken: token,
      credentialRouter: router,
      env,
    });
    return;
  }

  // `--organization-slug` picks the account once: the one that knows the
  // organization, else the startup account.
  const credential = router
    ? await router.resolve({
        organizationSlug: config.organizationSlug ?? null,
      })
    : undefined;
  const accessToken = credential?.accessToken ?? token;
  // Every call carries the scope, so report one that does not exist now,
  // naming it, instead of as a generic 404 on each call.
  const { assertMcpScopeExists } = await import("./mcp/scope-check.js");
  await assertMcpScopeExists(config, accessToken);
  await serveMcpStdio(config, {
    accessToken,
    // Force a refresh past the usual threshold: the upstream already rejected
    // the current token, so mirror `--follow`'s refresh-on-401 behavior. The
    // pin keeps the refresh on the startup account. Requests can arrive
    // outside this call's async context, so the credential env is explicit.
    refreshAccessToken:
      credential?.refresh ??
      (() =>
        withEnv(credentialEnv, async () => {
          const refreshed = await resolveCliMcpCredential(config, {
            force: true,
            pin,
          });
          return refreshed.token;
        })),
    env,
  });
}

/**
 * Route tool calls between the stored logins on the MCP server's target
 * server, defaulting to `pin`, the account the server started with.
 */
function createRouter(
  config: McpTarget,
  credentialEnv: NodeJS.ProcessEnv,
  pin: StoredAccountPin,
): CredentialRouter {
  // Each read gets its own env copy, so its account scope and memoized
  // credentials are its own while other calls overlap.
  const withCredentialEnv = <T>(fn: () => T): T => {
    const copy: NodeJS.ProcessEnv = { ...credentialEnv };
    withEnv(credentialEnv, () => inheritEnvTokenHost(copy));
    return withEnv(copy, fn);
  };
  return createMcpAccountRouter({
    targetUrl: `${config.sentryProtocol}://${config.sentryHost}`,
    defaultPin: pin,
    withCredentialEnv,
    resolvePin: async (accountPin, { force }) => {
      const resolved = await withCredentialEnv(() =>
        resolveCliMcpCredential(config, { force, pin: accountPin }),
      );
      return resolved.token;
    },
    cacheOrgList: (account) =>
      withEnv(credentialEnv, () =>
        withStoredAccount(account, async () => {
          const { listOrganizationsUncached } =
            await import("./api/organizations.js");
          await listOrganizationsUncached();
        }),
      ),
  });
}
