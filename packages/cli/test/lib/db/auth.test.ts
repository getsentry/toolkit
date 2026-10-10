/**
 * Auth Environment Variable Tests
 *
 * Note: Core invariants (priority, source tracking, refresh skip, isEnvTokenActive)
 * are tested via property-based tests in auth.property.test.ts. These tests focus on
 * edge cases (whitespace, empty strings), shape assertions, and functions not covered
 * by property tests (isAuthenticated, getActiveEnvVarName).
 */

import { describe, expect, test } from "vitest";
import {
  ANON_IDENTITY,
  clearAuth,
  getActiveEnvVarName,
  getAuthConfig,
  getAuthToken,
  getIdentityFingerprint,
  getRawEnvToken,
  hasStoredAuthCredentials,
  isAuthenticated,
  isEnvTokenActive,
  refreshToken,
  resetAuthTokenCache,
  resetHasStoredCredsCache,
  resetIdentityFingerprintCache,
  setAuthToken,
} from "../../../src/lib/db/auth.js";
import { getDatabase } from "../../../src/lib/db/index.js";
import { MalformedAuthTokenError } from "../../../src/lib/errors.js";
import { useEnvSandbox, useTestConfigDir } from "../../helpers.js";

useTestConfigDir("auth-env-");
useEnvSandbox(["SENTRY_AUTH_TOKEN", "SENTRY_TOKEN", "SENTRY_FORCE_ENV_TOKEN"]);

describe("env var auth: getAuthToken edge cases", () => {
  test("ignores empty SENTRY_AUTH_TOKEN", () => {
    process.env.SENTRY_AUTH_TOKEN = "";
    setAuthToken("stored_token");
    expect(getAuthToken()).toBe("stored_token");
  });

  test("ignores whitespace-only SENTRY_AUTH_TOKEN", () => {
    process.env.SENTRY_AUTH_TOKEN = "   ";
    setAuthToken("stored_token");
    expect(getAuthToken()).toBe("stored_token");
  });

  test("trims whitespace from env var", () => {
    process.env.SENTRY_AUTH_TOKEN = "  token_with_spaces  ";
    expect(getAuthToken()).toBe("token_with_spaces");
  });
});

describe("env var auth: getAuthConfig shape", () => {
  test("env config has no refreshToken or expiry", () => {
    process.env.SENTRY_AUTH_TOKEN = "test_token";
    const config = getAuthConfig();
    expect(config?.refreshToken).toBeUndefined();
    expect(config?.expiresAt).toBeUndefined();
    expect(config?.issuedAt).toBeUndefined();
  });
});

describe("env var auth: isAuthenticated", () => {
  test("returns true when env var is set", async () => {
    process.env.SENTRY_AUTH_TOKEN = "test_token";
    expect(isAuthenticated()).toBe(true);
  });

  test("returns false when nothing is set", async () => {
    expect(isAuthenticated()).toBe(false);
  });
});

describe("env var auth: isEnvTokenActive edge case", () => {
  test("returns false for empty env var", () => {
    process.env.SENTRY_AUTH_TOKEN = "";
    expect(isEnvTokenActive()).toBe(false);
  });
});

describe("env var auth: getActiveEnvVarName", () => {
  test("prefers SENTRY_AUTH_TOKEN when both are set", () => {
    process.env.SENTRY_AUTH_TOKEN = "primary";
    process.env.SENTRY_TOKEN = "secondary";
    expect(getActiveEnvVarName()).toBe("SENTRY_AUTH_TOKEN");
  });

  test("falls back to SENTRY_AUTH_TOKEN when no env var is set", () => {
    expect(getActiveEnvVarName()).toBe("SENTRY_AUTH_TOKEN");
  });
});

describe("env var auth: refreshToken edge cases", () => {
  test("env token used when no stored OAuth exists", async () => {
    process.env.SENTRY_AUTH_TOKEN = "env_token";
    const result = await refreshToken();
    expect(result.token).toBe("env_token");
    expect(result.refreshed).toBe(false);
  });

  test("stored OAuth preferred over env token", async () => {
    setAuthToken("stored_token", 3600);
    process.env.SENTRY_AUTH_TOKEN = "env_token";
    const result = await refreshToken();
    expect(result.token).toBe("stored_token");
    expect(result.refreshed).toBe(false);
  });

  test("SENTRY_FORCE_ENV_TOKEN overrides stored OAuth in refreshToken", async () => {
    setAuthToken("stored_token", 3600);
    process.env.SENTRY_AUTH_TOKEN = "env_token";
    try {
      process.env.SENTRY_FORCE_ENV_TOKEN = "1";
      const result = await refreshToken();
      expect(result.token).toBe("env_token");
      expect(result.refreshed).toBe(false);
    } finally {
      delete process.env.SENTRY_FORCE_ENV_TOKEN;
    }
  });

  test("has no expiresAt or expiresIn for env tokens", async () => {
    process.env.SENTRY_AUTH_TOKEN = "env_token";
    const result = await refreshToken();
    expect(result.expiresAt).toBeUndefined();
    expect(result.expiresIn).toBeUndefined();
  });
});

