/**
 * Tests for host-scoped auth: setAuthToken persistence, getStoredAuthHost,
 * NULL-host lazy migration, host preservation across refresh-style updates.
 */

import { describe, expect, test } from "vitest";
import {
  getStoredAuthHost,
  hasUsableStoredToken,
  setAuthToken,
} from "../../../src/lib/db/auth.js";
import { getDatabase } from "../../../src/lib/db/index.js";
import { useTestConfigDir } from "../../helpers.js";

describe("db/auth host scoping", () => {
  useTestConfigDir("auth-host-test-");

  test("setAuthToken persists explicit host", () => {
    setAuthToken("tok-1", undefined, undefined, {
      host: "https://sentry.acme.com",
    });
    expect(getStoredAuthHost()).toBe("https://sentry.acme.com");
  });

  test("setAuthToken normalizes host (lowercases + strips trailing slash)", () => {
    setAuthToken("tok-1", undefined, undefined, {
      host: "https://SENTRY.Acme.com/",
    });
    // normalizeOrigin lowercases + strips trailing slash
    expect(getStoredAuthHost()).toBe("https://sentry.acme.com");
  });

  test("setAuthToken without host explicit uses configured host", () => {
    const prevHost = process.env.SENTRY_HOST;
    process.env.SENTRY_HOST = "https://env-host.example.com";
    try {
      setAuthToken("tok-2");
      expect(getStoredAuthHost()).toBe("https://env-host.example.com");
    } finally {
      if (prevHost === undefined) {
        delete process.env.SENTRY_HOST;
      } else {
        process.env.SENTRY_HOST = prevHost;
      }
    }
  });

  test("setAuthToken without host falls back to DEFAULT_SENTRY_URL", () => {
    const prevHost = process.env.SENTRY_HOST;
    const prevUrl = process.env.SENTRY_URL;
    delete process.env.SENTRY_HOST;
    delete process.env.SENTRY_URL;
    try {
      setAuthToken("tok-3");
      expect(getStoredAuthHost()).toBe("https://sentry.io");
    } finally {
      if (prevHost !== undefined) {
        process.env.SENTRY_HOST = prevHost;
      }
      if (prevUrl !== undefined) {
        process.env.SENTRY_URL = prevUrl;
      }
    }
  });

  test("refresh-style update preserves existing host when options.host omitted", () => {
    setAuthToken("tok-initial", 3600, "refresh-tok", {
      host: "https://sentry.acme.com",
    });
    expect(getStoredAuthHost()).toBe("https://sentry.acme.com");

    // Simulate a refresh: new access token + same refresh token, no host
    setAuthToken("tok-refreshed", 3600, "refresh-tok");
    expect(getStoredAuthHost()).toBe("https://sentry.acme.com");
  });

  test("lazy migration: NULL host is backfilled from BOOT-TIME env on first access", async () => {
    // Simulate a pre-v16 row: direct INSERT bypassing setAuthToken
    const db = getDatabase();
    db.query(
      "INSERT OR REPLACE INTO auth (id, token, host, updated_at) VALUES (1, 'legacy-token', NULL, ?)"
    ).run(Date.now());

    // Simulate the boot ordering: SHELL-exports SENTRY_HOST, then
    // captureEnvTokenHost snapshots it. Migration reads this snapshot
    // (not the current env, which could be rc-poisoned by the shim).
    const { captureEnvTokenHost, resetEnvTokenHostForTesting } = await import(
      "../../../src/lib/env-token-host.js"
    );
    resetEnvTokenHostForTesting();
    const prevHost = process.env.SENTRY_HOST;
    process.env.SENTRY_HOST = "https://legacy-configured.example.com";
    captureEnvTokenHost();

    try {
      expect(getStoredAuthHost()).toBe("https://legacy-configured.example.com");
      // Second call reads the now-populated host
      expect(getStoredAuthHost()).toBe("https://legacy-configured.example.com");
      // Verify it was actually written to the DB
      const row = db.query("SELECT host FROM auth WHERE id = 1").get() as {
        host: string | null;
      };
      expect(row.host).toBe("https://legacy-configured.example.com");
    } finally {
      if (prevHost === undefined) {
        delete process.env.SENTRY_HOST;
      } else {
        process.env.SENTRY_HOST = prevHost;
      }
      resetEnvTokenHostForTesting();
    }
  });

  test("lazy migration: NULL host + no boot-time env falls back to SaaS", async () => {
    const db = getDatabase();
    db.query(
      "INSERT OR REPLACE INTO auth (id, token, host, updated_at) VALUES (1, 'legacy-token', NULL, ?)"
    ).run(Date.now());

    const { captureEnvTokenHost, resetEnvTokenHostForTesting } = await import(
      "../../../src/lib/env-token-host.js"
    );
    resetEnvTokenHostForTesting();
    const prevHost = process.env.SENTRY_HOST;
    const prevUrl = process.env.SENTRY_URL;
    delete process.env.SENTRY_HOST;
    delete process.env.SENTRY_URL;
    captureEnvTokenHost(); // captures DEFAULT_SENTRY_URL (SaaS)

    try {
      expect(getStoredAuthHost()).toBe("https://sentry.io");
    } finally {
      if (prevHost !== undefined) {
        process.env.SENTRY_HOST = prevHost;
      }
      if (prevUrl !== undefined) {
        process.env.SENTRY_URL = prevUrl;
      }
      resetEnvTokenHostForTesting();
    }
  });

  test("lazy migration: ignores rc-poisoned current env (uses boot snapshot instead)", async () => {
    // Critical regression: previously migration called getConfiguredSentryUrl()
    // which reads CURRENT env. If .sentryclirc shim wrote env.SENTRY_URL
    // before migration fired, the token would be migrated to the
    // rc-sourced (potentially attacker) host. Now migration uses the
    // boot snapshot so rc writes don't affect it.
    const db = getDatabase();
    db.query(
      "INSERT OR REPLACE INTO auth (id, token, host, updated_at) VALUES (1, 'legacy-token', NULL, ?)"
    ).run(Date.now());

    const { captureEnvTokenHost, resetEnvTokenHostForTesting } = await import(
      "../../../src/lib/env-token-host.js"
    );
    resetEnvTokenHostForTesting();
    const prevHost = process.env.SENTRY_HOST;
    const prevUrl = process.env.SENTRY_URL;
    delete process.env.SENTRY_HOST;
    delete process.env.SENTRY_URL;
    captureEnvTokenHost(); // snapshots SaaS default

    // Simulate rc shim writing env.SENTRY_URL AFTER boot
    process.env.SENTRY_URL = "https://rc-sourced.example.com";

    try {
      // Must migrate to the BOOT snapshot (SaaS), not the rc-sourced URL
      expect(getStoredAuthHost()).toBe("https://sentry.io");
    } finally {
      if (prevHost !== undefined) {
        process.env.SENTRY_HOST = prevHost;
      } else {
        delete process.env.SENTRY_HOST;
      }
      if (prevUrl !== undefined) {
        process.env.SENTRY_URL = prevUrl;
      } else {
        delete process.env.SENTRY_URL;
      }
      resetEnvTokenHostForTesting();
    }
  });

  test("getStoredAuthHost returns undefined when no stored token", () => {
    // Nothing persisted
    expect(getStoredAuthHost()).toBeUndefined();
  });

  test("hasUsableStoredToken reflects stored row status", () => {
    expect(hasUsableStoredToken()).toBe(false);

    setAuthToken("tok-usable", 3600, "refresh", {
      host: "https://sentry.io",
    });
    expect(hasUsableStoredToken()).toBe(true);
  });

  test("clearAuth evicts region-URL allow-list but PRESERVES login trust anchor", async () => {
    // The login anchor is set by `applyLoginUrl` at the start of the
    // `auth login` command lifecycle. When the user runs `auth login
    // --url <new-host>` while already authenticated, the flow is:
    //   1. applyLoginUrl — registers the new login trust anchor
    //   2. handleExistingAuth — calls clearAuth() if user confirms
    //   3. login proceeds — needs the anchor for IAP custom headers
    // If clearAuth wiped the anchor at step 2, step 3 would lose it
    // and IAP-protected re-authentication would fail. The anchor is
    // process-local and overwritten by the NEXT applyLoginUrl, so we
    // don't need to clear it on logout.
    const { isLoginTrustAnchorFor, registerLoginTrustAnchor } = await import(
      "../../../src/lib/token-host.js"
    );
    const { isTrustedRegionOrigin, registerTrustedRegionUrls } = await import(
      "../../../src/lib/db/regions.js"
    );
    setAuthToken("tok-A", 3600, "refresh", {
      host: "https://sentry.host-a.com",
    });
    registerLoginTrustAnchor("https://sentry.host-a.com");
    registerTrustedRegionUrls(["https://us.host-a.com"]);
    expect(isLoginTrustAnchorFor("https://sentry.host-a.com")).toBe(true);
    expect(isTrustedRegionOrigin("https://us.host-a.com")).toBe(true);

    const { clearAuth } = await import("../../../src/lib/db/auth.js");
    await clearAuth();

    // Region-URL allow-list cleared (was identity-specific).
    expect(isTrustedRegionOrigin("https://us.host-a.com")).toBe(false);
    // Login anchor PRESERVED (the `auth login --url` flow sets this
    // BEFORE clearAuth runs and needs it AFTER for the device flow).
    expect(isLoginTrustAnchorFor("https://sentry.host-a.com")).toBe(true);
  });
});
