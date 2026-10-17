/**
 * Authentication credential storage.
 *
 * Credentials live in the multi-row `accounts` table (see `accounts.ts`).
 * Every read and refresh here targets one *effective* account, so the rest
 * of the CLI keeps a one-credential view while users store several logins.
 *
 * The effective account is chosen per invocation, most specific first:
 *   1. The invocation's default account, chosen because it knows the
 *      targeted organization ({@link selectAccountForOrg}). Each invocation
 *      chooses again, so different commands can use different accounts.
 *   2. An account on the configured server (`SENTRY_HOST`/`SENTRY_URL`,
 *      `--url`, a pasted Sentry URL, or `.sentryclirc`) when the active
 *      account is on a different one.
 *   3. The active account (`sentry auth login` / `sentry auth switch`).
 */

import { normalizeAuthToken, trimAuthToken } from "../auth-header.js";
import {
  clearPersistedDefaultUrl,
  DEFAULT_SENTRY_URL,
  getConfiguredSentryUrl,
  isPersistedDefaultUrlInEffect,
  markPersistedDefaultUrl,
} from "../constants.js";
import { getEnv } from "../env.js";
import {
  getBootConfiguredSentryUrl,
  getEnvTokenHost,
} from "../env-token-host.js";
import { ConfigError } from "../errors.js";
import { logger } from "../logger.js";
import { normalizeHttpOrigin } from "../sentry-urls.js";
import { withDbSpan } from "../telemetry.js";
import {
  type AccountRow,
  accountIdentity,
  activateAccountRow,
  deleteAccountOrgRegions,
  deleteAccountRows,
  getAccountRow,
  getActiveAccountRow,
  getMostRecentAccountRow,
  hasCachedOrgList,
  insertActiveAccountRow,
  isAccountRowUsable,
  isSameServer,
  listAccountRows,
  listAccountRowsByRecency,
  listUsableAccountRowsByRecency,
  listUsableAccountRowsForOrg,
} from "./accounts.js";
import { getAccountScope, resetAccountScopes } from "./account-scope.js";
import { hashIdentity } from "./identity-hash.js";
import { getDatabase } from "./index.js";
import { clearAllIssueOrgCache } from "./issue-org-cache.js";
import { clearTrustedHostState, ORG_CACHE_TTL_MS } from "./regions.js";

/** Refresh when less than 10% of token lifetime remains */
export const REFRESH_THRESHOLD = 0.1;

/** Default token lifetime (1 hour) for tokens without issuedAt */
export const DEFAULT_TOKEN_LIFETIME_MS = 3600 * 1000;

/**
 * The active account row. `host` is NULL only for rows migrated from the
 * pre-v16 `auth` table; `migrateNullHost` backfills it on access.
 */
type AuthRow = AccountRow;

const log = logger.withTag("auth");

/** `SENTRY_HOST`/`SENTRY_URL`, or `undefined` when unset or malformed. */
function getConfiguredUrlOrUndefined(): string | undefined {
  try {
    return getConfiguredSentryUrl();
  } catch (error) {
    // Malformed values surface where requests are built; selection ignores them.
    log.debug(
      "Ignoring invalid SENTRY_HOST/SENTRY_URL for account selection",
      error,
    );
    return;
  }
}

/**
 * Prefer an account on the configured server when the active account is
 * on another one. Without a configured server, or without a stored
 * account for it, the active account stays in effect (and the host trust
 * checks report the mismatch exactly as before).
 */
function selectAccountForConfiguredHost(
  active: AuthRow | undefined,
): AuthRow | undefined {
  const configured = getConfiguredUrlOrUndefined();
  if (!configured) {
    return active;
  }
  // NULL host: pre-v16 row, scoped lazily by migrateNullHost. Keep it.
  if (active && (!active.host || isSameServer(active.host, configured))) {
    return active;
  }
  // Same-server matching (origin normalization, `*.sentry.io` as one
  // server) stays in TypeScript; SQL already filtered and ordered the rows.
  const onHost = listUsableAccountRowsByRecency().find(
    (row) => row.host && isSameServer(row.host, configured),
  );
  return onHost ?? active;
}

/**
 * The effective account row for credential reads: the invocation's default
 * account, else one on the configured server, else the active one.
 * Account management (switch, logout) uses the stored active row directly.
 */
function getAuthRow(): AuthRow | undefined {
  const defaultAccountId = getAccountScope().accountId;
  if (defaultAccountId) {
    const row = getAccountRow(defaultAccountId);
    if (row) {
      return row;
    }
  }
  return selectAccountForConfiguredHost(getActiveAccountRow());
}

/** The stored account whose credentials this invocation uses, if any. */
export function getEffectiveAccountRow(): AccountRow | undefined {
  return getAuthRow();
}

/**
 * Key for memoized credential state. The effective account depends on the
 * invocation's default account and configured server, so the memo must too.
 */
function selectionKey(): string {
  return `${getAccountScope().accountId ?? ""}\0${getConfiguredUrlOrUndefined() ?? ""}`;
}

/**
 * Lazy migration for rows created before schema v16 (NULL `host`).
 *
 * Uses only the BOOT-TIME explicit URL snapshot, captured before the
 * `.sentryclirc` shim could mutate env. Reading the current env directly
 * would either default self-hosted users to SaaS (when the shim hasn't run
 * yet) or migrate to a poisoned rc URL (when it has).
 *
 * Users whose shell env was wrong at upgrade time can recover with
 * `sentry auth logout && sentry auth login`. Returns the migrated host
 * (never NULL on return).
 */
