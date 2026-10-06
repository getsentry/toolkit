/**
 * Authentication credential storage (single-row table pattern).
 */

import { createHash } from "node:crypto";
import { normalizeAuthToken, trimAuthToken } from "../auth-header.js";
import { DEFAULT_SENTRY_URL, getConfiguredSentryUrl } from "../constants.js";
import { getEnv } from "../env.js";
import {
  getBootConfiguredSentryUrl,
  getEnvTokenHost,
} from "../env-token-host.js";
import { ConfigError } from "../errors.js";
import { logger } from "../logger.js";
import { normalizeHttpOrigin } from "../sentry-urls.js";
import { withDbSpan } from "../telemetry.js";
import { getDatabase } from "./index.js";
import { clearAllIssueOrgCache } from "./issue-org-cache.js";
import { clearTrustedHostState } from "./regions.js";
import { runUpsert } from "./utils.js";

/** Refresh when less than 10% of token lifetime remains */
export const REFRESH_THRESHOLD = 0.1;

/** Default token lifetime (1 hour) for tokens without issuedAt */
export const DEFAULT_TOKEN_LIFETIME_MS = 3600 * 1000;

type AuthRow = {
  token: string | null;
  refresh_token: string | null;
  expires_at: number | null;
  issued_at: number | null;
  updated_at: number;
  /**
   * Origin URL the token was issued against (e.g., `https://sentry.io` or
   * `https://sentry.example.com`). NULL for rows written before schema v16;
   * lazily migrated by `migrateNullHostIfPresent` on first access.
   */
  host: string | null;
};

const log = logger.withTag("auth");

