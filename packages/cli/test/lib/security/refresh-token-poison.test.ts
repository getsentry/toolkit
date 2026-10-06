/**
 * CVE defense-in-depth: OAuth refresh-token credential exfiltration.
 *
 * Attack: if something bypasses the entry-point guards and poisons
 * `env.SENTRY_URL` before the next OAuth refresh fires, the refresh token
 * would previously be POSTed to the attacker's `/oauth/token/` endpoint.
 *
 * Fix: `refreshAccessToken` uses the captured credential host, never the
 * mutable environment URL. Fetch refuses redirects of the refresh request.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  captureEnvTokenHost,
  getEnvTokenHost,
  resetEnvTokenHostForTesting,
} from "../../../src/lib/env-token-host.js";
import { refreshAccessToken } from "../../../src/lib/oauth.js";
import { extractFetchUrl, useEnvSandbox } from "../../helpers.js";

const ENV_KEYS = ["SENTRY_HOST", "SENTRY_URL", "SENTRY_CLIENT_ID"] as const;

describe("CVE defense-in-depth: refresh token", () => {
  useEnvSandbox(ENV_KEYS);

  let fetchCalls: string[];
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    // A client ID is required for refreshAccessToken to proceed past the
    // config check. We want it to reach (and fail at) the host assertion.
    process.env.SENTRY_CLIENT_ID = "test-client-id";
    resetEnvTokenHostForTesting();
    // Intercept fetch to detect any outbound request attempt.
    fetchCalls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchCalls.push(extractFetchUrl(input));
      throw new Error("test: unexpected fetch");
    }) as typeof fetch;
  });

  afterEach(() => {
    resetEnvTokenHostForTesting();
    globalThis.fetch = originalFetch;
  });

  test("refreshAccessToken never sends a refresh token to an env-poisoned URL", async () => {
    // Step 1: simulate boot — capture env-token-host with no SENTRY_URL set
    // (defaults to SaaS, matching a user who got SENTRY_AUTH_TOKEN from their
    // shell without configuring SENTRY_HOST).
    resetEnvTokenHostForTesting();
    captureEnvTokenHost(); // snapshots → SaaS default
    const credentialHost = getEnvTokenHost();

    // Step 2: simulate the bypass — something writes env.SENTRY_URL AFTER
    // the snapshot. This is the attack shape: env got poisoned by a
    // code path that skipped the URL-arg / rc-shim guards.
    process.env.SENTRY_URL = "https://evil.com";

    await expect(
      refreshAccessToken("fake-refresh-token", { credentialHost }),
    ).rejects.toThrow(/unexpected fetch|Cannot connect|fetch failed/);

    // The captured host remains the only destination; evil.com sees nothing.
    expect(fetchCalls).toEqual(["https://sentry.io/oauth/token/"]);
  });

  test("refreshAccessToken proceeds when URL matches token scope", async () => {
    // Pin env-token to the self-hosted instance BEFORE the url is used.
    process.env.SENTRY_HOST = "https://sentry.example.com";
    resetEnvTokenHostForTesting();
    captureEnvTokenHost();
    // Also set SENTRY_URL so getSentryUrl() returns the same host
    process.env.SENTRY_URL = "https://sentry.example.com";

    // Should NOT throw at the host-assertion; the actual fetch will fail
    // with the mock "test: unexpected fetch" error, which is fine — the
    // important thing is that the pre-fetch assertion let us through.
    await expect(
      refreshAccessToken("fake-refresh-token", {
        credentialHost: getEnvTokenHost(),
      }),
    ).rejects.toThrow(/unexpected fetch|Cannot connect|fetch failed/);

    // A request was attempted, and it went to the correct host
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toBe("https://sentry.example.com/oauth/token/");
  });

  test.each([
    ["network", new Error("fetch failed"), "Cannot connect to Sentry at"],
    [
      "TLS",
      new Error("unable to verify the first certificate"),
      "TLS certificate error connecting to",
    ],
  ])(
    "%s refresh failure names the credential host",
    async (_, failure, prefix) => {
      delete process.env.SENTRY_HOST;
      delete process.env.SENTRY_URL;
      const credentialHost = "https://sentry.example.com:8443";
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        fetchCalls.push(extractFetchUrl(input));
        throw failure;
      }) as typeof fetch;

      await expect(
        refreshAccessToken("fake-refresh-token", { credentialHost }),
      ).rejects.toThrow(`${prefix} ${credentialHost}`);
      expect(fetchCalls).toEqual([`${credentialHost}/oauth/token/`]);
    },
  );
});
