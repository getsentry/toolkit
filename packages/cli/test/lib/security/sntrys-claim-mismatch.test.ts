/**
 * Defense-in-depth: `sntrys_` token claim vs request-origin mismatch.
 *
 * The fetch-layer guard refuses to attach a `sntrys_` token when its
 * embedded `url` claim disagrees with the request origin. Defends users
 * with access to multiple Sentry instances against routing one
 * instance's token to another. Claim is unsigned (see token-claims.ts),
 * so this catches honest misconfigurations more than malicious attacks.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  extractFetchUrl,
  mintSntrysToken,
  resetHostScopingState,
  useEnvSandbox,
} from "../../helpers.js";

const ENV_KEYS = [
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
  "SENTRY_HOST",
  "SENTRY_URL",
] as const;

describe("CVE defense-in-depth: sntrys_ claim vs request mismatch", () => {
  useEnvSandbox(ENV_KEYS);

  let fetchCalls: { url: string; auth: string | null }[];
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    await resetHostScopingState();
    const {
      resetAuthTokenCache,
      resetAuthRowCache,
      resetIdentityFingerprintCache,
    } = await import("../../../src/lib/db/auth.js");
    // Clear the GET response cache between tests so a cached 200 from
    // a prior test's identical URL doesn't short-circuit the fetch
    // wrapper (which would leave `fetchCalls` empty).
    const { clearResponseCache } = await import(
      "../../../src/lib/response-cache.js"
    );
    resetAuthTokenCache();
    resetAuthRowCache();
    resetIdentityFingerprintCache();
    await clearResponseCache();

    fetchCalls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined)
      );
      fetchCalls.push({
        url: extractFetchUrl(input),
        auth: headers.get("Authorization"),
      });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
  });

  afterEach(async () => {
    await resetHostScopingState();
    globalThis.fetch = originalFetch;
  });

  test("token whose claim says A is refused when env routing says B", async () => {
    // Token issued by sentry.firsthost.com (claim).
    // Env says SENTRY_HOST = sentry.secondhost.com (user's shell — trusted).
    process.env.SENTRY_AUTH_TOKEN = mintSntrysToken({
      iat: 1_700_000_000,
      url: "https://sentry.firsthost.com",
      org: "x",
    });
    process.env.SENTRY_HOST = "https://sentry.secondhost.com";
    const { captureEnvTokenHost } = await import(
      "../../../src/lib/env-token-host.js"
    );
    captureEnvTokenHost();

    // Direct request to sentry.secondhost.com (matches env scope but NOT the claim).
    const { apiRequestToRegion } = await import(
      "../../../src/lib/api/infrastructure.js"
    );
    await expect(
      apiRequestToRegion("https://sentry.secondhost.com", "/organizations/", {
        method: "GET",
      })
    ).rejects.toThrow(/embedded claim|sentry\.firsthost\.com/i);

    // Token never hit the wire.
    const leaked = fetchCalls.filter((c) =>
      c.auth?.includes("secret-tail-for-test")
    );
    expect(leaked).toEqual([]);
  });

  test("token whose claim matches the request proceeds normally", async () => {
    process.env.SENTRY_AUTH_TOKEN = mintSntrysToken({
      iat: 1_700_000_000,
      url: "https://sentry.acme.com",
      org: "x",
    });
    process.env.SENTRY_HOST = "https://sentry.acme.com";
    const { captureEnvTokenHost } = await import(
      "../../../src/lib/env-token-host.js"
    );
    captureEnvTokenHost();

    // Request to the host the claim agrees with → bearer attaches.
    const { apiRequestToRegion } = await import(
      "../../../src/lib/api/infrastructure.js"
    );
    await apiRequestToRegion("https://sentry.acme.com", "/organizations/", {
      method: "GET",
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.auth).toContain("Bearer ");
  });

  test("self-hosted multi-region: claim check honors region URL extension", async () => {
    // Regression: previously the claim check used raw `isHostTrusted`,
    // which only honors exact-origin + SaaS equivalence. For self-hosted
    // multi-region setups, the claim's url points at the control silo
    // but fan-out goes to regional silos discovered via
    // `/users/me/regions/`. The fix uses `isHostTrustedForClaim` which
    // also consults the region-URL extension.
    process.env.SENTRY_AUTH_TOKEN = mintSntrysToken({
      iat: 1_700_000_000,
      url: "https://sentry.acme.com",
      org: "x",
    });
    process.env.SENTRY_HOST = "https://sentry.acme.com";
    const { captureEnvTokenHost } = await import(
      "../../../src/lib/env-token-host.js"
    );
    captureEnvTokenHost();

    // Simulate: control silo's /users/me/regions/ told us about a
    // regional silo at https://us.sentry.acme.com.
    const { registerTrustedRegionUrls } = await import(
      "../../../src/lib/db/regions.js"
    );
    registerTrustedRegionUrls(["https://us.sentry.acme.com"]);

    // Request to the regional silo (NOT the claim's url) must succeed
    // because the region URL is part of the same trust class.
    const { apiRequestToRegion } = await import(
      "../../../src/lib/api/infrastructure.js"
    );
    await apiRequestToRegion("https://us.sentry.acme.com", "/organizations/", {
      method: "GET",
    });

    // Request fired with the bearer token attached. Cleanup of the
    // in-process region allow-list happens in afterEach.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.auth).toContain("Bearer ");
  });

  test("opaque (non-sntrys_) tokens are not affected by claim check", async () => {
    // A `sntryu_` user-auth token has no claim — the claim check is a
    // no-op. The existing host-scoping check is the only enforcement.
    process.env.SENTRY_AUTH_TOKEN = "sntryu_opaqueusertoken1234567890abcdef";
    process.env.SENTRY_HOST = "https://sentry.acme.com";
    const { captureEnvTokenHost } = await import(
      "../../../src/lib/env-token-host.js"
    );
    captureEnvTokenHost();

    const { apiRequestToRegion } = await import(
      "../../../src/lib/api/infrastructure.js"
    );
    await apiRequestToRegion("https://sentry.acme.com", "/organizations/", {
      method: "GET",
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.auth).toContain("Bearer ");
  });
});

describe("UX path: env-token-host falls back to sntrys_ claim url", () => {
  // These tests check the captureEnvTokenHost snapshot — no fetch
  // mocking needed.
  useEnvSandbox(ENV_KEYS);

  beforeEach(resetHostScopingState);
  afterEach(resetHostScopingState);

  test("self-hosted user with sntrys_ token but no SENTRY_HOST → snapshot uses claim", async () => {
    // User pasted a sntrys_ token from their self-hosted UI but didn't
    // also export SENTRY_HOST. Without the claim fallback, the snapshot
    // would default to SaaS and every command would trip the host
    // guard. With the claim fallback, the snapshot picks up the
    // self-hosted url from the token itself.
    process.env.SENTRY_AUTH_TOKEN = mintSntrysToken({
      iat: 1_700_000_000,
      url: "https://sentry.selfhosted.example.com",
      org: "x",
    });
    // No SENTRY_HOST, no SENTRY_URL set.

    const { captureEnvTokenHost, getEnvTokenHost } = await import(
      "../../../src/lib/env-token-host.js"
    );
    captureEnvTokenHost();

    expect(getEnvTokenHost()).toBe("https://sentry.selfhosted.example.com");
  });

  test("sntrys_ claim wins over SENTRY_HOST (immune to env injection)", async () => {
    // The claim is authoritative for sntrys_ tokens. Even when
    // SENTRY_HOST is set (legitimately or via CI env injection), the
    // snapshot uses the claim — it's the only value the token's
    // issuing server can vouch for.
    process.env.SENTRY_AUTH_TOKEN = mintSntrysToken({
      iat: 1_700_000_000,
      url: "https://sentry.firsthost.com",
      org: "x",
    });
    process.env.SENTRY_HOST = "https://sentry.secondhost.com";

    const { captureEnvTokenHost, getEnvTokenHost } = await import(
      "../../../src/lib/env-token-host.js"
    );
    captureEnvTokenHost();

    expect(getEnvTokenHost()).toBe("https://sentry.firsthost.com");
  });

  test("non-sntrys_ token + no SENTRY_HOST → snapshot falls back to SaaS default", async () => {
    process.env.SENTRY_AUTH_TOKEN = "sntryu_opaque-user-token";
    // No SENTRY_HOST.

    const { captureEnvTokenHost, getEnvTokenHost } = await import(
      "../../../src/lib/env-token-host.js"
    );
    captureEnvTokenHost();

    expect(getEnvTokenHost()).toBe("https://sentry.io");
  });

  test("forged claim url is captured (claim is NOT a security primitive)", async () => {
    // Documents the trust contract: the snapshot picks up whatever the
    // claim says, even if forged. This is acceptable because:
    // - For a legitimate token, the url is authoritative.
    // - For a forged token (user pasted attacker's token), the user
    //   has already authorized the attacker server — out of threat
    //   model.
    process.env.SENTRY_AUTH_TOKEN = mintSntrysToken({
      iat: 1_700_000_000,
      url: "https://evil.com",
      org: "victim",
    });

    const { captureEnvTokenHost, getEnvTokenHost } = await import(
      "../../../src/lib/env-token-host.js"
    );
    captureEnvTokenHost();

    // Yes, the snapshot is evil.com — because that's what the user's
    // token says. If the user trusts the token they pasted, they're
    // trusting that source. The CLI's job is to prevent OTHER inputs
    // (rc files, URL args) from redirecting credentials AWAY from the
    // token's host, not to second-guess the token itself.
    expect(getEnvTokenHost()).toBe("https://evil.com");
  });
});