function migrateNullHost(row: AuthRow): string {
  const bootHost = getBootConfiguredSentryUrl();
  const host = bootHost
    ? normalizeCredentialHost(bootHost)
    : DEFAULT_SENTRY_URL;
  // oxlint-disable-next-line sentry-cli/no-silent-catch -- grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    withDbSpan("migrateAuthHost", () => {
      const db = getDatabase();
      db.query("UPDATE accounts SET host = ? WHERE account_id = ?").run(
        host,
        row.account_id,
      );
    });
    log.info(`Migrated stored credentials to host-scoped model: ${host}`);
  } catch {
    // Non-fatal: if the migration write fails, callers still get a
    // well-formed host from this function. The migration will retry
    // on the next access.
  }
  row.host = host;
  return host;
}

/**
 * Backfill the active account's legacy NULL host (see `migrateNullHost`).
 * Account mutations call this around activation so no stored account is
 * left without a host, and `auth switch`/`logout` can point the default
 * URL at a concrete server instead of keeping a previous account's.
 */
function backfillActiveNullHost(): void {
  const row = getActiveAccountRow();
  if (row && !row.host) {
    migrateNullHost(row);
  }
}

function normalizeCredentialHost(host: string): string {
  const origin = normalizeHttpOrigin(host);
  if (!origin) {
    throw new ConfigError(
      "Stored credential host must be a credential-free HTTP(S) URL.",
    );
  }
  return origin;
}

/** Prefix for environment variable auth sources in {@link AuthSource} */
export const ENV_SOURCE_PREFIX = "env:";

/** Where the auth token originated */
export type AuthSource = "env:SENTRY_AUTH_TOKEN" | "env:SENTRY_TOKEN" | "oauth";

export type AuthConfig = {
  token?: string;
  refreshToken?: string;
  expiresAt?: number;
  issuedAt?: number;
  source: AuthSource;
};

/**
 * Read the trimmed env token even when stored OAuth takes priority.
 * Does not validate credentials that may never be used.
 */
export function getRawEnvToken(): string | undefined {
  return getEnvToken()?.token;
}

/**
 * Read token from environment variables.
 * `SENTRY_AUTH_TOKEN` takes priority over `SENTRY_TOKEN` (matches legacy sentry-cli).
 * Empty or whitespace-only values are treated as unset.
 *
 * This function is intentionally pure (no DB access). The "prefer stored OAuth
 * over env token" logic lives in {@link getAuthToken} and {@link getAuthConfig}
 * which check the DB first when `SENTRY_FORCE_ENV_TOKEN` is not set.
 */
function getEnvToken(): { token: string; source: AuthSource } | undefined {
  // Preserve presence rules: whitespace is unset, but control-only credentials
  // must remain selected so validation cannot silently fall back to another identity.
  const authToken = getEnv().SENTRY_AUTH_TOKEN?.trim();
  if (authToken) {
    return {
      token: trimAuthToken(authToken) || authToken,
      source: "env:SENTRY_AUTH_TOKEN",
    };
  }
  const sentryToken = getEnv().SENTRY_TOKEN?.trim();
  if (sentryToken) {
    return {
      token: trimAuthToken(sentryToken) || sentryToken,
      source: "env:SENTRY_TOKEN",
    };
  }
  return;
}

/**
 * Check if authentication is coming from an environment variable.
 * Use this to skip refresh/OAuth logic that doesn't apply to env tokens.
 */
export function isEnvTokenActive(): boolean {
  return getEnvToken() !== undefined;
}

/**
 * Get the name of the env var providing a token, for error messages.
 * Returns the specific variable name (e.g. "SENTRY_AUTH_TOKEN" or "SENTRY_TOKEN")
 * by checking which env var {@link getRawEnvToken} would read.
 * Falls back to "SENTRY_AUTH_TOKEN" if no env var is set.
 */
export function getActiveEnvVarName(): string {
  return getEnvToken()?.source === "env:SENTRY_TOKEN"
    ? "SENTRY_TOKEN"
    : "SENTRY_AUTH_TOKEN";
}

export function getAuthConfig(): AuthConfig | undefined {
  // When SENTRY_FORCE_ENV_TOKEN is set, check env first (old behavior).
  // Otherwise, check the DB first — stored OAuth takes priority over env tokens.
  // This is the core fix for #646: wizard-generated build tokens no longer
  // silently override the user's interactive login.
  const forceEnv = getEnv().SENTRY_FORCE_ENV_TOKEN?.trim();
  if (forceEnv) {
    const envToken = getEnvToken();
    if (envToken) {
      return { token: envToken.token, source: envToken.source };
    }
  }

  const dbConfig = withDbSpan("getAuthConfig", () => {
    const row = getAuthRow();

    if (!row?.token) {
      return;
    }

    // Skip expired tokens without a refresh token — they're unusable.
    // Expired tokens WITH a refresh token are kept: auth refresh and
    // refreshToken() need them to perform the OAuth refresh flow.
    if (row.expires_at && Date.now() > row.expires_at && !row.refresh_token) {
      return;
    }

    return {
      token: row.token ?? undefined,
      refreshToken: row.refresh_token ?? undefined,
      expiresAt: row.expires_at ?? undefined,
      issuedAt: row.issued_at ?? undefined,
      source: "oauth" as const,
    };
  });
  if (dbConfig) {
    return dbConfig;
  }

  // No stored OAuth — fall back to env token
  const envToken = getEnvToken();
  if (envToken) {
    return { token: envToken.token, source: envToken.source };
  }
  return;
}

/**
 * Read the host the stored OAuth token is scoped to.
 *
 * Lazy-migrates NULL hosts (rows from before schema v16) to the currently-
 * configured host on first access. Returns `undefined` when no stored token
 * exists — callers should fall through to the env-token host snapshot.
 *
 * This function is intentionally tolerant of "no DB" errors (tests that
 * bypass DB init). On DB failure, returns `undefined` and trust-scoping
 * falls back to the caller's default behavior.
 */