describe("env var auth: getRawEnvToken", () => {
  test.each(["SENTRY_AUTH_TOKEN", "SENTRY_TOKEN"] as const)(
    "shares normalization and source selection for %s",
    (source) => {
      process.env[source] = "\x01\u00a0synthetic-token\x7f";
      expect(getRawEnvToken()).toBe("synthetic-token");
      expect(getAuthToken()).toBe("synthetic-token");
      expect(getAuthConfig()).toMatchObject({
        token: "synthetic-token",
        source: `env:${source}`,
      });
      expect(getActiveEnvVarName()).toBe(source);
    },
  );

  test("keeps a control-only primary credential selected over the alias", () => {
    process.env.SENTRY_AUTH_TOKEN = "\x01\x7f";
    process.env.SENTRY_TOKEN = "secondary-token";
    expect(getRawEnvToken()).toBe("\x01\x7f");
    expect(getAuthConfig()).toMatchObject({
      token: "\x01\x7f",
      source: "env:SENTRY_AUTH_TOKEN",
    });
    expect(getActiveEnvVarName()).toBe("SENTRY_AUTH_TOKEN");
  });

  test("still selects the alias when the primary is only whitespace", () => {
    process.env.SENTRY_AUTH_TOKEN = " \t\n\u00a0";
    process.env.SENTRY_TOKEN = "\x01secondary-token\x7f";
    expect(getRawEnvToken()).toBe("secondary-token");
    expect(getActiveEnvVarName()).toBe("SENTRY_TOKEN");
  });

  test("returns undefined when no env var is set", () => {
    expect(getRawEnvToken()).toBeUndefined();
  });
});

describe("stored credential validation", () => {
  test("normalizes before SQLite can truncate surrounding NULs", () => {
    setAuthToken("\0\u00a0stored-token\x7f\0", 3600, "refresh-token");
    expect(getAuthConfig()).toMatchObject({
      token: "stored-token",
      refreshToken: "refresh-token",
    });
  });

  test.each(["prefix\0secret-tail", "prefix\nsecret-tail", "", "\x01\x7f"])(
    "rejects a malformed replacement without changing stored credentials %#",
    (token) => {
      setAuthToken("previous-token", 3600, "previous-refresh-token");
      const before = getDatabase().query("SELECT * FROM auth").get();
      expect(() => setAuthToken(token, 60, "new-refresh-token")).toThrow(
        MalformedAuthTokenError,
      );
      expect(getDatabase().query("SELECT * FROM auth").get()).toEqual(before);
      expect(getAuthToken()).toBe("previous-token");
    },
  );
});

describe("OAuth-preferred auth (#646)", () => {
  test("getAuthConfig prefers stored OAuth over env token", () => {
    setAuthToken("stored_oauth", 3600);
    process.env.SENTRY_AUTH_TOKEN = "env_token";
    const config = getAuthConfig();
    expect(config?.source).toBe("oauth");
    expect(config?.token).toBe("stored_oauth");
  });

  test("getAuthConfig falls back to env token when no stored OAuth", () => {
    process.env.SENTRY_AUTH_TOKEN = "env_token";
    const config = getAuthConfig();
    expect(config?.source).toBe("env:SENTRY_AUTH_TOKEN");
    expect(config?.token).toBe("env_token");
  });

  test("getAuthToken skips expired stored token and falls to env", () => {
    setAuthToken("expired_token", -1);
    process.env.SENTRY_AUTH_TOKEN = "env_token";
    expect(getAuthToken()).toBe("env_token");
  });

  test("SENTRY_FORCE_ENV_TOKEN makes getAuthConfig prefer env token", () => {
    setAuthToken("stored_oauth", 3600);
    process.env.SENTRY_AUTH_TOKEN = "env_token";
    try {
      process.env.SENTRY_FORCE_ENV_TOKEN = "1";
      const config = getAuthConfig();
      expect(config?.source).toBe("env:SENTRY_AUTH_TOKEN");
      expect(config?.token).toBe("env_token");
    } finally {
      delete process.env.SENTRY_FORCE_ENV_TOKEN;
    }
  });
});

