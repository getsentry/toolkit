/**
 * Regression: auto-login (the error-recovery middleware that runs the OAuth
 * device flow when a command hits an auth error in an interactive TTY) must
 * honor the same host-trust gate as `sentry auth login`.
 *
 * Bug (getsentry/cli#1121): `sentry auth login` refuses a self-hosted host
 * unless `--url` confirms it, but `sentry auth whoami` (and any other command)
 * triggered an unconfirmed auto-login against `env.SENTRY_HOST`/`SENTRY_URL`,
 * bypassing that gate. Since a `.sentryclirc` shim can inject `env.SENTRY_URL`,
 * the bypass also reopened the OAuth-phishing vector that the `auth login`
 * gate was added to close (see login-token-rc-poison.test.ts).
 *
 * These tests pin the trust predicates that the middleware now calls before
 * starting the device flow.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { clearAuth, setAuthToken } from "../../../src/lib/db/auth.js";
import { setDefaultUrl } from "../../../src/lib/db/defaults.js";
import {
  buildHostRefusalMessage,
  isAutoLoginHostTrusted,
  isLoginHostTrusted,
  resolveEffectiveLoginHost,
} from "../../../src/lib/login-host-guard.js";
import { registerLoginTrustAnchor } from "../../../src/lib/token-host.js";
import {
  resetHostScopingState,
  useEnvSandbox,
  useTestConfigDir,
} from "../../helpers.js";

const ENV_KEYS = ["SENTRY_HOST", "SENTRY_URL"] as const;

describe("auto-login host guard", () => {
  useTestConfigDir("auto-login-guard-");
  useEnvSandbox(ENV_KEYS);

  beforeEach(async () => {
    await resetHostScopingState();
  });

  afterEach(async () => {
    await resetHostScopingState();
  });

  describe("resolveEffectiveLoginHost", () => {
    test("falls back to SaaS when no host env is set", () => {
      expect(resolveEffectiveLoginHost()).toBe("https://sentry.io");
    });

    test("reads SENTRY_HOST", () => {
      process.env.SENTRY_HOST = "https://sentry.example.com";
      expect(resolveEffectiveLoginHost()).toBe("https://sentry.example.com");
    });

    test("reads SENTRY_URL when SENTRY_HOST is absent", () => {
      process.env.SENTRY_URL = "https://sentry.example.com/";
      expect(resolveEffectiveLoginHost()).toBe("https://sentry.example.com");
    });
  });

  describe("isLoginHostTrusted (explicit `auth login` gate)", () => {
    test("SaaS is always trusted", () => {
      expect(isLoginHostTrusted("https://sentry.io")).toBe(true);
    });

    test("self-hosted without a trust anchor is refused", () => {
      expect(isLoginHostTrusted("https://sentry.example.com")).toBe(false);
    });

    test("self-hosted with a matching trust anchor is trusted", () => {
      registerLoginTrustAnchor("https://sentry.example.com");
      expect(isLoginHostTrusted("https://sentry.example.com")).toBe(true);
    });

    test("a persisted default URL does NOT relax the explicit gate", () => {
      // Explicit `auth login` is intentionally stricter than auto-login:
      // confirming a self-hosted host still requires `--url` even when that
      // host is the persisted default.
      setDefaultUrl("https://sentry.example.com");
      expect(isLoginHostTrusted("https://sentry.example.com")).toBe(false);
    });
  });

  describe("isAutoLoginHostTrusted (the #1121 fix)", () => {
    test("SaaS auto-login still proceeds", () => {
      expect(isAutoLoginHostTrusted("https://sentry.io")).toBe(true);
    });

    test("self-hosted with no confirmed host is REFUSED", () => {
      // The reported bug: `whoami` against SENTRY_HOST with no creds used to
      // auto-login here. Must now be refused, matching `auth login`.
      expect(isAutoLoginHostTrusted("https://sentry.example.com")).toBe(false);
    });

    test("self-hosted re-auth against the persisted default URL is allowed", () => {
      // Expired-session re-auth: the host was confirmed via `auth login --url`
      // (which persists defaults.url), so we don't force `--url` again on
      // every token expiry.
      setDefaultUrl("https://sentry.example.com");
      expect(isAutoLoginHostTrusted("https://sentry.example.com")).toBe(true);
    });

    test("the anchor survives clearAuth (the expired-session path)", async () => {
      // Both expired paths call clearAuth() before the AuthError reaches the
      // middleware, so the stored token row is gone by the time the guard
      // runs. defaults.url survives clearAuth, so re-auth still proceeds —
      // this is the regression Cursor flagged.
      setAuthToken("tok", undefined, undefined, {
        host: "https://sentry.example.com",
      });
      setDefaultUrl("https://sentry.example.com");
      await clearAuth();
      expect(isAutoLoginHostTrusted("https://sentry.example.com")).toBe(true);
    });

    test("scope-recovery re-auth against the stored token host is allowed (no default URL)", () => {
      // 403 scope recovery: the OAuth token row is still present (clearAuth
      // has NOT run). The token host is authoritative even when default-URL
      // persistence failed or was cleared, so re-auth proceeds without --url.
      setAuthToken("tok", undefined, undefined, {
        host: "https://sentry.example.com",
      });
      expect(isAutoLoginHostTrusted("https://sentry.example.com")).toBe(true);
    });

    test("injected host that differs from the confirmed default is REFUSED", () => {
      // Default is the real instance; a poisoned env.SENTRY_URL points
      // elsewhere. The confirmed host must not act as a free pass for a
      // different (attacker) host.
      setDefaultUrl("https://sentry.example.com");
      expect(isAutoLoginHostTrusted("https://evil.com")).toBe(false);
    });

    test("injected host that differs from the stored token host is REFUSED", () => {
      // Token exists for the real instance; isHostTrusted requires an exact
      // match, so an injected env.SENTRY_URL pointing elsewhere is refused.
      setAuthToken("tok", undefined, undefined, {
        host: "https://sentry.example.com",
      });
      expect(isAutoLoginHostTrusted("https://evil.com")).toBe(false);
    });

    test("self-hosted with a matching trust anchor is allowed", () => {
      registerLoginTrustAnchor("https://sentry.example.com");
      expect(isAutoLoginHostTrusted("https://sentry.example.com")).toBe(true);
    });
  });

  describe("buildHostRefusalMessage", () => {
    test("auto-login (generic) message names the host and the --url fix", () => {
      const msg = buildHostRefusalMessage("https://sentry.example.com");
      expect(msg).toBe(
        "Refusing to log in against https://sentry.example.com — --url was not provided.\n\n" +
          "To authenticate against this self-hosted instance, confirm the host explicitly:\n" +
          "  sentry auth login --url https://sentry.example.com"
      );
    });

    test("rcSource and tokenFlag are reflected (explicit-login wording)", () => {
      const msg = buildHostRefusalMessage("https://sentry.example.com", {
        tokenFlag: true,
        rcSource: "/repo/.sentryclirc",
      });
      expect(msg).toContain(
        "this URL was read from .sentryclirc (/repo/.sentryclirc) but hasn't been confirmed as trusted yet"
      );
      expect(msg).toContain(
        "  sentry auth login --url https://sentry.example.com --token <your-token>"
      );
    });
  });
});