export function getStoredAuthHost(): string | undefined {
  // oxlint-disable-next-line sentry-cli/no-silent-catch -- grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    return withDbSpan("getStoredAuthHost", () => {
      const row = getAuthRow();
      if (!row?.token) {
        return;
      }
      if (row.host) {
        return row.host;
      }
      // Lazy migration for pre-v16 rows
      return migrateNullHost(row);
    });
  } catch {
    return;
  }
}

/**
 * Check whether a usable stored token exists in the auth row.
 *
 * Mirrors the "usable" criteria in `getAuthConfig`: a token is usable if it
 * has a bearer value AND (no expiry, OR not expired, OR expired-with-refresh).
 *
 * Used by {@link getActiveTokenHost} to decide whether to prefer stored
 * OAuth's host over the env-token snapshot.
 */
export function hasUsableStoredToken(): boolean {
  // oxlint-disable-next-line sentry-cli/no-silent-catch -- grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    return withDbSpan("hasUsableStoredToken", () => {
      const row = getAuthRow();
      if (!row?.token) {
        return false;
      }
      // Match getAuthConfig's filter: expired-no-refresh rows are unusable
      if (row.expires_at && Date.now() > row.expires_at && !row.refresh_token) {
        return false;
      }
      return true;
    });
  } catch {
    return false;
  }
}

/**
 * Atomically check usability AND retrieve the stored host, in a single
 * DB read. Used by `getActiveTokenHost` so that a concurrent
 * `clearAuth()` (library mode) can't interleave between a
 * `hasUsableStoredToken()` check and a `getStoredAuthHost()` read,
 * producing an inconsistent "usable but undefined host" fallback.
 *
 * Returns `undefined` when no usable stored token exists. When present,
 * returns the normalized host string (migrating pre-v16 NULL rows on
 * first access, same as {@link getStoredAuthHost}).
 */
export function getUsableStoredTokenHost(): string | undefined {
  // oxlint-disable-next-line sentry-cli/no-silent-catch -- grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    return withDbSpan("getUsableStoredTokenHost", () => {
      const row = getAuthRow();
      if (!row?.token) {
        return;
      }
      if (row.expires_at && Date.now() > row.expires_at && !row.refresh_token) {
        return;
      }
      if (row.host) {
        return row.host;
      }
      return migrateNullHost(row);
    });
  } catch {
    return;
  }
}

const authCacheState = {
  tokens: new WeakMap<
    NodeJS.ProcessEnv,
    Map<string, { value: string | undefined }>
  >(),
  fingerprints: new WeakMap<NodeJS.ProcessEnv, Map<string, string>>(),
};

/** The per-env, per-selection memo map in `store`, created on first use. */
function memoFor<T>(
  store: WeakMap<NodeJS.ProcessEnv, Map<string, T>>,
): Map<string, T> {
  const env = getEnv();
  let memo = store.get(env);
  if (!memo) {
    memo = new Map();
    store.set(env, memo);
  }
  return memo;
}

/**
 * Get the active auth token.
 *
 * Default: checks the DB first (stored OAuth wins), then falls back to env vars.
 * With `SENTRY_FORCE_ENV_TOKEN=1`: checks env vars first (old behavior).
 */
export function getAuthToken(): string | undefined {
  const memo = memoFor(authCacheState.tokens);
  const key = selectionKey();
  const cached = memo.get(key);
  if (cached !== undefined) {
    return cached.value;
  }
  const value = computeAuthToken();
  memo.set(key, { value });
  return value;
}

function computeAuthToken(): string | undefined {
  const forceEnv = getEnv().SENTRY_FORCE_ENV_TOKEN?.trim();
  if (forceEnv) {
    const envToken = getEnvToken();
    if (envToken) {
      return envToken.token;
    }
  }

  const dbToken = withDbSpan("getAuthToken", () => {
    const row = getAuthRow();

    if (!row?.token) {
      return;
    }

    if (row.expires_at && Date.now() > row.expires_at) {
      return;
    }

    return row.token;
  });
  if (dbToken) {
    return dbToken;
  }

  // No stored OAuth — fall back to env token
  const envToken = getEnvToken();
  if (envToken) {
    return envToken.token;
  }
  return;
}

/** Reset the memoized auth token. Tests only — call between auth-state mutations. */
export function resetAuthTokenCache(): void {
  authCacheState.tokens = new WeakMap();
}

/** Memoized results for {@link hasStoredAuthCredentials}, by selection. */
const cachedHasStoredCreds = new Map<string, boolean>();

/** Memoized effective auth rows for {@link refreshToken}, by selection. */
const cachedAuthRows = new Map<string, { value: AuthRow | undefined }>();

function getCachedAuthRow(): AuthRow | undefined {
  const key = selectionKey();
  const cached = cachedAuthRows.get(key);
  if (cached !== undefined) {
    return cached.value;
  }
  const row = getAuthRow();
  cachedAuthRows.set(key, { value: row });
  return row;
}

/** Reset the memoized auth row. Tests only — call between auth-state mutations. */
export function resetAuthRowCache(): void {
  cachedAuthRows.clear();
}

/** Reset the memoized stored-credentials flag. Tests only — call between auth-state mutations. */
export function resetHasStoredCredsCache(): void {
  cachedHasStoredCreds.clear();
}

/**
 * Forget default accounts chosen by {@link selectAccountForOrg}. Tests only:
 * in the CLI the choice lasts for the invocation, and library calls get a
 * fresh env.
 */
