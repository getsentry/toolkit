/**
 * Authentication credential storage (single-row table pattern).
 */

import { createHash } from "node:crypto";
import { normalizeAuthToken, trimAuthToken } from "../auth-header.js";
import { DEFAULT_SENTRY_URL, getConfiguredSentryUrl } from "../constants.js";
import { getEnv } from "../env.js";
import { getEnvTokenHost } from "../env-token-host.js";
import { logger } from "../logger.js";
import { normalizeOrigin } from "../sentry-urls.js";
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
 * Uses the BOOT-TIME env snapshot (`getEnvTokenHost`), captured before the
 * `.sentryclirc` shim could mutate env. Reading the current env directly
 * would either default self-hosted users to SaaS (when the shim hasn't run
 * yet) or migrate to a poisoned rc URL (when it has).
 *
 * Users whose shell env was wrong at upgrade time can recover with
 * `sentry auth logout && sentry auth login`. Returns the migrated host
 * (never NULL on return).
 */
function migrateNullHost(row: AuthRow): string {
  const bootHost = getEnvTokenHost();
  const migratedHost = normalizeOrigin(bootHost);
  const host = migratedHost ?? DEFAULT_SENTRY_URL;
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

/** Memoized token. Wrapper distinguishes "not cached" from "cached as undefined". */
let cachedAuthToken: { value: string | undefined } | undefined;

/**
 * Get the active auth token.
 *
 * Default: checks the DB first (stored OAuth wins), then falls back to env vars.
 * With `SENTRY_FORCE_ENV_TOKEN=1`: checks env vars first (old behavior).
 */
export function getAuthToken(): string | undefined {
  if (cachedAuthToken !== undefined) {
    return cachedAuthToken.value;
  }
  const value = computeAuthToken();
  cachedAuthToken = { value };
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
  cachedAuthToken = undefined;
}

/** Memoized result for {@link hasStoredAuthCredentials}. Same wrapper contract as {@link cachedAuthToken}. */
let cachedHasStoredCreds: { value: boolean } | undefined;

/** Memoized full auth row for {@link refreshToken}. Same wrapper contract as {@link cachedAuthToken}. */
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
    // Always normalized to scheme+host[+port] via normalizeOrigin.
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
    const host = normalizeOrigin(rawHost) ?? DEFAULT_SENTRY_URL;

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

/** Memoized fingerprint. Identity doesn't change within a single CLI run. */
let cachedFingerprint: string | undefined;

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
  if (cachedFingerprint === undefined) {
    cachedFingerprint = computeIdentityFingerprint();
  }
  return cachedFingerprint;
}

/** Reset the memoized fingerprint. Tests only — call between auth-state mutations. */
export function resetIdentityFingerprintCache(): void {
  cachedFingerprint = undefined;
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
 * 16-char MD5 hex of `kind|secret`. Not used for auth — just a cheap
 * cache namespace. Collisions are benign (identities would share a
 * cache slot, same as the anonymous case).
 */
function hashIdentity(kind: string, secret: string): string {
  return createHash("md5")
    .update(`${kind}|${secret}`)
    .digest("hex")
    .slice(0, 16);
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
};

export type RefreshTokenResult = {
  token: string;
  refreshed: boolean;
  expiresAt?: number;
  expiresIn?: number;
};

let refreshPromise: Promise<RefreshTokenResult> | null = null;

async function performTokenRefresh(
  storedRefreshToken: string
): Promise<RefreshTokenResult> {
  const { refreshAccessToken } = await import("../oauth.js");
  const { AuthError } = await import("../errors.js");

  let tokenResponse: Awaited<ReturnType<typeof refreshAccessToken>>;
  try {
    tokenResponse = await refreshAccessToken(storedRefreshToken);
  } catch (error) {
    // Only clear auth on explicit rejection, not network errors
    if (error instanceof AuthError) {
      await clearAuth();
    }
    throw error;
  }

  // Validate before SQLite can truncate NUL-containing credentials or replace
  // the stored credentials with a malformed response. Leave those values unchanged.
  const token = normalizeAuthToken(tokenResponse.access_token);
  const now = Date.now();
  const expiresAt = now + tokenResponse.expires_in * 1000;

  await setAuthToken(
    token,
    tokenResponse.expires_in,
    tokenResponse.refresh_token ?? storedRefreshToken
  );

  return {
    token,
    refreshed: true,
    expiresAt,
    expiresIn: tokenResponse.expires_in,
  };
}

/** Get a valid token, refreshing if needed. Use force=true after 401 responses. */
export async function refreshToken(
  options: RefreshTokenOptions = {}
): Promise<RefreshTokenResult> {
  // With SENTRY_FORCE_ENV_TOKEN, env token takes priority (no refresh needed).
  const forceEnv = getEnv().SENTRY_FORCE_ENV_TOKEN?.trim();
  if (forceEnv) {
    const envToken = getEnvToken();
    if (envToken) {
      return { token: envToken.token, refreshed: false };
    }
  }

  const { force = false } = options;
  const { AuthError } = await import("../errors.js");

  const row = getCachedAuthRow();

  if (!row?.token) {
    // No stored token — try env token as fallback
    const envToken = getEnvToken();
    if (envToken) {
      return { token: envToken.token, refreshed: false };
    }
    throw new AuthError("not_authenticated");
  }

  const now = Date.now();
  const expiresAt = row.expires_at;

  if (!expiresAt) {
    return { token: row.token, refreshed: false };
  }

  const issuedAt = row.issued_at ?? expiresAt - DEFAULT_TOKEN_LIFETIME_MS;
  const totalLifetime = expiresAt - issuedAt;
  const remainingLifetime = expiresAt - now;
  const remainingRatio = remainingLifetime / totalLifetime;
  const expiresIn = Math.max(0, Math.floor(remainingLifetime / 1000));

  if (!force && remainingRatio > REFRESH_THRESHOLD && now < expiresAt) {
    return {
      token: row.token,
      refreshed: false,
      expiresAt,
      expiresIn,
    };
  }

  if (!row.refresh_token) {
    await clearAuth();
    // Fall back to env token if available (consistent with getAuthToken/getAuthConfig)
    const envToken = getEnvToken();
    if (envToken) {
      return { token: envToken.token, refreshed: false };
    }
    throw new AuthError(
      "expired",
      "Session expired and no refresh token available. Run 'sentry auth login'."
    );
  }

  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = performTokenRefresh(row.refresh_token);
  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}
