/**
 * CVE regression: custom-headers leak via share URL and via the
 * `auth login` rc-URL bypass.
 *
 * Tests `applyCustomHeaders` trust scoping. Two attack shapes:
 * 1. Share URL: `getSharedIssue(https://evil.com, ...)` — headers must
 *    not attach to URLs that don't match the active token.
 * 2. auth login bypass: when `env.SENTRY_URL` is rc-poisoned and no
 *    token is active yet, headers must fail closed.
 *
 * See also `fetch-layer-guard.test.ts` for the Bearer-token path.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getSharedIssue } from "../../../src/lib/api/issues.js";
import {
  _resetCustomHeadersCache,
  applyCustomHeaders,
} from "../../../src/lib/custom-headers.js";
import {
  captureEnvTokenHost,
  resetEnvTokenHostForTesting,
} from "../../../src/lib/env-token-host.js";
import { useEnvSandbox } from "../../helpers.js";

const ENV_KEYS = [
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
  "SENTRY_HOST",
  "SENTRY_URL",
  "SENTRY_CUSTOM_HEADERS",
] as const;

describe("CVE: custom-headers leak (share URL + auth-login bypass)", () => {
  useEnvSandbox(ENV_KEYS);

  beforeEach(() => {
    resetEnvTokenHostForTesting();
    _resetCustomHeadersCache();
  });

  afterEach(() => {
    resetEnvTokenHostForTesting();
    _resetCustomHeadersCache();
  });

  test("getSharedIssue with attacker baseUrl does not leak custom headers (direct-call regression)", async () => {
    // Simulates someone bypassing applySentryUrlContext and calling
    // getSharedIssue directly with an attacker-controlled baseUrl.
    process.env.SENTRY_CUSTOM_HEADERS = "X-IAP-Token: secret";
    process.env.SENTRY_HOST = "https://sentry.acme.com";
    captureEnvTokenHost();

    // Intercept fetch to capture outbound headers
    const originalFetch = globalThis.fetch;
    let capturedHeaders: Headers | undefined;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      capturedHeaders = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined)
      );
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    try {
      await getSharedIssue(
        "https://evil.com",
        "test-org",
        "deadbeef12345678"
      ).catch(() => {
        /* we only care about headers, not the response */
      });
      expect(capturedHeaders?.get("X-IAP-Token")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("IAP onboarding: 'auth login --url' registers a trust anchor so custom headers attach during OAuth device flow", async () => {
    // Scenario: first-time self-hosted login with IAP protection.
    // User runs `sentry auth login --url https://sentry.acme.com` before
    // having any token. The device-code request MUST carry the IAP
    // token or the IAP proxy will block it.
    delete process.env.SENTRY_AUTH_TOKEN;
    delete process.env.SENTRY_TOKEN;
    process.env.SENTRY_CUSTOM_HEADERS = "X-IAP-Token: legit";

    // `applyLoginUrl` (from login command) registers the trust anchor
    const { applyLoginUrl } = await import(
      "../../../src/commands/auth/login.js"
    );
    applyLoginUrl("https://sentry.acme.com");

    const headers = new Headers();
    applyCustomHeaders(headers, "https://sentry.acme.com/oauth/device/code/");
    // Legitimate IAP token attaches — this is the onboarding case
    expect(headers.get("X-IAP-Token")).toBe("legit");

    // Cleanup the anchor so subsequent tests aren't affected
    const { resetLoginTrustAnchorForTesting } = await import(
      "../../../src/lib/token-host.js"
    );
    resetLoginTrustAnchorForTesting();
  });

  test("Attacker .sentryclirc does NOT register a login trust anchor (rc bypass still fails closed)", async () => {
    // This is the critical distinguishing test: the .sentryclirc shim
    // writes env.SENTRY_URL (trust check is deferred to buildCommand), but it
    // does NOT call registerLoginTrustAnchor. So no-token
    // applyCustomHeaders must still fail closed even though SENTRY_URL
    // is set.
    delete process.env.SENTRY_AUTH_TOKEN;
    delete process.env.SENTRY_TOKEN;
    process.env.SENTRY_CUSTOM_HEADERS = "X-IAP-Token: secret";
    process.env.SENTRY_URL = "https://evil.com"; // simulating rc shim write
    // Intentionally NOT calling applyLoginUrl — attacker flow doesn't

    const { resetLoginTrustAnchorForTesting } = await import(
      "../../../src/lib/token-host.js"
    );
    resetLoginTrustAnchorForTesting();

    const headers = new Headers();
    applyCustomHeaders(headers, "https://evil.com/oauth/device/code/");
    expect(headers.get("X-IAP-Token")).toBeNull();
  });
});