export function resetAccountSelection(): void {
  resetAccountScopes();
  clearPersistedDefaultUrl();
  resetActiveCredentialState();
}

/**
 * Options for persisting a token.
 *
 * @property host - Origin URL the token was issued against. When omitted on
 *   an update (e.g., access-token refresh), the existing row's host is
 *   preserved. When omitted on a fresh write, defaults to the
 *   currently-configured host (`SENTRY_HOST`/`SENTRY_URL`) or `DEFAULT_SENTRY_URL`.
 * @property newAccount - Store the token as a new account and make it
 *   active instead of overwriting the active account's credentials. Login
 *   flows set this so earlier logins stay available to `sentry auth switch`.
 *   Recording user info afterwards ({@link setUserInfo}) folds a re-login to
 *   the same user on the same host into one account.
 */
export type SetAuthTokenOptions = {
  host?: string;
  newAccount?: boolean;
};

/** Drop all memoized active-credential state after an account mutation. */
function resetActiveCredentialState(): void {
  resetIdentityFingerprintCache();
  refreshIdentityAliases.clear();
  resetAuthTokenCache();
  resetAuthRowCache();
  resetHasStoredCredsCache();
}

/**
 * Normalize an access token before storage; malformed input leaves the
 * stored accounts unchanged. Returns the id of the account written.
 */
export function setAuthToken(
  token: string,
  expiresIn?: number,
  newRefreshToken?: string,
  options?: SetAuthTokenOptions,
): string {
  const normalizedToken = normalizeAuthToken(token);
  // A login, not a refresh: it targets the stored active account (or a new
  // one), never the account this invocation picked for its target org, and
  // the new credentials are what the rest of the invocation uses.
  getAccountScope().accountId = undefined;
  const accountId = withDbSpan("setAuthToken", () => {
    const db = getDatabase();
    const now = Date.now();
    const expiresAt = expiresIn ? now + expiresIn * 1000 : null;
    const issuedAt = expiresIn ? now : null;

    // Replacing credentials in place targets the stored login for the
    // login's server — never an account on another server, whatever
    // SENTRY_HOST or `.sentryclirc` says. With none there, a new account.
    const existing = options?.newAccount
      ? undefined
      : findAccountToReplace(options?.host);
    // Host resolution precedence:
    //   1. Explicit `options.host` (login command, tests)
    //   2. Existing row's `host` (refresh flow preserves the original scope)
    //   3. Currently-configured host (getConfiguredSentryUrl)
    //   4. SaaS default
    // Always normalized to scheme+host[+port].
    const rawHost =
      options?.host ??
      existing?.host ??
      getConfiguredSentryUrl() ??
      DEFAULT_SENTRY_URL;
    const host = normalizeCredentialHost(rawHost);

    const values = {
      host,
      token: normalizedToken,
      refresh_token: newRefreshToken ?? null,
      expires_at: expiresAt,
      issued_at: issuedAt,
    };
    if (!existing) {
      // A new account is a new identity: drop caches scoped to the
      // previous account's permissions but not keyed by it.
      backfillActiveNullHost();
      clearUnscopedIdentityCaches();
      return insertActiveAccountRow(values, now);
    }
    db.query(
      "UPDATE accounts SET host = ?, token = ?, refresh_token = ?, expires_at = ?, issued_at = ?, updated_at = ? WHERE account_id = ?",
    ).run(
      values.host,
      values.token,
      values.refresh_token,
      values.expires_at,
      values.issued_at,
      now,
      existing.account_id,
    );
    if (existing.is_active !== 1) {
      // Logging in to another server's stored account makes it active,
      // like adding an account does; it is a different identity.
      backfillActiveNullHost();
      clearUnscopedIdentityCaches();
      activateAccountRow(existing.account_id);
    }
    return existing.account_id;
  });
  // Active credential changed — drop memoized fingerprint, token, row, and
  // stored-credentials flag so the next read reflects the new row.
  resetActiveCredentialState();
  return accountId;
}

/**
 * The stored account a login to `host` replaces in place (`sentry auth
 * login --force`, automatic re-login): the active account when it is on
 * that server, else the most recently used account on it. Accounts are
 * tied to their server, so a login never overwrites another server's
 * account; `undefined` when no stored account is on `host` (the login is
 * then stored as a new account). Without a host (credential updates that
 * keep the existing scope), the active account.
 */
function findAccountToReplace(host: string | undefined): AuthRow | undefined {
  const active = getActiveAccountRow();
  if (!host) {
    return active;
  }
  const loginHost = normalizeCredentialHost(host);
  if (
    active &&
    isSameServer(active.host ?? migrateNullHost(active), loginHost)
  ) {
    return active;
  }
  return listAccountRowsByRecency().find(
    (row) => row.host && isSameServer(row.host, loginHost),
  );
}

/**
 * Id of the stored account a login to `host` replaces (see
 * {@link findAccountToReplace}), or `undefined` when it adds one.
 */
export function getAccountIdToReplace(host: string): string | undefined {
  return withDbSpan("getAccountIdToReplace", () => findAccountToReplace(host))
    ?.account_id;
}

/**
 * Clear caches whose entries are scoped to one identity's permissions but
 * not keyed by it (pagination cursors, issue-id → org mappings), plus the
 * in-process trust extension.
 */
function clearUnscopedIdentityCaches(): void {
  const db = getDatabase();
  db.query("DELETE FROM pagination_cursors").run();
  clearAllIssueOrgCache();
  clearTrustedHostState();
}

