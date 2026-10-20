import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { getIdentityFingerprint, setAuthToken } from "../../src/lib/db/auth.js";
import {
  getCachedResponse,
  resetCacheState,
} from "../../src/lib/response-cache.js";
import {
  getSdkConfig,
  resetAuthenticatedFetch,
} from "../../src/lib/sentry-client.js";
import { useEnvSandbox, useTestConfigDir } from "../helpers.js";

useTestConfigDir("refresh-cache-focused-");
useEnvSandbox([
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
  "SENTRY_FORCE_ENV_TOKEN",
  "SENTRY_NO_CACHE",
]);
const originalFetch = globalThis.fetch;
const url = "https://sentry.io/api/0/organizations/refresh-cache-focused/";

beforeEach(() => {
  for (const key of [
    "SENTRY_AUTH_TOKEN",
    "SENTRY_TOKEN",
    "SENTRY_FORCE_ENV_TOKEN",
    "SENTRY_NO_CACHE",
  ]) {
    delete process.env[key];
  }
  resetCacheState();
  resetAuthenticatedFetch();
  setAuthToken("old-access", 3600, "stable-refresh", {
    host: "https://sentry.io",
  });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetCacheState();
  resetAuthenticatedFetch();
});

test("401 refresh caches GET under the bearer actually sent on retry", async () => {
  const requests: string[] = [];
  globalThis.fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/oauth/token/")) {
        return Response.json({
          access_token: "new-access",
          refresh_token: "stable-refresh",
          expires_in: 3600,
          token_type: "bearer",
        });
      }
      requests.push(request.headers.get("authorization") ?? "");
      if (requests.length === 1) {
        return Response.json({ detail: "expired" }, { status: 401 });
      }
      return Response.json(
        { id: "refresh-cache-focused" },
        {
          headers: {
            "cache-control": "private, max-age=60",
            vary: "authorization",
          },
        },
      );
    },
  );
  const response = await getSdkConfig("https://sentry.io").fetch(url);
  expect(await response.json()).toEqual({ id: "refresh-cache-focused" });
  expect(requests).toEqual(["Bearer old-access", "Bearer new-access"]);
  await vi.waitFor(async () => {
    const cached = await getCachedResponse(
      "GET",
      url,
      { authorization: "Bearer new-access" },
      getIdentityFingerprint(),
    );
    expect(cached).toBeDefined();
  });
});
