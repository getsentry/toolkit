import { isatty } from "node:tty";
import { isSaaSTrustOrigin } from "@sentry/toolkit-core/sentry-origin";
import type { SentryContext } from "../../context.js";
import { pointDefaultUrlAtAccount } from "../../lib/account-selection.js";
import {
  getCurrentUser,
  getUserRegions,
  listOrganizationsUncached,
} from "../../lib/api-client.js";
import { normalizeAuthToken } from "../../lib/auth-header.js";
import { buildCommand, numberParser } from "../../lib/command.js";
import { normalizeUrl } from "../../lib/constants.js";
import {
  getAccountIdToReplace,
  getActiveAccountId,
  getActiveEnvVarName,
  hasStoredAuthCredentials,
  isAuthenticated,
  isEnvTokenActive,
  removeAccount,
  setActiveAccount,
  setAuthToken,
} from "../../lib/db/auth.js";
import { getAccountRow, isAccountRowUsable } from "../../lib/db/accounts.js";
import { getDbPath } from "../../lib/db/index.js";
import { getUserInfo, setUserInfo } from "../../lib/db/user.js";
import { getEnv } from "../../lib/env.js";
import {
  ApiError,
  AuthError,
  HostScopeError,
  ValidationError,
} from "../../lib/errors.js";
import { success } from "../../lib/formatters/colors.js";
import {
  formatDuration,
  formatUserIdentity,
} from "../../lib/formatters/human.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import type { LoginResult } from "../../lib/interactive-login.js";
import {
  assertExpectedLoginEmail,
  runInteractiveLogin,
  toLoginUser,
} from "../../lib/interactive-login.js";
import { logger } from "../../lib/logger.js";
import {
  buildHostRefusalMessage,
  isLoginHostTrusted,
  resolveEffectiveLoginHost,
} from "../../lib/login-host-guard.js";
import { resolveOAuthScopeString } from "../../lib/oauth.js";
import { clearResponseCache } from "../../lib/response-cache.js";
import { normalizeOrigin } from "../../lib/sentry-urls.js";
import {
  loadSentryCliRc,
  type SentryCliRcConfig,
} from "../../lib/sentryclirc.js";
import { registerLoginTrustAnchor } from "../../lib/token-host.js";

const log = logger.withTag("auth.login");

/** Format a {@link LoginResult} for human-readable terminal output. */
export function formatLoginResult(result: LoginResult): string {
  const lines: string[] = [];
  lines.push(
    success(
      `✔ ${result.method === "token" ? "Authenticated with API token" : "Authentication successful!"}`,
    ),
  );
  if (result.user) {
    lines.push(`  Logged in as: ${formatUserIdentity(result.user)}`);
  }
  if (result.method === "oauth" && result.refreshEnabled !== undefined) {
    if (result.refreshEnabled) {
      lines.push("  Automatic refresh: enabled");
    } else {
      lines.push("  Automatic refresh: unavailable");
      if (result.expiresIn !== undefined) {
        lines.push(
          `  Access token expires in: ${formatDuration(result.expiresIn)}`,
        );
      }
    }
  }
  lines.push(`  Config saved to: ${result.configPath}`);
  lines.push(""); // trailing newline
  return lines.join("\n");
}

type LoginFlags = {
  readonly token?: string;
  readonly timeout: number;
  readonly force: boolean;
  readonly url?: string;
  readonly "read-only": boolean;
  readonly scope?: readonly string[];
};

/**
 * Resolve the OAuth scope string from the login flags, enforcing mutual
 * exclusivity between `--token`, `--read-only`, and `--scope`.
 *
 * OAuth scope is fixed when a token is issued, so `--read-only` / `--scope`
 * cannot narrow an existing `--token`. `--read-only` and `--scope` are also
 * mutually exclusive — `--read-only` is a shorthand for a specific subset.
 *
 * @returns The resolved scope string for the device flow, or `undefined` to
 *   use the device flow's full default scope set.
 * @throws {ValidationError} on any conflicting flag combination or invalid
 *   scope value.
 */