/** Read the single auth row. Returns `undefined` when no row exists. */
function getAuthRow(): AuthRow | undefined {
  const db = getDatabase();
  return db.query("SELECT * FROM auth WHERE id = 1").get() as
    | AuthRow
    | undefined;
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
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    withDbSpan("migrateAuthHost", () => {
      const db = getDatabase();
      db.query("UPDATE auth SET host = ? WHERE id = 1").run(host);
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

function normalizeCredentialHost(host: string): string {
  const origin = normalizeHttpOrigin(host);
  if (!origin) {
    throw new ConfigError(
      "Stored credential host must be a credential-free HTTP(S) URL."
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
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
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
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
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
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
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
  tokens: new WeakMap<NodeJS.ProcessEnv, { value: string | undefined }>(),
  fingerprints: new WeakMap<NodeJS.ProcessEnv, string>(),
};

/**
 * Get the active auth token.
 *
 * Default: checks the DB first (stored OAuth wins), then falls back to env vars.
 * With `SENTRY_FORCE_ENV_TOKEN=1`: checks env vars first (old behavior).
 */
export function getAuthToken(): string | undefined {
  const env = getEnv();
  const cached = authCacheState.tokens.get(env);
  if (cached !== undefined) {
    return cached.value;
  }
  const value = computeAuthToken();
  authCacheState.tokens.set(env, { value });
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

/** Memoized result for {@link hasStoredAuthCredentials}. */
let cachedHasStoredCreds: { value: boolean } | undefined;

/** Memoized full auth row for {@link refreshToken}. */
let cachedAuthRow: { value: AuthRow | undefined } | undefined;

function getCachedAuthRow(): AuthRow | undefined {
  if (cachedAuthRow !== undefined) {
    return cachedAuthRow.value;
  }
  const row = getAuthRow();
  cachedAuthRow = { value: row };
  return row;
}

/** Reset the memoized auth row. Tests only — call between auth-state mutations. */
export function resetAuthRowCache(): void {
  cachedAuthRow = undefined;
}

/** Reset the memoized stored-credentials flag. Tests only — call between auth-state mutations. */
export function resetHasStoredCredsCache(): void {
  cachedHasStoredCreds = undefined;
}

/**
 * Options for persisting a token.
 *
 * @property host - Origin URL the token was issued against. When omitted on
 *   an update (e.g., access-token refresh), the existing row's host is
 *   preserved. When omitted on a fresh write, defaults to the
 *   currently-configured host (`SENTRY_HOST`/`SENTRY_URL`) or `DEFAULT_SENTRY_URL`.
 */
export type SetAuthTokenOptions = {
  host?: string;
};

/** Normalize an access token before storage; malformed input leaves the auth row unchanged. */
export function setAuthToken(
  token: string,
  expiresIn?: number,
  newRefreshToken?: string,
  options?: SetAuthTokenOptions
): void {
  const normalizedToken = normalizeAuthToken(token);
  withDbSpan("setAuthToken", () => {
    const db = getDatabase();
    const now = Date.now();
    const expiresAt = expiresIn ? now + expiresIn * 1000 : null;
    const issuedAt = expiresIn ? now : null;

    // Host resolution precedence:
    //   1. Explicit `options.host` (login command, tests)
    //   2. Existing row's `host` (refresh flow preserves the original scope)
    //   3. Currently-configured host (getConfiguredSentryUrl)
    //   4. SaaS default
    // Always normalized to scheme+host[+port].
    const existingHost = (
      db.query("SELECT host FROM auth WHERE id = 1").get() as
        | { host: string | null }
        | undefined
    )?.host;
    const rawHost =
      options?.host ??
      existingHost ??
      getConfiguredSentryUrl() ??
      DEFAULT_SENTRY_URL;
    const host = normalizeCredentialHost(rawHost);

    runUpsert(
      db,
      "auth",
      {
        id: 1,
        token: normalizedToken,
        refresh_token: newRefreshToken ?? null,
        expires_at: expiresAt,
        issued_at: issuedAt,
        updated_at: now,
        host,
      },
      ["id"]
    );
  });
  // Auth row changed — drop memoized fingerprint, token, row, and
  // stored-credentials flag so the next read reflects the new row.
  resetIdentityFingerprintCache();
  refreshIdentityAliases.clear();
  resetAuthTokenCache();
  resetAuthRowCache();
  resetHasStoredCredsCache();
}

export async function clearAuth(): Promise<void> {
  withDbSpan("clearAuth", () => {
    const db = getDatabase();
    db.query("DELETE FROM auth WHERE id = 1").run();
    // Also clear user info, org region cache, pagination cursors, and the
    // issue-id → org cache (scoped to the current user's permissions) when
    // logging out.
    db.query("DELETE FROM user_info WHERE id = 1").run();
    db.query("DELETE FROM org_regions").run();
    db.query("DELETE FROM pagination_cursors").run();
    clearAllIssueOrgCache();
  });
  resetIdentityFingerprintCache();
  refreshIdentityAliases.clear();
  resetAuthTokenCache();
  resetAuthRowCache();
  resetHasStoredCredsCache();
  // Evict in-process trust extensions tied to the now-cleared identity.
  clearTrustedHostState();

  // Dynamic import avoids the auth→response-cache→auth cycle.
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const { clearResponseCache } = await import("../response-cache.js");
    await clearResponseCache();
  } catch {
    // Non-fatal: cache directory may not exist yet
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
  const env = getEnv();
  const cached = authCacheState.fingerprints.get(env);
  if (cached !== undefined) {
    return cached;
  }
  const fingerprint = computeIdentityFingerprint();
  authCacheState.fingerprints.set(env, fingerprint);
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

  const row = withDbSpan("getIdentityFingerprint", () => {
    const db = getDatabase();
    return db
      .query("SELECT token, refresh_token, expires_at FROM auth WHERE id = 1")
      .get() as
      | {
          token: string | null;
          refresh_token: string | null;
          expires_at: number | null;
        }
      | undefined;
  });
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

/**
 * Stable SHA-256 namespace for high-entropy OAuth and organization tokens.
 * A collision would mix credentials' cached responses, so retain the full
 * digest. This fingerprint is never a password verifier or a bearer token.
 */
function hashIdentity(kind: string, secret: string): string {
  return createHash("sha256")
    .update(kind)
    .update("\0")
    .update(secret)
    .digest("hex");
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
        "Stored credential host must be a credential-free HTTP(S) URL."
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
  if (cachedHasStoredCreds !== undefined) {
    return cachedHasStoredCreds.value;
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
  cachedHasStoredCreds = { value: result };
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
  next: string
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
  current: string
): boolean {
  const seen = new Set<string>();
  const start = `${host}\0${previous}`;
  for (let key = start; !seen.has(key); ) {
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
  credential: StoredCredentialSnapshot
): boolean {
  return (
    row?.token === credential.token &&
    row.refresh_token === credential.refreshToken &&
    row.expires_at === credential.expiresAt &&
    row.issued_at === credential.issuedAt &&
    row.updated_at === credential.updatedAt &&
    row.host === credential.host
  );
}

function assertExpectedCredential(
  result: Pick<RefreshTokenResult, "host" | "identity">,
  expected: RefreshTokenOptions["expectedCredential"]
): void {
  if (
    expected &&
    (result.host !== expected.host ||
      (result.identity !== expected.identity &&
        !matchesRefreshIdentity(
          result.host,
          expected.identity,
          result.identity
        )))
  ) {
    throw new ConfigError(
      "Active credentials changed while the request was in flight. Retry the request."
    );
  }
}

function persistRefreshedCredential(
  credential: StoredCredentialSnapshot,
  token: string,
  nextRefreshToken: string,
  expiresIn: number
): boolean {
  const saved = withDbSpan("persistRefreshedCredential", () => {
    const db = getDatabase();
    return db.transaction(() => {
      if (!rowMatchesCredential(getAuthRow(), credential)) {
        return false;
      }
      const now = Date.now();
      db.query(
        "UPDATE auth SET token = ?, refresh_token = ?, expires_at = ?, issued_at = ?, updated_at = ?, host = ? WHERE id = 1"
      ).run(
        token,
        nextRefreshToken,
        now + expiresIn * 1000,
        now,
        now,
        credential.host
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
  credential: StoredCredentialSnapshot
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
      rowMatchesCredential(getAuthRow(), credential)
    ) {
      await clearAuth();
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
      tokenResponse.expires_in
    )
  ) {
    throw new ConfigError(
      "Active credentials changed while the request was in flight. Retry the request."
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
  expected: RefreshTokenOptions["expectedCredential"]
): RefreshTokenResult | undefined {
  const credential = envCredentialContext();
  if (!credential) {
    return;
  }
  assertExpectedCredential(credential, expected);
  return { ...credential, refreshed: false };
}

async function refreshStoredCredential(
  credential: StoredCredentialSnapshot
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
  options: RefreshTokenOptions = {}
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
      "Stored credential host must be a credential-free HTTP(S) URL."
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
    await clearAuth();
    // Fall back to env token if available (consistent with getAuthToken/getAuthConfig)
    const fallback = getEnvRefreshResult(options.expectedCredential);
    if (fallback) {
      return fallback;
    }
    throw new AuthError(
      "expired",
      "Session expired and no refresh token available. Run 'sentry auth login'."
    );
  }

  const credential: StoredCredentialSnapshot = {
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