async function clearResponseCacheBestEffort(): Promise<void> {
  // Dynamic import avoids the auth→response-cache→auth cycle.
  try {
    const { clearResponseCache } = await import("../response-cache.js");
    await clearResponseCache();
  } catch (error) {
    // Non-fatal: cache directory may not exist yet
    log.debug("Could not clear response cache", error);
  }
}

/** Log out of every stored account and clear identity-scoped caches. */
export async function clearAuth(): Promise<void> {
  withDbSpan("clearAuth", () => {
    const db = getDatabase();
    db.query("DELETE FROM accounts").run();
    // Also clear the org region cache, pagination cursors, and the
    // issue-id → org cache (scoped to the logged-out users' permissions).
    db.query("DELETE FROM org_regions").run();
    clearUnscopedIdentityCaches();
  });
  resetActiveCredentialState();
  await clearResponseCacheBestEffort();
}

/** The active stored account's id, or `undefined` when none is active. */
export function getActiveAccountId(): string | undefined {
  return getActiveAccountRow()?.account_id;
}

/**
 * Make a stored account the active one. Subsequent commands use its
 * credentials. No-op when it is already active.
 *
 * @throws {ConfigError} when no stored account has this id
 */
export function setActiveAccount(accountId: string): void {
  withDbSpan("setActiveAccount", () => {
    if (!getAccountRow(accountId)) {
      throw new ConfigError(`No stored account with id '${accountId}'.`);
    }
    if (getActiveAccountRow()?.account_id === accountId) {
      return;
    }
    backfillActiveNullHost();
    activateAccountRow(accountId);
    backfillActiveNullHost();
    clearUnscopedIdentityCaches();
  });
  resetActiveCredentialState();
}

/**
 * Remove one stored account. Removing the active account leaves no account
 * active unless `promoteNext` is set, in which case the most recently
 * used remaining account becomes active.
 *
 * @returns the id of the account that is active afterwards, if any
 */
export async function removeAccount(
  accountId: string,
  options: { promoteNext?: boolean } = {},
): Promise<string | undefined> {
  const nextActive = withDbSpan("removeAccount", () => {
    const row = getAccountRow(accountId);
    if (!row) {
      return getActiveAccountRow()?.account_id;
    }
    deleteAccountRows([row]);
    if (row.is_active !== 1) {
      return getActiveAccountRow()?.account_id;
    }
    clearUnscopedIdentityCaches();
    if (!options.promoteNext) {
      return;
    }
    const next = getMostRecentAccountRow();
    if (next) {
      activateAccountRow(next.account_id);
      backfillActiveNullHost();
    }
    return next?.account_id;
  });
  resetActiveCredentialState();
  await clearResponseCacheBestEffort();
  return nextActive;
}

/**
 * Drop an account's rejected or expired credentials while keeping the
 * account (and its active state) so the user can see it and log in again.
 * Never promotes another account: a request must not silently continue
 * under a different identity.
 */
async function invalidateAccountCredentials(accountId: string): Promise<void> {
  withDbSpan("invalidateAccountCredentials", () => {
    const row = getAccountRow(accountId);
    if (!row) {
      return;
    }
    const db = getDatabase();
    deleteAccountOrgRegions(row);
    db.query(
      "UPDATE accounts SET token = NULL, refresh_token = NULL, expires_at = NULL, issued_at = NULL, updated_at = ? WHERE account_id = ?",
    ).run(Date.now(), accountId);
    clearUnscopedIdentityCaches();
  });
  resetActiveCredentialState();
  await clearResponseCacheBestEffort();
}

/**
 * Point the invocation's server at its newly chosen default account, but only when
 * no server was chosen explicitly: an unset URL or the persisted default
 * (`defaults.url`, applied at startup) yields to the account's own host.
 */
function followDefaultAccountHost(host: string): void {
  const configured = getConfiguredUrlOrUndefined();
  if (configured && !isPersistedDefaultUrlInEffect()) {
    return;
  }
  if (isSameServer(configured ?? DEFAULT_SENTRY_URL, host)) {
    return;
  }
  getEnv().SENTRY_URL = host;
  markPersistedDefaultUrl(host);
}

/**
 * Use the stored account that knows `orgSlug` (or numeric `orgId`) for the
 * rest of this invocation, so commands targeting another login's
 * organization work without `sentry auth switch`.
 *
 * No-op when the effective account knows the org or has no cached org
 * list to rule it out, when no stored account knows it, or when an earlier
 * org already chose the invocation's default account — one invocation
 * never mixes identities. An explicit server (`SENTRY_HOST`/`SENTRY_URL`,
 * `--url`, `.sentryclirc`) limits candidates to accounts on it; when several
 * accounts qualify, the most recently used wins. Forced env tokens (`SENTRY_FORCE_ENV_TOKEN`) are never overridden.
 */
export function selectAccountForOrg(orgSlug: string, orgId?: string): void {
  if (getEnv().SENTRY_FORCE_ENV_TOKEN?.trim() && getRawEnvToken()) {
    return;
  }
  const scope = getAccountScope();
  if (scope.accountId) {
    return;
  }
  try {
    // Usable accounts that know the org, most recently used first.
    const owners = listUsableAccountRowsForOrg(orgSlug, orgId);
    if (owners.length === 0) {
      return;
    }
    const current = getAuthRow();
    // Respect the account in effect unless its fresh cached org list shows
    // it is not a member: after `sentry auth switch`, an account that simply
    // hasn't used the org yet must not be overridden by one that has. Uses
    // the same TTL as `getCachedOrganizations`. An account that can no
    // longer authenticate (credentials invalidated or expired) is never
    // kept over an owner that can.
    if (
      current &&
      (owners.some((o) => o.account_id === current.account_id) ||
        (isAccountRowUsable(current) &&
          !hasCachedOrgList(current.account_id, Date.now() - ORG_CACHE_TTL_MS)))
    ) {
      return;
    }
    const configured = getConfiguredUrlOrUndefined();
    const explicitHost =
      configured && !isPersistedDefaultUrlInEffect() ? configured : undefined;
    const candidates = explicitHost
      ? owners.filter((o) => o.host && isSameServer(o.host, explicitHost))
      : owners;
    const pick = candidates[0];
    if (!pick?.host) {
      return;
    }
    scope.accountId = pick.account_id;
    followDefaultAccountHost(pick.host);
    log.debug(
      `Using stored account ${pick.account_id} (${pick.host}) for organization '${orgSlug}'`,
    );
  } catch (error) {
    // Best-effort: the active account stays in effect.
    log.debug("Could not select an account for the organization", error);
  }
}