function resolveLoginScope(flags: LoginFlags): string | undefined {
  const hasScope = flags.scope !== undefined && flags.scope.length > 0;
  const readOnly = flags["read-only"];

  if (flags.token && (readOnly || hasScope)) {
    const conflicting = readOnly ? "--read-only" : "--scope";
    throw new ValidationError(
      [
        `${conflicting} cannot be used with --token — OAuth scope is fixed when the token is issued, so the CLI cannot narrow an existing token's permissions.`,
        "",
        "To restrict OAuth scopes, drop --token and use the device flow:",
        "  sentry auth login --read-only",
        "  sentry auth login --scope project:read --scope org:read",
        "",
        "Or create a scoped User Auth Token in Sentry (Account → Auth Tokens) and pass it without --read-only/--scope.",
      ].join("\n"),
      readOnly ? "read-only" : "scope",
    );
  }

  if (readOnly && hasScope) {
    throw new ValidationError(
      "--read-only and --scope cannot be used together. Use --read-only for the read-only subset, or --scope to list exact scopes.",
      "scope",
    );
  }

  if (hasScope) {
    // Flatten comma-separated values so `-s a,b` and `-s a -s b` both work.
    const scopes = (flags.scope ?? []).flatMap((value) => value.split(","));
    return resolveOAuthScopeString({ scopes });
  }
  if (readOnly) {
    return resolveOAuthScopeString({ readOnly: true });
  }
  return;
}

/**
 * Normalize and validate the `--url` flag value. Accepts bare hostnames
 * and full URLs; returns the normalized origin.
 */
/** @internal exported for testing */
/**
 * Parse the optional `email` argument of `sentry auth login`: an email, or
 * `<email>:<server>` (the notation `sentry org list` shows, e.g.
 * `jane@acme.com:sentry.acme.com`) to also pick the server like `--url`.
 * Returns the trimmed argument; {@link splitLoginTarget} splits it.
 *
 * @throws {ValidationError} when the value is not an email address, or the
 *   server part is not a valid URL
 */
export function parseLoginEmail(raw: string): string {
  const target = raw.trim();
  splitLoginTarget(target, raw);
  return target;
}

/**
 * Split a `sentry auth login` target into its email and, for
 * `<email>:<server>`, the normalized server origin.
 *
 * @throws {ValidationError} when either part is invalid
 */
export function splitLoginTarget(
  target: string,
  raw = target,
): { email: string; url?: string } {
  const at = target.indexOf("@");
  // The separator is the first `:` after the `@`; the server part may
  // itself contain `:` (a scheme or port).
  const colon = at > 0 ? target.indexOf(":", at) : -1;
  const email = colon > 0 ? target.slice(0, colon) : target;
  if (
    at <= 0 ||
    at === email.length - 1 ||
    email.indexOf("@", at + 1) !== -1 ||
    /\s/.test(email)
  ) {
    throw new ValidationError(
      `Expected an email address (or <email>:<server>) to log in as, got '${raw}'.`,
      "email",
    );
  }
  if (colon < 0) {
    return { email };
  }
  const url = normalizeOrigin(normalizeUrl(target.slice(colon + 1)));
  if (!url) {
    throw new ValidationError(
      `Expected <email>:<server> with a valid server, got '${raw}'.`,
      "email",
    );
  }
  return { email, url };
}

/**
 * Apply the server of an `<email>:<server>` login target as `--url`.
 *
 * @throws {ValidationError} when `--url` names a different server
 */
function applyLoginTarget(
  flags: LoginFlags,
  target: string | undefined,
): { flags: LoginFlags; email?: string } {
  if (target === undefined) {
    return { flags };
  }
  const { email, url } = splitLoginTarget(target);
  if (!url) {
    return { flags, email };
  }
  if (flags.url && flags.url !== url) {
    throw new ValidationError(
      `'${target}' names ${url}, but --url is ${flags.url}. Pass only one server.`,
      "url",
    );
  }
  return { flags: { ...flags, url }, email };
}

export function parseLoginUrl(raw: string): string {
  const prefixed = normalizeUrl(raw);
  if (!prefixed) {
    throw new ValidationError("--url cannot be empty", "url");
  }
  const origin = normalizeOrigin(prefixed);
  if (!origin) {
    throw new ValidationError(`--url is not a valid URL: ${raw}`, "url");
  }
  return origin;
}

