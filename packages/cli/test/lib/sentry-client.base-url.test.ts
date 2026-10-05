import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_SENTRY_URL } from "../../src/lib/constants.js";
import { setAuthToken } from "../../src/lib/db/auth.js";
import { getDatabase } from "../../src/lib/db/index.js";
import { resetEnvTokenHostForTesting } from "../../src/lib/env-token-host.js";
import { ConfigError } from "../../src/lib/errors.js";
import { resolveOrgRegion } from "../../src/lib/region.js";
import {
  getApiBaseUrl,
  getControlSiloUrl,
} from "../../src/lib/sentry-client.js";
import {
  mintSntrysToken,
  mockFetch,
  useEnvSandbox,
  useTestConfigDir,
} from "../helpers.js";

describe("API base URL for org-auth credentials", () => {
  useTestConfigDir("org-auth-base-url-");
  useEnvSandbox([
    "SENTRY_HOST",
    "SENTRY_URL",
    "SENTRY_AUTH_TOKEN",
    "SENTRY_TOKEN",
    "SENTRY_FORCE_ENV_TOKEN",
  ]);
  beforeEach(resetEnvTokenHostForTesting);
  afterEach(resetEnvTokenHostForTesting);

  const claimHost = "http://localhost:8000";
  const orgAuthToken = mintSntrysToken({
    iat: 1,
    org: "synthetic-org",
    url: claimHost,
  });

  test("uses the active org-auth claim host when no URL is configured", () => {
    process.env.SENTRY_AUTH_TOKEN = orgAuthToken;

    expect(getApiBaseUrl()).toBe(claimHost);
    expect(getControlSiloUrl()).toBe(claimHost);
  });

  test("discovers the org region through the claim host", async () => {
    process.env.SENTRY_AUTH_TOKEN = orgAuthToken;
    const originalFetch = globalThis.fetch;
    const requests: Request[] = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return new Response(
        JSON.stringify({
          id: "1568",
          slug: "claim-host-region-org",
          name: "Claim Host Region Org",
          links: { regionUrl: "/" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    try {
      await expect(resolveOrgRegion("claim-host-region-org")).resolves.toBe(
        claimHost
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe(
        `${claimHost}/api/0/organizations/claim-host-region-org/`
      );
      expect(requests[0]?.headers.get("authorization")).toBe(
        `Bearer ${orgAuthToken}`
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("prefers an explicit URL to the claim host", () => {
    process.env.SENTRY_AUTH_TOKEN = orgAuthToken;
    process.env.SENTRY_URL = "https://configured.example.com";

    expect(getApiBaseUrl()).toBe("https://configured.example.com");
    expect(getControlSiloUrl()).toBe("https://configured.example.com");

    process.env.SENTRY_HOST = "https://host.example.com";
    expect(getApiBaseUrl()).toBe("https://host.example.com");
  });

  test("uses the stored login host when an inactive env token has a claim", () => {
    process.env.SENTRY_AUTH_TOKEN = orgAuthToken;
    setAuthToken("stored-token", undefined, undefined, {
      host: "https://stored.example.com",
    });

    expect(getApiBaseUrl()).toBe("https://stored.example.com");
    expect(getControlSiloUrl()).toBe("https://stored.example.com");

    process.env.SENTRY_FORCE_ENV_TOKEN = "1";
    expect(getApiBaseUrl()).toBe(claimHost);
  });

  test("does not migrate a legacy stored login to an inactive token's claim", () => {
    process.env.SENTRY_AUTH_TOKEN = orgAuthToken;
    const db = getDatabase();
    db.query(
      "INSERT OR REPLACE INTO auth (id, token, refresh_token, host, updated_at) VALUES (1, 'stored-token', 'refresh-token', NULL, ?)"
    ).run(Date.now());

    expect(getApiBaseUrl()).toBe(DEFAULT_SENTRY_URL);
    expect(
      (db.query("SELECT host FROM auth WHERE id = 1").get() as { host: string })
        .host
    ).toBe(DEFAULT_SENTRY_URL);
  });

  test("rejects an invalid active org-auth URL claim instead of sending it to SaaS", () => {
    process.env.SENTRY_AUTH_TOKEN = mintSntrysToken({
      iat: 1,
      url: "ftp://invalid.example.com",
    });

    expect(() => getApiBaseUrl()).toThrow(ConfigError);
    expect(() => getControlSiloUrl()).toThrow(ConfigError);
  });

  test("does not validate an inactive environment claim during stored login migration", () => {
    process.env.SENTRY_AUTH_TOKEN = mintSntrysToken({
      iat: 1,
      url: "ftp://invalid.example.com",
    });
    const db = getDatabase();
    db.query(
      "INSERT OR REPLACE INTO auth (id, token, refresh_token, host, updated_at) VALUES (1, 'stored-token', 'refresh-token', NULL, ?)"
    ).run(Date.now());

    expect(getApiBaseUrl()).toBe(DEFAULT_SENTRY_URL);
    expect(
      (db.query("SELECT host FROM auth WHERE id = 1").get() as { host: string })
        .host
    ).toBe(DEFAULT_SENTRY_URL);
  });

  test("keeps SaaS as the fallback without an active custom host", () => {
    expect(getApiBaseUrl()).toBe(DEFAULT_SENTRY_URL);

    process.env.SENTRY_AUTH_TOKEN = "non-org-token";
    expect(getApiBaseUrl()).toBe(DEFAULT_SENTRY_URL);
    expect(getControlSiloUrl()).toBe(DEFAULT_SENTRY_URL);
  });
});
