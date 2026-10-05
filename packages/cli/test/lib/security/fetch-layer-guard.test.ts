/**
 * Defense-in-depth regression tests for the fetch layer.
 *
 * Even if a future code path bypasses the URL-arg / .sentryclirc entry-point
 * guards and writes `SENTRY_HOST`/`SENTRY_URL` directly, the fetch layer
 * must still refuse to attach credentials to a request whose origin
 * doesn't match the active token's scope.
 *
 * This file simulates the bypass by directly calling the lower-level
 * primitives (`apiRequest`, `applyCustomHeaders`, `refreshAccessToken`)
 * with mismatched hosts.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  _resetCustomHeadersCache,
  applyCustomHeaders,
} from "../../../src/lib/custom-headers.js";
import { resetEnvTokenHostForTesting } from "../../../src/lib/env-token-host.js";
import { useEnvSandbox } from "../../helpers.js";

const ENV_KEYS = [
  "SENTRY_HOST",
  "SENTRY_URL",
  "SENTRY_CUSTOM_HEADERS",
] as const;

describe("CVE defense-in-depth: fetch layer refuses mismatched hosts", () => {
  useEnvSandbox(ENV_KEYS);

  beforeEach(() => {
    resetEnvTokenHostForTesting();
    _resetCustomHeadersCache();
  });

  afterEach(() => {
    resetEnvTokenHostForTesting();
    _resetCustomHeadersCache();
  });

  test("applyCustomHeaders: IAP token does NOT leak to untrusted URL (CVE #3)", () => {
    // Reproduce the share-URL attack directly at the header layer.
    // Even if something bypasses applySentryUrlContext and arrives at
    // applyCustomHeaders with a mismatched URL, the header attach must
    // refuse.
    process.env.SENTRY_CUSTOM_HEADERS = "X-IAP-Token: sensitive-iap-value";
    process.env.SENTRY_HOST = "https://sentry.example.com";

    const headers = new Headers();
    applyCustomHeaders(
      headers,
      "https://evil.com/api/0/shared/issues/deadbeef/"
    );

    expect(headers.get("X-IAP-Token")).toBeNull();
    // Verify no other custom headers leaked either
    expect([...headers.keys()]).toHaveLength(0);
  });

  test("applyCustomHeaders: IAP token attaches to trusted URL", () => {
    process.env.SENTRY_CUSTOM_HEADERS = "X-IAP-Token: sensitive-iap-value";
    process.env.SENTRY_HOST = "https://sentry.example.com";

    const headers = new Headers();
    applyCustomHeaders(
      headers,
      "https://sentry.example.com/api/0/organizations/"
    );

    expect(headers.get("X-IAP-Token")).toBe("sensitive-iap-value");
  });

  test("applyCustomHeaders: does NOT attach to a look-alike SaaS host (prefix/suffix attack)", () => {
    // Critical: sentry.io.evil.com is NOT a sentry.io subdomain, so even
    // a SaaS-scoped token shouldn't grant trust to it.
    // SENTRY_CUSTOM_HEADERS is an IAP/proxy feature that only applies to
    // self-hosted instances (getCustomHeaders short-circuits on SaaS),
    // so we set SENTRY_HOST to enable it for this test.
    process.env.SENTRY_CUSTOM_HEADERS = "X-Custom: value";
    process.env.SENTRY_HOST = "https://sentry.acme.com";

    const headers = new Headers();
    applyCustomHeaders(headers, "https://sentry.acme.com.evil.com/api/0/");

    expect(headers.get("X-Custom")).toBeNull();
  });

  test("applyCustomHeaders: subdomain-attack on self-hosted is refused", () => {
    // Token scoped to sentry.acme.com must not authorize sub.sentry.acme.com
    // when it's actually an attacker-controlled subdomain takeover.
    // (Non-SaaS trust class requires EXACT origin match.)
    process.env.SENTRY_CUSTOM_HEADERS = "X-IAP-Token: secret";
    process.env.SENTRY_HOST = "https://sentry.acme.com";

    const headers = new Headers();
    applyCustomHeaders(headers, "https://attacker.sentry.acme.com/api/0/");

    expect(headers.get("X-IAP-Token")).toBeNull();
  });
});