/**
 * The stored account whose credentials hash to `identity` (following
 * in-process refresh-token rotations), so cached org data can record which
 * account it belongs to. `undefined` for env tokens and unknown identities.
 */
export function getAccountIdForIdentity(identity: string): string | undefined {
  try {
    const match = listAccountRows().find((row) => {
      const rowIdentity = accountIdentity(row);
      if (!rowIdentity) {
        return false;
      }
      if (rowIdentity === identity) {
        return true;
      }
      const host = row.host ? normalizeHttpOrigin(row.host) : undefined;
      return (
        host !== undefined &&
        matchesRefreshIdentity(host, identity, rowIdentity)
      );
    });
    return match?.account_id;
  } catch (error) {
    // The mapping is an optimization; a miss just skips recording it.
    log.debug("Could not map credential identity to an account", error);
    return;
  }
}

/**
 * Whether a usable stored account is on `url`'s server. Lets a pasted
 * Sentry URL for another login's server select that login instead of
 * failing the host check against the active account.
 */
/**
 * Host of the stored account in effect, ignoring env-var tokens (reading an
 * env token's host would snapshot it). `undefined` when no stored account
 * is in effect, its host is not recorded yet, or the store can't be read.
 */
export function getEffectiveStoredAccountHost(): string | undefined {
  try {
    return getAuthRow()?.host ?? undefined;
  } catch (error) {
    log.debug("Could not read stored accounts", error);
    return;
  }
}

export function hasStoredAccountForHost(url: string): boolean {
  try {
    return listUsableAccountRowsByRecency().some(
      (row) => row.host && isSameServer(row.host, url),
    );
  } catch (error) {
    log.debug("Could not read stored accounts", error);
    return false;
  }
}

export function isAuthenticated(): boolean {
  const token = getAuthToken();
  return !!token;
}

/** Fingerprint returned when no token is present (logged out, no env var). */
export const ANON_IDENTITY = "<anon>";

/**
 * Opaque fingerprint of the active bearer identity, used to namespace
 * response-cache keys so entries never leak across accounts. Mirrors
 * `getAuthConfig` precedence: forced env token > stored OAuth
 * (refresh_token preferred for stability across access-token rotation,
 * falling through expired access-only rows) > env token > anonymous.
 *
 * Memoized. Reset on every mutation point (`setAuthToken`,
 * `clearAuth`), so both the common case (OAuth access-token refresh
 * with a stable refresh_token — fingerprint unchanged in practice)
 * and the uncommon case (server-rotated refresh_token — fingerprint
 * changes, cache naturally re-populates under the new identity) work
 * correctly. Tests that mutate auth state between cases call
 * {@link resetIdentityFingerprintCache}.
 */
export function getIdentityFingerprint(): string {
  const memo = memoFor(authCacheState.fingerprints);
  const key = selectionKey();
  const cached = memo.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const fingerprint = computeIdentityFingerprint();
  memo.set(key, fingerprint);
  return fingerprint;
}

/** Reset the memoized fingerprint. Tests only — call between auth-state mutations. */
export function resetIdentityFingerprintCache(): void {
  authCacheState.fingerprints = new WeakMap();
}

function computeIdentityFingerprint(): string {
  // Forced env-token: matches what `refreshToken()` will actually send.
  if (getEnv().SENTRY_FORCE_ENV_TOKEN?.trim()) {
    const envToken = getRawEnvToken();
    if (envToken) {
      return hashIdentity("env", envToken);
    }
  }

  const row = withDbSpan("getIdentityFingerprint", getAuthRow);
  // Prefer refresh_token: stable across access-token rotation.
  if (row?.refresh_token) {
    return hashIdentity("oauth", row.refresh_token);
  }
  // Access-only row: skip if expired (mirrors getAuthConfig).
  if (row?.token && !(row.expires_at && Date.now() > row.expires_at)) {
    return hashIdentity("oauth-access", row.token);
  }

  const envToken = getRawEnvToken();
  if (envToken) {
    return hashIdentity("env", envToken);
  }
  return ANON_IDENTITY;
}

/** Immutable token, host, and namespace captured from one auth state. */
export type CredentialContext = Readonly<{
  token: string;
  host: string;
  identity: string;
  source: AuthSource;
  refreshable: boolean;
  expiresAt?: number;
  issuedAt?: number;
}>;

function envCredentialContext(): CredentialContext | undefined {
  const token = getEnvToken();
  if (!token) {
    return;
  }
  return Object.freeze({
    token: token.token,
    host: getEnvTokenHost(),
    identity: hashIdentity("env", token.token),
    source: token.source,
    refreshable: false,
  });
}