/**
 * Refuse `auth login` against a host that came from an untrusted channel
 * (rc-shim bypass wrote env.SENTRY_URL with no matching trust anchor).
 *
 * Two distinct attack shapes are blocked here:
 *
 * 1. **Token leak (`auth login --token X`)**: without the refusal, login
 *    validation POSTs the user's existing API token to the attacker's
 *    host — direct credential exfiltration.
 *
 * 2. **Phishing (`auth login` OAuth device flow)**: the CLI directs the
 *    user's browser to `<attacker-host>/oauth/authorize/...`. A
 *    homograph / look-alike domain plus a Sentry-cloned login page can
 *    capture the user's SSO credentials (Google, GitHub, etc.) — much
 *    worse than a single token leak because it compromises every
 *    service the SSO covers. `.sentryclirc` is a stealthy phishing
 *    vector because it slips through code review more easily than a
 *    `curl evil.com` would.
 *
 * `applyLoginUrl` only registers a trust anchor when the host comes from
 * a trusted source (`--url` flag or boot-time env snapshot), so "no
 * matching anchor" is the load-bearing signal that the host arrived via
 * an untrusted channel.
 *
 * @param rcSource - Path of the `.sentryclirc` file that provided the URL,
 *   if that's where the host came from. Used to produce a more actionable
 *   error message pointing at the specific file.
 */
function refuseLoginToUntrustedHost(
  flags: LoginFlags,
  effectiveHost: string,
  rcSource?: string,
): void {
  if (flags.url || isLoginHostTrusted(effectiveHost)) {
    return;
  }
  throw new HostScopeError(
    buildHostRefusalMessage(effectiveHost, {
      tokenFlag: !!flags.token,
      rcSource,
    }),
  );
}

/**
 * Resolve which `.sentryclirc` file (if any) provided the effective host, and
 * return its path alongside the full rc config for downstream use.
 */
async function resolveRcContext(
  flagUrl: string | undefined,
  cwd: string,
  effectiveHost: string,
): Promise<{
  rcConfig: SentryCliRcConfig;
  urlFromRc: string | undefined;
}> {
  const rcConfig = await loadSentryCliRc(cwd);
  const rcUrlNormalized = rcConfig.url
    ? normalizeOrigin(normalizeUrl(rcConfig.url))
    : undefined;
  const urlFromRc =
    !flagUrl &&
    !!rcUrlNormalized &&
    normalizeOrigin(effectiveHost) === rcUrlNormalized
      ? rcConfig.sources.url
      : undefined;
  return { rcConfig, urlFromRc };
}

/**
 * Returns a hint string when .sentryclirc contains a token the user could
 * pass directly via --token instead of going through the OAuth flow.
 * Returned as a footer hint so it appears after login completes, not before.
 *
 * Only shown when the stored token is plausibly for the current host: either
 * no URL is set in the rc file (global SaaS token) or the rc URL matches
 * effectiveHost. A mismatched URL means the token is for a different instance.
 */
/** @internal exported for testing */
export function rcTokenHint(
  rcConfig: SentryCliRcConfig,
  effectiveHost: string,
): string | undefined {
  if (!rcConfig.token) {
    return;
  }
  const rcUrl = rcConfig.url
    ? normalizeOrigin(normalizeUrl(rcConfig.url))
    : undefined;
  // Token is for a different host — don't suggest it
  if (rcUrl && rcUrl !== normalizeOrigin(effectiveHost)) {
    return;
  }
  // No URL in rc means a bare SaaS token — don't suggest it for self-hosted
  if (!(rcUrl || isSaaSTrustOrigin(effectiveHost))) {
    return;
  }
  // Always include --url for self-hosted instances regardless of how the host
  // was supplied — omitting it would point the user at SaaS instead.
  const urlHint = isSaaSTrustOrigin(effectiveHost)
    ? ""
    : ` --url ${effectiveHost}`;
  return (
    `Found a token in .sentryclirc (${rcConfig.sources.token}). ` +
    "To import it: sentry cli import | " +
    `To pass it directly: sentry auth login --token <token>${urlHint}`
  );
}

/**
 * Persist an explicit `--url` host as the stored default so subsequent CLI
 * invocations route to the account just logged in to without requiring
 * `SENTRY_HOST`: a self-hosted host is stored, SaaS clears a previous
 * self-hosted default. Only writes when `--url` was explicitly passed;
 * env/rc-sourced values persist through those channels. Non-fatal on DB
 * failure.
 */
function persistLoginUrlAsDefault(
  flagUrl: string | undefined,
  effectiveHost: string,
): void {
  if (!flagUrl) {
    return;
  }
  try {
    pointDefaultUrlAtAccount(effectiveHost);
  } catch {
    log.debug(
      `Could not persist default URL to DB; host is recorded on the stored token. Set SENTRY_HOST or run 'sentry cli defaults url ${effectiveHost}' if subsequent commands route incorrectly.`,
    );
  }
}

