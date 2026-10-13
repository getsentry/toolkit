/** Request policies for state polling and mutations with uncertain outcomes. */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createServer } from "node:http";
import { getIdentityFingerprint, setAuthToken } from "../../src/lib/db/auth.js";
import { apiRequestToRegion } from "../../src/lib/api/infrastructure.js";
import { resetAuthenticatedFetch } from "../../src/lib/sentry-client.js";
import {
  getCachedResponse,
  resetCacheState,
} from "../../src/lib/response-cache.js";
import { useEnvSandbox, useTestConfigDir } from "../helpers.js";

useTestConfigDir("request-policy-");
useEnvSandbox([
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
  "SENTRY_FORCE_ENV_TOKEN",
  "SENTRY_NO_CACHE",
]);
const originalFetch = globalThis.fetch;
beforeEach(async () => {
  process.env.SENTRY_AUTH_TOKEN = "";
  process.env.SENTRY_TOKEN = "";
  process.env.SENTRY_FORCE_ENV_TOKEN = "";
  process.env.SENTRY_NO_CACHE = "";
  await setAuthToken("request-policy-token", undefined, undefined, {
    host: "https://sentry.io",
  });
  resetAuthenticatedFetch();
  resetCacheState();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAuthenticatedFetch();
  resetCacheState();
});

test("does not repeat a POST whose server returned 503 after accepting it", async () => {
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return Response.json({ detail: "uncertain outcome" }, { status: 503 });
  };
  await expect(
    apiRequestToRegion(
      "https://sentry.io",
      "/organizations/test/seer/explorer-update/run/",
      {
        method: "POST",
        body: { payload: { type: "user_input_response" } },
        retry: false,
      },
    ),
  ).rejects.toMatchObject({ status: 503 });
  expect(requests).toBe(1);
});

test("does not repeat a POST when the connection drops", async () => {
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new TypeError("fetch failed");
  };
  await expect(
    apiRequestToRegion(
      "https://sentry.io",
      "/organizations/test/seer/explorer-update/run/",
      {
        method: "POST",
        body: { payload: { type: "create_pr" } },
        retry: false,
      },
    ),
  ).rejects.toThrow("fetch failed");
  expect(requests).toBe(1);
});

test("refuses a redirect that would replay a mutation", async () => {
  let starts = 0;
  let replays = 0;
  const server = createServer((req, res) => {
    if (req.url?.endsWith("/start/")) {
      starts++;
      res.writeHead(307, { Location: "/api/0/replayed/" });
      res.end();
    } else {
      replays++;
      res.end(JSON.stringify({ accepted: true }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No server address");
    const host = `http://127.0.0.1:${address.port}`;
    await setAuthToken("request-policy-token", undefined, undefined, { host });
    const realFetch = (
      globalThis as typeof globalThis & { __originalFetch?: typeof fetch }
    ).__originalFetch;
    if (!realFetch) throw new Error("Missing native fetch");
    globalThis.fetch = realFetch;
    await expect(
      apiRequestToRegion(host, "/start/", {
        method: "POST",
        body: { payload: { type: "create_pr" } },
        retry: false,
      }),
    ).rejects.toThrow();
    expect(starts).toBe(1);
    expect(replays).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fresh polling bypasses a previously cached run response", async () => {
  let requests = 0;
  globalThis.fetch = async () =>
    Response.json(
      { status: ++requests === 1 ? "processing" : "completed" },
      {
        headers: { "cache-control": "private, max-age=600" },
      },
    );
  const path = "/organizations/test/seer/explorer-chat/run/";
  await apiRequestToRegion("https://sentry.io", path);
  await vi.waitFor(async () => {
    expect(
      await getCachedResponse(
        "GET",
        `https://sentry.io/api/0${path}`,
        { authorization: "Bearer request-policy-token" },
        getIdentityFingerprint(),
      ),
    ).toBeDefined();
  });
  const { data } = await apiRequestToRegion("https://sentry.io", path, {
    bypassCache: true,
  });
  expect(data).toEqual({ status: "completed" });
  expect(requests).toBe(2);
});