describe("clearAuth: integration with per-account caches", () => {
  test("clearAuth drops issue_org_cache entries (prevents cross-account leakage)", async () => {
    const { setCachedIssueOrg, getCachedIssueOrg } =
      await import("../../../src/lib/db/issue-org-cache.js");

    // Seed a mapping as if a previous session resolved this issue.
    await setAuthToken("test-token");
    setCachedIssueOrg("12345", "previous-account-org");
    expect(getCachedIssueOrg("12345")).toBe("previous-account-org");

    await clearAuth();

    // Mapping must be gone — otherwise the next account would leak into
    // their `issue view` fallback routing.
    expect(getCachedIssueOrg("12345")).toBeUndefined();
  });
});

describe("getIdentityFingerprint", () => {
  test("returns the anonymous fingerprint when no token is present", () => {
    expect(getIdentityFingerprint()).toBe(ANON_IDENTITY);
  });

  test("returns a stable full SHA-256 fingerprint for a given env token", () => {
    process.env.SENTRY_AUTH_TOKEN = "sntrys_alice";
    const fp1 = getIdentityFingerprint();
    const fp2 = getIdentityFingerprint();
    expect(fp1).toMatch(/^[0-9a-f]{64}$/);
    expect(fp1).toBe(fp2);
  });

  test("different env tokens produce different fingerprints", () => {
    process.env.SENTRY_AUTH_TOKEN = "sntrys_alice";
    const aliceFp = getIdentityFingerprint();
    process.env.SENTRY_AUTH_TOKEN = "sntrys_bob";
    resetIdentityFingerprintCache();
    const bobFp = getIdentityFingerprint();
    expect(aliceFp).not.toBe(bobFp);
  });

  test("SENTRY_AUTH_TOKEN and SENTRY_TOKEN produce the same fingerprint", () => {
    // Same secret value → same fingerprint regardless of which env var
    // holds it (the variable name is not part of the identity).
    process.env.SENTRY_AUTH_TOKEN = "same_token";
    const authFp = getIdentityFingerprint();
    delete process.env.SENTRY_AUTH_TOKEN;
    process.env.SENTRY_TOKEN = "same_token";
    resetIdentityFingerprintCache();
    const legacyFp = getIdentityFingerprint();
    expect(authFp).toBe(legacyFp);
  });

  test("OAuth refresh token is the identity root (stable across access-token rotation)", () => {
    // Simulate two consecutive access tokens backed by the same refresh
    // token — an hourly OAuth refresh must not churn the cache.
    setAuthToken("access_token_1", 3600, "shared_refresh");
    const fp1 = getIdentityFingerprint();
    setAuthToken("access_token_2", 3600, "shared_refresh");
    const fp2 = getIdentityFingerprint();
    expect(fp1).toBe(fp2);
  });

  test("different OAuth refresh tokens produce different fingerprints", () => {
    setAuthToken("access_token", 3600, "refresh_alice");
    const aliceFp = getIdentityFingerprint();
    setAuthToken("access_token", 3600, "refresh_bob");
    const bobFp = getIdentityFingerprint();
    expect(aliceFp).not.toBe(bobFp);
  });

  test("SENTRY_FORCE_ENV_TOKEN switches the fingerprint source to the env token", () => {
    setAuthToken("stored_oauth", 3600, "stored_refresh");
    process.env.SENTRY_AUTH_TOKEN = "env_token";
    const storedFp = getIdentityFingerprint();
    try {
      process.env.SENTRY_FORCE_ENV_TOKEN = "1";
      resetIdentityFingerprintCache();
      const envFp = getIdentityFingerprint();
      expect(envFp).not.toBe(storedFp);
    } finally {
      delete process.env.SENTRY_FORCE_ENV_TOKEN;
    }
  });

  test("env and OAuth fingerprints with the same secret value are distinct", () => {
    // The `kind` prefix in hashIdentity keeps env/oauth namespaces
    // distinct even when secrets happen to collide.
    process.env.SENTRY_AUTH_TOKEN = "shared_secret";
    const envFp = getIdentityFingerprint();
    delete process.env.SENTRY_AUTH_TOKEN;
    setAuthToken("shared_secret", 3600, "shared_secret");
    const oauthFp = getIdentityFingerprint();
    expect(envFp).not.toBe(oauthFp);
  });

  test("expired access-only OAuth token falls through to env token", () => {
    // Mirrors getAuthConfig: an expired access token with no
    // refresh_token is unusable — the API client sends the env token,
    // so the fingerprint must match.
    setAuthToken("expired_access", -1);
    process.env.SENTRY_AUTH_TOKEN = "env_token";
    resetIdentityFingerprintCache();
    const fp = getIdentityFingerprint();

    // With no DB row, same env token should produce the same fingerprint.
    getDatabase().query("DELETE FROM auth").run();
    resetIdentityFingerprintCache();
    expect(getIdentityFingerprint()).toBe(fp);
  });

  test("expired access-only OAuth token with refresh_token uses the refresh token", () => {
    // An expired access token + refresh_token is still usable; the
    // fingerprint keys off the stable refresh_token.
    setAuthToken("expired_access", -1, "live_refresh");
    const fp = getIdentityFingerprint();
    setAuthToken("fresh_access", 3600, "live_refresh");
    expect(getIdentityFingerprint()).toBe(fp);
  });
});

