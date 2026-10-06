/**
 * CVE defense-in-depth: OAuth refresh-token credential exfiltration.
 *
 * Attack: if something bypasses the entry-point guards and poisons
 * `env.SENTRY_URL` before the next OAuth refresh fires, the refresh token
 * would previously be POSTed to the attacker's `/oauth/token/` endpoint.
 *
 * Fix: `refreshAccessToken` calls `assertRefreshHostTrusted()` before
 * building the request body, which throws `CliError` on mismatch.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  captureEnvTokenHost,
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

  test("refreshAccessToken throws before fetch when env.SENTRY_URL is poisoned after boot", async () => {
    // Step 1: simulate boot — capture env-token-host with no SENTRY_URL set
    // (defaults to SaaS, matching a user who got SENTRY_AUTH_TOKEN from their
    // shell without configuring SENTRY_HOST).
    resetEnvTokenHostForTesting();
    captureEnvTokenHost(); // snapshots → SaaS default

    // Step 2: simulate the bypass — something writes env.SENTRY_URL AFTER
    // the snapshot. This is the attack shape: env got poisoned by a
    // code path that skipped the URL-arg / rc-shim guards.
    process.env.SENTRY_URL = "https://evil.com";

    // `refreshAccessToken` throws synchronously from its host-scope guard
    // (before returning the promise from withHttpSpan). Handle both shapes.
    let thrown: unknown;
    try {
      await refreshAccessToken("fake-refresh-token");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(
      /does not match|sentry auth login --url/
    );

    // Critical: zero outbound requests to evil.com (or anywhere).
    expect(fetchCalls).toEqual([]);
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
    await expect(refreshAccessToken("fake-refresh-token")).rejects.toThrow(
      /unexpected fetch|Cannot connect|fetch failed/
    );

    // A request was attempted, and it went to the correct host
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toBe("https://sentry.example.com/oauth/token/");
  });
});