/**
 * When `--url` is passed, set `env.SENTRY_HOST`/`env.SENTRY_URL` so the
 * device flow and token refresh hit the requested host. Returns the
 * effective host so callers can record it with {@link setAuthToken}.
 *
 * Registers a login trust anchor (consumed by {@link applyCustomHeaders}
 * for IAP onboarding) only when `--url` is explicitly passed — the user's
 * argv is the only trusted source for this. When `--url` is absent, the
 * effective host comes from current env (which may have been written by the
 * `.sentryclirc` shim) and is NOT registered as a trust anchor.
 */
export function applyLoginUrl(url: string | undefined): string {
  const env = getEnv();

  if (url) {
    env.SENTRY_HOST = url;
    env.SENTRY_URL = url;
    registerLoginTrustAnchor(url);
    return url;
  }

  return resolveEffectiveLoginHost();
}

/**
 * Handle the case where the user is already authenticated.
 *
 * Returns `true` if the login flow should proceed, or `false` if the
 * command should exit early. Without `--force` the new login is added
 * alongside the current account and becomes active (logging in again as
 * the same user replaces that user's old account); with `--force` it
 * replaces the stored login for the same server (or adds one when that
 * server has none). Accounts on other servers are never touched.
 *
 * - Env-var auth only: proceeds (stored OAuth is kept separately).
 * - `--force`: proceeds without prompting.
 * - Interactive TTY: prompts user to confirm adding another account.
 * - Non-interactive without `--force`: prints a message and blocks.
 */
async function handleExistingAuth(force: boolean): Promise<boolean> {
  if (isEnvTokenActive()) {
    const envVar = getActiveEnvVarName();
    log.warn(
      `${envVar} is set in your environment (likely from build tooling).\n` +
        "  OAuth credentials will be stored separately and used for CLI commands.",
    );
    // If no stored credential exists, proceed directly to login
    if (!hasStoredAuthCredentials()) {
      return true;
    }
    // Fall through to the re-auth confirmation logic below
  }

  if (!force) {
    // Non-interactive (piped, CI): print message and block
    if (!isatty(0)) {
      log.info(
        "You are already authenticated. Use 'sentry auth login <email>' to add another account, " +
          "or '--force' to replace the current login.",
      );
      return false;
    }

    // Interactive TTY: prompt user to confirm re-authentication
    const userInfo = getUserInfo();
    const identity = userInfo ? formatUserIdentity(userInfo) : "current user";
    const confirmed = await log.prompt(
      `Already authenticated as ${identity}. Add another account? ` +
        "(The current account stays saved; see 'sentry auth list'. Use --force to replace it.)",
      { type: "confirm", initial: false },
    );

    // Symbol(clack:cancel) is truthy — strict equality check
    if (confirmed !== true) {
      return false;
    }
  }

  return true;
}

/**
 * Drop a `--token` login that failed validation and make the previously
 * active account active again. The token is always stored as its own
 * account until it checks out, so `previousAccountId` is still intact here.
 */
async function discardTokenLogin(
  accountId: string,
  previousAccountId: string | undefined,
): Promise<void> {
  await removeAccount(accountId);
  if (previousAccountId && previousAccountId !== accountId) {
    setActiveAccount(previousAccountId);
  }
}

/**
 * Handle a failure while validating a user-supplied `--token` via
 * {@link getUserRegions}. A 401/403 means the token itself is rejected (invalid
 * or insufficiently scoped) — remove the account it was stored as, restore the
 * previously active account, and raise a user-facing {@link AuthError}.
 * Any other failure (network, 5xx, parse) is NOT a token problem, so the
 * original error is re-thrown: surfacing "Invalid API token" would mislead the
 * user and discard the real cause. The unconfirmed token must not take over
 * the session either: when the previously active account still has usable
 * credentials, the token is dropped and that account restored (the user can
 * retry). Otherwise (no other account, or its credentials expired or were
 * rejected) the token is kept, since discarding a possibly-valid token on a
 * transient blip would leave the user logged out (CLI-19).
 *
 * @throws {AuthError} for a 401/403 (after removing the stored token)
 * @throws the original error for any other failure
 */
async function handleTokenValidationError(
  error: unknown,
  accountId: string,
  previousAccountId: string | undefined,
): Promise<never> {
  if (
    error instanceof ApiError &&
    (error.status === 401 || error.status === 403)
  ) {
    await discardTokenLogin(accountId, previousAccountId);
    throw new AuthError(
      "invalid",
      "Invalid API token. Please check your token and try again.",
    );
  }
  if (hasUsablePreviousAccount(accountId, previousAccountId)) {
    await discardTokenLogin(accountId, previousAccountId);
  }
  throw error;
}