describe("getAuthToken memoization", () => {
  test("returns cached value on repeated calls without re-reading the DB", () => {
    setAuthToken("stored_token");
    const first = getAuthToken();
    expect(first).toBe("stored_token");

    // Mutate the DB row directly behind getAuthToken's back — a cached
    // read must not reflect this change until the cache is invalidated.
    getDatabase().query("UPDATE auth SET token = 'mutated' WHERE id = 1").run();

    // Still returns the cached value
    expect(getAuthToken()).toBe("stored_token");

    // After reset, the new value is read
    resetAuthTokenCache();
    expect(getAuthToken()).toBe("mutated");
  });

  test("caches the logged-out state (undefined) without re-reading", () => {
    expect(getAuthToken()).toBeUndefined();

    // Write a token directly to DB, bypassing setAuthToken. The cached
    // undefined must persist until invalidated.
    getDatabase()
      .query("INSERT INTO auth (id, token, updated_at) VALUES (1, 'sneaky', ?)")
      .run(Date.now());

    expect(getAuthToken()).toBeUndefined();

    resetAuthTokenCache();
    expect(getAuthToken()).toBe("sneaky");
  });

  test("setAuthToken invalidates the cache", () => {
    setAuthToken("token_a");
    expect(getAuthToken()).toBe("token_a");

    setAuthToken("token_b");
    // No manual reset — setAuthToken must have invalidated the cache
    expect(getAuthToken()).toBe("token_b");
  });

  test("clearAuth invalidates the cache", async () => {
    setAuthToken("token_to_clear");
    expect(getAuthToken()).toBe("token_to_clear");

    await clearAuth();
    expect(getAuthToken()).toBeUndefined();
  });

  test("env-var change requires manual cache reset (documented contract)", () => {
    expect(getAuthToken()).toBeUndefined();

    // Env mutation without reset: cache stays stale (by design).
    process.env.SENTRY_AUTH_TOKEN = "env_token";
    expect(getAuthToken()).toBeUndefined();

    resetAuthTokenCache();
    expect(getAuthToken()).toBe("env_token");
  });
});

describe("refreshToken row-read memoization", () => {
  test("setAuthToken between refreshToken calls is reflected", async () => {
    // refreshToken reads the full row; invalidation must propagate so the
    // second call sees the freshly stored token.
    setAuthToken("first_token", 3600, "refresh_1");
    const r1 = await refreshToken();
    expect(r1.token).toBe("first_token");

    setAuthToken("second_token", 3600, "refresh_2");
    const r2 = await refreshToken();
    expect(r2.token).toBe("second_token");
  });

  test("clearAuth invalidates the row cache", async () => {
    setAuthToken("will_be_cleared", 3600, "refresh_x");
    const r1 = await refreshToken();
    expect(r1.token).toBe("will_be_cleared");

    await clearAuth();
    // With nothing stored and no env var, refreshToken throws not_authenticated
    await expect(refreshToken()).rejects.toThrow();
  });
});

describe("hasStoredAuthCredentials memoization", () => {
  test("returns false and caches when no stored token", () => {
    expect(hasStoredAuthCredentials()).toBe(false);
    // Second call hits cache — would be identical even without memoization,
    // but we verify the function is stable across calls.
    expect(hasStoredAuthCredentials()).toBe(false);
  });

  test("returns true after setAuthToken", () => {
    expect(hasStoredAuthCredentials()).toBe(false);

    setAuthToken("oauth_tok", 3600, "refresh_tok");
    // setAuthToken invalidates the cache — next call sees the new row.
    expect(hasStoredAuthCredentials()).toBe(true);
  });

  test("clearAuth invalidates the cached result", async () => {
    setAuthToken("oauth_tok", 3600, "refresh_tok");
    expect(hasStoredAuthCredentials()).toBe(true);

    await clearAuth();
    expect(hasStoredAuthCredentials()).toBe(false);
  });

  test("manual resetHasStoredCredsCache forces re-read", () => {
    expect(hasStoredAuthCredentials()).toBe(false);

    // Write directly to DB without going through setAuthToken
    // (simulates a code path the cache doesn't know about).
    const db = getDatabase();
    db.query(
      "INSERT OR REPLACE INTO auth (id, token) VALUES (1, 'sneaky')",
    ).run();

    // Cache still returns stale false
    expect(hasStoredAuthCredentials()).toBe(false);

    // Manual reset forces re-read
    resetHasStoredCredsCache();
    expect(hasStoredAuthCredentials()).toBe(true);
  });
});
