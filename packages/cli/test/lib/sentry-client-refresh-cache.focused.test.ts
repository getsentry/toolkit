/** Request-owned cache entries across session changes and OAuth refresh. */

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { getIdentityFingerprint, setAuthToken } from "../../src/lib/db/auth.js";
import { withEnv } from "../../src/lib/env.js";
import { getCachedResponse } from "../../src/lib/response-cache.js";
import { getSdkConfig } from "../../src/lib/sentry-client.js";
import { mockFetch, useEnvSandbox, useTestConfigDir } from "../helpers.js";

useTestConfigDir("refresh-cache-focused-");
useEnvSandbox([
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
  "SENTRY_FORCE_ENV_TOKEN",
  "SENTRY_NO_CACHE",
  "SENTRY_HOST",
  "SENTRY_URL",
  "SENTRY_CUSTOM_HEADERS",
]);
const HOST = "https://synthetic.example.invalid";
const URL = `${HOST}/api/0/organizations/synthetic-org/projects/`;

beforeEach(() => {
  setAuthToken("old-access", 3600, "stable-refresh", { host: HOST });
});
afterEach(() => vi.unstubAllGlobals());

function requestBody() {
  return withEnv({ ...process.env }, async () => {
    const response = await getSdkConfig(HOST).fetch(URL);
    return response.json();
  });
}

async function expectCached(identity: string, token: string): Promise<void> {
  // Cache writes happen in the background; wait for the entry itself.
  await expect
    .poll(async () => {
      const cached = await getCachedResponse("GET", URL, {
        headers: { authorization: `Bearer ${token}` },
        identity,
      });
      return cached?.json();
    })
    .toEqual({ token });
}

test.each(["stable-refresh", "rotated-refresh"])(
  "401 retry caches the actual bearer under the pinned identity with %s",
  async (refreshToken) => {
    const identity = getIdentityFingerprint();
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      mockFetch(async (input, init) => {
        const request = new Request(input, init);
        if (request.url === `${HOST}/oauth/token/`) {
          expect(
            new URLSearchParams(await request.text()).get("refresh_token"),
          ).toBe("stable-refresh");
          return Response.json({
            access_token: "new-access",
            refresh_token: refreshToken,
            expires_in: 3600,
            token_type: "bearer",
          });
        }
        const token =
          request.headers.get("authorization")?.slice("Bearer ".length) ?? "";
        requests.push(token);
        if (token === "old-access") {
          return Response.json({ detail: "expired" }, { status: 401 });
        }
        return Response.json(
          { token },
          {
            headers: {
              "cache-control": "private, max-age=60",
              vary: "authorization",
            },
          },
        );
      }),
    );

    expect(await requestBody()).toEqual({ token: "new-access" });
    await expectCached(identity, "new-access");
    expect(requests).toEqual(["old-access", "new-access"]);

    // A rotated session warms a new identity; a stable one reuses the retry's entry.
    expect(await requestBody()).toEqual({ token: "new-access" });
    const currentIdentity = withEnv({ ...process.env }, getIdentityFingerprint);
    await expectCached(currentIdentity, "new-access");
    expect(await requestBody()).toEqual({ token: "new-access" });
    expect(requests).toEqual(
      refreshToken === "stable-refresh"
        ? ["old-access", "new-access"]
        : ["old-access", "new-access", "new-access"],
    );
  },
);

test("a pending response stays in the cache of the session that sent it", async () => {
  const identity = getIdentityFingerprint();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    mockFetch(async (input, init) => {
      const token =
        new Request(input, init).headers
          .get("authorization")
          ?.slice("Bearer ".length) ?? "";
      requests.push(token);
      if (token === "old-access") {
        started.resolve();
        await release.promise;
      }
      // No Vary: credential isolation must hold independently of server headers.
      return Response.json(
        { token },
        { headers: { "cache-control": "private, max-age=60" } },
      );
    }),
  );

  const pending = requestBody();
  try {
    await started.promise;
    setAuthToken("other-access", 3600, "other-refresh", { host: HOST });
    release.resolve();
    expect(await pending).toEqual({ token: "old-access" });
    await expectCached(identity, "old-access");
    expect(await requestBody()).toEqual({ token: "other-access" });
    await expectCached(getIdentityFingerprint(), "other-access");
    setAuthToken("old-access", 3600, "stable-refresh", { host: HOST });
    expect(await requestBody()).toEqual({ token: "old-access" });
    expect(requests).toEqual(["old-access", "other-access"]);
  } finally {
    release.resolve();
    await Promise.allSettled([pending]);
  }
});