export function getCredentialContext(): CredentialContext | undefined {
  if (getEnv().SENTRY_FORCE_ENV_TOKEN?.trim()) {
    const forced = envCredentialContext();
    if (forced) {
      return forced;
    }
  }
  const row = withDbSpan("getCredentialContext", getAuthRow);
  if (
    row?.token &&
    (!row.expires_at || Date.now() <= row.expires_at || row.refresh_token)
  ) {
    const host = row.host ?? migrateNullHost(row);
    const origin = normalizeHttpOrigin(host);
    if (!origin) {
      throw new ConfigError(
        "Stored credential host must be a credential-free HTTP(S) URL.",
      );
    }
    return Object.freeze({
      token: row.token,
      host: origin,
      identity: row.refresh_token
        ? hashIdentity("oauth", row.refresh_token)
        : hashIdentity("oauth-access", row.token),
      source: "oauth",
      refreshable: Boolean(row.refresh_token),
      ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
      ...(row.issued_at ? { issuedAt: row.issued_at } : {}),
    });
  }
  return envCredentialContext();
}

export function getActiveAuthHost(): string | undefined {
  return getCredentialContext()?.host;
}

/**
 * Check if usable OAuth credentials are stored in the database.
 *
 * Returns true when the `auth` table has either:
 * - A non-expired token, or
 * - An expired token with a refresh token (will be refreshed on next use)
 *
 * Memoized within the process. Reset on {@link setAuthToken} and
 * {@link clearAuth} mutations. Tests call {@link resetHasStoredCredsCache}
 * between cases.
 *
 * Used by the login command to decide whether to prompt for re-authentication
 * when an env token is present.
 */
export function hasStoredAuthCredentials(): boolean {
  const key = selectionKey();
  const cached = cachedHasStoredCreds.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const row = getAuthRow();
  let result = false;
  if (row?.token) {
    // Non-expired token
    if (!row.expires_at || Date.now() <= row.expires_at) {
      result = true;
    } else {
      // Expired but has refresh token — will be refreshed on next use
      result = !!row.refresh_token;
    }
  }
  cachedHasStoredCreds.set(key, result);
  return result;
}

export type RefreshTokenOptions = {
  /** Bypass threshold check and always refresh */
  force?: boolean;
  expectedCredential?: Pick<CredentialContext, "host" | "identity">;
};

export type RefreshTokenResult = {
  token: string;
  refreshed: boolean;
  host: string;
  identity: string;
  source: AuthSource;
  refreshable: boolean;
  expiresAt?: number;
  expiresIn?: number;
};

type StoredCredentialSnapshot = {
  accountId: string;
  token: string;
  refreshToken: string;
  expiresAt: number | null;
  issuedAt: number | null;
  updatedAt: number;
  host: string;
  identity: string;
};

const refreshPromises = new Map<string, Promise<RefreshTokenResult>>();
// Only successful rotations can link a pinned in-flight request to the next
// refresh-token identity. A new login or logout clears every link.
const refreshIdentityAliases = new Map<string, string>();
const MAX_REFRESH_IDENTITY_ALIASES = 128;

function rememberRefreshIdentity(
  host: string,
  previous: string,
  next: string,
): void {
  if (previous === next) {
    return;
  }
  refreshIdentityAliases.set(`${host}\0${previous}`, next);
  if (refreshIdentityAliases.size > MAX_REFRESH_IDENTITY_ALIASES) {
    const oldest = refreshIdentityAliases.keys().next().value;
    if (oldest !== undefined) {
      refreshIdentityAliases.delete(oldest);
    }
  }
}

function matchesRefreshIdentity(
  host: string,
  previous: string,
  current: string,
): boolean {
  const seen = new Set<string>();
  const start = `${host}\0${previous}`;
  for (let key = start; !seen.has(key);) {
    seen.add(key);
    const next = refreshIdentityAliases.get(key);
    if (!next) {
      return false;
    }
    if (next === current) {
      return true;
    }
    key = `${host}\0${next}`;
  }
  return false;
}

function rowMatchesCredential(
  row: AuthRow | undefined,
  credential: StoredCredentialSnapshot,
): boolean {
  return (
    row?.account_id === credential.accountId &&
    row.token === credential.token &&
    row.refresh_token === credential.refreshToken &&
    row.expires_at === credential.expiresAt &&
    row.issued_at === credential.issuedAt &&
    row.updated_at === credential.updatedAt &&
    row.host === credential.host
  );
}

function assertExpectedCredential(
  result: Pick<RefreshTokenResult, "host" | "identity">,
  expected: RefreshTokenOptions["expectedCredential"],
): void {
  if (
    expected &&
    (result.host !== expected.host ||
      (result.identity !== expected.identity &&
        !matchesRefreshIdentity(
          result.host,
          expected.identity,
          result.identity,
        )))
  ) {
    throw new ConfigError(
      "Active credentials changed while the request was in flight. Retry the request.",
    );
  }
}

function persistRefreshedCredential(
  credential: StoredCredentialSnapshot,
  token: string,
  nextRefreshToken: string,
  expiresIn: number,
): boolean {
  const saved = withDbSpan("persistRefreshedCredential", () => {
    const db = getDatabase();
    return db.transaction(() => {
      // Match by account id (not "active"): a concurrent `auth switch`
      // must not redirect this refresh onto another account's row.
      if (
        !rowMatchesCredential(getAccountRow(credential.accountId), credential)
      ) {
        return false;
      }
      const now = Date.now();
      db.query(
        "UPDATE accounts SET token = ?, refresh_token = ?, expires_at = ?, issued_at = ?, updated_at = ?, host = ? WHERE account_id = ?",
      ).run(
        token,
        nextRefreshToken,
        now + expiresIn * 1000,
        now,
        now,
        credential.host,
        credential.accountId,
      );
      return true;
    })();
  });
  if (saved) {
    resetIdentityFingerprintCache();
    resetAuthTokenCache();
    resetAuthRowCache();
    resetHasStoredCredsCache();
  }
  return saved;
}