/** Whether the account active before this login can still authenticate. */
function hasUsablePreviousAccount(
  accountId: string,
  previousAccountId: string | undefined,
): previousAccountId is string {
  if (!previousAccountId || previousAccountId === accountId) {
    return false;
  }
  const row = getAccountRow(previousAccountId);
  return row !== undefined && isAccountRowUsable(row);
}

export const loginCommand = buildCommand({
  auth: false,
  skipRcUrlCheck: true,
  docs: {
    brief: "Authenticate with Sentry",
    fullDescription:
      "Log in to Sentry using OAuth or an API token.\n\n" +
      "The OAuth flow uses a device code - you'll be given a code to enter at a URL.\n" +
      "Alternatively, use --token to authenticate with an existing API token.\n\n" +
      "For self-hosted Sentry, pass --url <url> (or an <email>:<server>\n" +
      "argument) to authenticate against that instance. This is the ONLY way\n" +
      "to trust a new Sentry host — URL arguments and config files are\n" +
      "refused when they don't match the currently-authenticated host.\n\n" +
      "When already logged in, the new login is stored as another account\n" +
      "(see 'sentry auth list' / 'sentry auth switch'); --force instead\n" +
      "replaces the stored login for that server (accounts on other servers\n" +
      "are kept). Pass an email (or <email>:<server>, as 'sentry org list'\n" +
      "shows it) to add or log in again to that account without prompting:\n" +
      "Sentry approves the request as whoever is signed in to the browser,\n" +
      "so a login approved as another user is refused and nothing is saved.\n\n" +
      "Examples:\n" +
      "  sentry auth login\n" +
      "  sentry auth login jane@acme.com\n" +
      "  sentry auth login jane@acme.com --url https://sentry.acme.com\n" +
      "  sentry auth login jane@acme.com:sentry.acme.com",
  },
  parameters: {
    flags: {
      token: {
        kind: "parsed",
        parse: String,
        brief: "Authenticate using an API token instead of OAuth",
        optional: true,
      },
      timeout: {
        kind: "parsed",
        parse: numberParser,
        brief: "Timeout for OAuth flow in seconds (default: 900)",
        // Stricli passes string defaults through parse(); numberParser converts to number
        default: "900",
      },
      force: {
        kind: "boolean",
        brief:
          "Replace the stored login for this server without prompting, instead of adding another account",
        default: false,
      },
      url: {
        kind: "parsed",
        parse: parseLoginUrl,
        brief:
          "Sentry instance URL to authenticate against (e.g. https://sentry.example.com). " +
          "Required for self-hosted; defaults to SaaS (https://sentry.io).",
        optional: true,
      },
      "read-only": {
        kind: "boolean",
        brief:
          "Request only read-only OAuth scopes (project:read, org:read, event:read, member:read, team:read). " +
          "Useful for handing tokens to AI agents or CI jobs that should not be able to mutate Sentry state.",
        default: false,
      },
      scope: {
        kind: "parsed",
        parse: String,
        brief:
          "Request specific OAuth scopes (repeatable, comma-separated). " +
          "E.g. --scope project:read --scope org:read. Overrides the default scope set.",
        variadic: true,
        optional: true,
      },
    },
    aliases: { s: "scope" },
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "email",
          brief:
            "Email of the account to add or log in to again (<email>:<server> also sets --url); the login is refused if you approve it as someone else",
          parse: parseLoginEmail,
          optional: true,
        },
      ],
    },
  },
  output: { human: formatLoginResult },
  async *func(this: SentryContext, rawFlags: LoginFlags, target?: string) {
    // `<email>:<server>` picks the server just like `--url <server>`.
    const { flags, email } = applyLoginTarget(rawFlags, target);
    // Resolve OAuth scopes up front so conflicting flag combinations
    // (--token + --read-only/--scope, --read-only + --scope) and invalid
    // scope values fail fast before any network or DB work.
    const oauthScope = resolveLoginScope(flags);
    // Validate explicit credentials before changing the host or replacing an
    // existing session. An empty --token is invalid, not an OAuth request.
    const token =
      flags.token === undefined ? undefined : normalizeAuthToken(flags.token);

    // Apply --url first so the device flow / token refresh target the
    // requested instance. Default URL persistence is deferred until login
    // succeeds — see persistLoginUrlAsDefault calls below.
    const effectiveHost = applyLoginUrl(flags.url);

    // Check whether the effective URL came from .sentryclirc so we can name
    // the source file in trust-refusal errors and show a migration tip.
    const { rcConfig, urlFromRc } = await resolveRcContext(
      flags.url,
      this.cwd,
      effectiveHost,
    );

    refuseLoginToUntrustedHost(flags, effectiveHost, urlFromRc);

    // Check if already authenticated and handle re-authentication. Naming
    // the account to log in to is an explicit request to add (or refresh)
    // that account, so it skips the prompt.
    if (email === undefined && isAuthenticated()) {
      const shouldProceed = await handleExistingAuth(flags.force);
      if (!shouldProceed) {
        return;
      }
    }

    // oxlint-disable-next-line sentry-cli/no-silent-catch -- grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    try {
      await clearResponseCache();
    } catch {
      // Non-fatal: cache directory may not exist
    }

    // `--force` replaces the stored login for this server; otherwise the
    // login is stored as another account (see handleExistingAuth).
    const newAccount = email !== undefined || !flags.force;

    if (token !== undefined) {
      // Save token first (with host scope), then validate by fetching user
      // regions. It is always stored as its own account so a rejected token
      // never touches the stored ones; with `--force` the stored login for
      // this server (never another server's) is replaced only once the new
      // token checks out.
      const previousAccountId = getActiveAccountId();
      const replacedAccountId = newAccount
        ? undefined
        : getAccountIdToReplace(effectiveHost);
      const accountId = setAuthToken(token, undefined, undefined, {
        host: effectiveHost,
        newAccount: true,
      });

      try {
        await getUserRegions();
      } catch (error) {
        await handleTokenValidationError(error, accountId, previousAccountId);
      }

      // Fetch and cache user info via /auth/ (works with all token types).
      // A transient failure here must not block login — the token is already valid.
      const result: LoginResult = {
        method: "token",
        configPath: getDbPath(),
      };
      let user: Awaited<ReturnType<typeof getCurrentUser>> | undefined;
      try {
        user = await getCurrentUser();
      } catch (error) {
        // Non-fatal: user info is supplementary. Token remains stored and valid.
        log.debug("Could not fetch user info after token login", error);
      }
      if (email !== undefined) {
        try {
          assertExpectedLoginEmail(email, user?.email);
        } catch (error) {
          await discardTokenLogin(accountId, previousAccountId);
          throw error;
        }
      }
      // Only now is the login kept: a rejected email above restores the
      // previous account, so the default URL must not have moved yet.
      persistLoginUrlAsDefault(flags.url, effectiveHost);
      if (user) {
        try {
          setUserInfo({
            userId: user.id,
            email: user.email ?? undefined,
            username: user.username ?? undefined,
            name: user.name ?? undefined,
          });
        } catch (error) {
          // Non-fatal: user info is supplementary. Token remains stored and valid.
          log.debug("Could not store user info after token login", error);
        }
        result.user = toLoginUser(user);
      }
      // Replace this server's previous login only now. After setUserInfo,
      // so a re-login as the same user folds that account in (keeping a
      // known username) instead of losing it; then this is a no-op.
      if (replacedAccountId && replacedAccountId !== accountId) {
        await removeAccount(replacedAccountId);
      }

      // Warm the org + region cache so the first real command is fast.
      // Fire-and-forget — login already succeeded, caching is best-effort.
      warmOrgCache();
      return yield new CommandOutput(result);
    }

    // OAuth device flow (host scope recorded via completeOAuthFlow → setAuthToken)
    const result = await runInteractiveLogin({
      timeout: flags.timeout * 1000,
      scope: oauthScope,
      newAccount,
      expectedEmail: email,
    });

    if (result) {
      persistLoginUrlAsDefault(flags.url, effectiveHost);
      warmOrgCache();
      yield new CommandOutput(result);
      return { hint: rcTokenHint(rcConfig, effectiveHost) };
    }
    // Error already displayed by runInteractiveLogin
    process.exitCode = 1;
  },
});

/**
 * Pre-populate the org + region SQLite cache in the background.
 *
 * Called after successful authentication so that the first real command
 * doesn't pay the cold-start cost of `getUserRegions()` + fan-out to
 * each region's org list endpoint (~800ms on a typical SaaS account).
 *
 * Failures are silently ignored — the cache will be populated lazily
 * on the next command that needs it.
 */
function warmOrgCache(): void {
  // oxlint-disable-next-line sentry-cli/no-silent-catch -- grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  listOrganizationsUncached().catch(() => {
    // Best-effort: cache warming failure doesn't affect the login result
  });
}