async function performTokenRefresh(
  credential: StoredCredentialSnapshot,
): Promise<RefreshTokenResult> {
  const { refreshAccessToken } = await import("../oauth.js");
  const { AuthError } = await import("../errors.js");

  let tokenResponse: Awaited<ReturnType<typeof refreshAccessToken>>;
  try {
    tokenResponse = await refreshAccessToken(credential.refreshToken, {
      credentialHost: credential.host,
    });
  } catch (error) {
    // Only clear auth on explicit rejection, not network errors
    if (
      error instanceof AuthError &&
      rowMatchesCredential(getAccountRow(credential.accountId), credential)
    ) {
      await invalidateAccountCredentials(credential.accountId);
    }
    throw error;
  }

  // Validate before SQLite can truncate NUL-containing credentials or replace
  // the stored credentials with a malformed response. Leave those values unchanged.
  const token = normalizeAuthToken(tokenResponse.access_token);
  const nextRefreshToken =
    tokenResponse.refresh_token ?? credential.refreshToken;
  const now = Date.now();
  const expiresAt = now + tokenResponse.expires_in * 1000;

  if (
    !persistRefreshedCredential(
      credential,
      token,
      nextRefreshToken,
      tokenResponse.expires_in,
    )
  ) {
    throw new ConfigError(
      "Active credentials changed while the request was in flight. Retry the request.",
    );
  }

  const identity = hashIdentity("oauth", nextRefreshToken);
  rememberRefreshIdentity(credential.host, credential.identity, identity);

  return {
    token,
    refreshed: true,
    host: credential.host,
    identity,
    source: "oauth",
    refreshable: true,
    expiresAt,
    expiresIn: tokenResponse.expires_in,
  };
}

function getEnvRefreshResult(
  expected: RefreshTokenOptions["expectedCredential"],
): RefreshTokenResult | undefined {
  const credential = envCredentialContext();
  if (!credential) {
    return;
  }
  assertExpectedCredential(credential, expected);
  return { ...credential, refreshed: false };
}

async function refreshStoredCredential(
  credential: StoredCredentialSnapshot,
): Promise<RefreshTokenResult> {
  const key = `${credential.identity}\0${credential.host}\0${hashIdentity("oauth-access", credential.token)}\0${credential.updatedAt}`;
  const existing = refreshPromises.get(key);
  if (existing) {
    return await existing;
  }
  const pending = performTokenRefresh(credential);
  refreshPromises.set(key, pending);
  try {
    return await pending;
  } finally {
    if (refreshPromises.get(key) === pending) {
      refreshPromises.delete(key);
    }
  }
}

/** Get a valid token, refreshing if needed. Use force=true after 401 responses. */
export async function refreshToken(
  options: RefreshTokenOptions = {},
): Promise<RefreshTokenResult> {
  // With SENTRY_FORCE_ENV_TOKEN, env token takes priority (no refresh needed).
  const forced = getEnv().SENTRY_FORCE_ENV_TOKEN?.trim()
    ? getEnvRefreshResult(options.expectedCredential)
    : undefined;
  if (forced) {
    return forced;
  }

  const { force = false } = options;
  const { AuthError } = await import("../errors.js");

  const row = getCachedAuthRow();

  if (!row?.token) {
    // No stored token — try env token as fallback
    const fallback = getEnvRefreshResult(options.expectedCredential);
    if (fallback) {
      return fallback;
    }
    throw new AuthError("not_authenticated");
  }

  const now = Date.now();
  const expiresAt = row.expires_at;
  const host = row.host ?? migrateNullHost(row);
  const origin = normalizeHttpOrigin(host);
  if (!origin) {
    throw new ConfigError(
      "Stored credential host must be a credential-free HTTP(S) URL.",
    );
  }
  const identity = row.refresh_token
    ? hashIdentity("oauth", row.refresh_token)
    : hashIdentity("oauth-access", row.token);
  const baseResult = {
    host: origin,
    identity,
    source: "oauth" as const,
    refreshable: Boolean(row.refresh_token),
  };
  assertExpectedCredential(baseResult, options.expectedCredential);

  if (!expiresAt) {
    return { ...baseResult, token: row.token, refreshed: false };
  }

  const issuedAt = row.issued_at ?? expiresAt - DEFAULT_TOKEN_LIFETIME_MS;
  const totalLifetime = expiresAt - issuedAt;
  const remainingLifetime = expiresAt - now;
  const remainingRatio = remainingLifetime / totalLifetime;
  const expiresIn = Math.max(0, Math.floor(remainingLifetime / 1000));

  if (!force && remainingRatio > REFRESH_THRESHOLD && now < expiresAt) {
    return {
      ...baseResult,
      token: row.token,
      refreshed: false,
      expiresAt,
      expiresIn,
    };
  }

  if (!row.refresh_token) {
    await invalidateAccountCredentials(row.account_id);
    // Fall back to env token if available (consistent with getAuthToken/getAuthConfig)
    const fallback = getEnvRefreshResult(options.expectedCredential);
    if (fallback) {
      return fallback;
    }
    throw new AuthError(
      "expired",
      "Session expired and no refresh token available. Run 'sentry auth login'.",
    );
  }

  const credential: StoredCredentialSnapshot = {
    accountId: row.account_id,
    token: row.token,
    refreshToken: row.refresh_token,
    expiresAt: row.expires_at,
    issuedAt: row.issued_at,
    updatedAt: row.updated_at,
    host: origin,
    identity,
  };
  return await refreshStoredCredential(credential);
}
