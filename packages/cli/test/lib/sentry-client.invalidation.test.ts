/**
 * Integration tests for the HTTP-layer auto-invalidation hook.
 *
 * The hook lives in `sentry-client.ts` (`invalidateAfterMutation`)
 * and fires after every successful non-GET at the
 * `authenticatedFetch` seam. Prefix computation is delegated to
 * `computeInvalidationPrefixes`; this file verifies the end-to-end
 * behavior through the real response cache.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { setAuthToken } from "../../src/lib/db/auth.js";
import {
  getCachedResponse,
  storeCachedResponse,
} from "../../src/lib/response-cache.js";
import {
  getSdkConfig,
  resetAuthenticatedFetch,
} from "../../src/lib/sentry-client.js";
import { useTestConfigDir } from "../helpers.js";

useTestConfigDir("invalidation-");

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let originalFetch: typeof globalThis.fetch;
type FetchHandler = (
  input: Request | string | URL,
  init?: RequestInit
) => Promise<Response>;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  resetAuthenticatedFetch();
  setAuthToken("test-token", 3600, "test-refresh");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAuthenticatedFetch();
});

/** Swap `globalThis.fetch` with a deterministic handler for one test. */
function installMockFetch(handler: FetchHandler): void {
  globalThis.fetch = ((input: Request | string | URL, init?: RequestInit) =>
    handler(input, init)) as typeof fetch;
}

/**
 * Run the authenticated fetch. Works because `sentry-client.ts` calls
 * `fetch(...)` as a bare global reference (see `fetchWithTimeout`), so
 * swapping `globalThis.fetch` per-test is observable.
 */
function runAuthenticatedFetch(url: string, method = "GET"): Promise<Response> {
  return getSdkConfig("https://us.sentry.io").fetch(url, { method });
}

const BASE = "https://us.sentry.io/api/0/";
const DETAIL_URL = `${BASE}organizations/acme/issues/12345/`;
const LIST_URL = `${BASE}organizations/acme/issues/`;

describe("HTTP-layer auto-invalidation", () => {
  test("successful non-GET clears cached detail + list entries", async () => {
    await storeCachedResponse(
      "GET",
      DETAIL_URL,
      {},
      makeResponse({ id: "12345" })
    );
    await storeCachedResponse(
      "GET",
      `${LIST_URL}?cursor=abc`,
      {},
      makeResponse({ data: [] })
    );

    installMockFetch(async (input, init) => {
      expect(init?.method).toBe("PUT");
      expect(String(input)).toBe(DETAIL_URL);
      return makeResponse({ id: "12345", status: "resolved" });
    });
    const response = await runAuthenticatedFetch(DETAIL_URL, "PUT");
    expect(response.ok).toBe(true);

    // Invalidation is awaited inside the hook, so the cache is
    // already cleared when the caller sees the response.
    expect(await getCachedResponse("GET", DETAIL_URL, {})).toBeUndefined();
    expect(
      await getCachedResponse("GET", `${LIST_URL}?cursor=abc`, {})
    ).toBeUndefined();
  });

  test("failed non-GET does NOT invalidate the cache", async () => {
    await storeCachedResponse(
      "GET",
      DETAIL_URL,
      {},
      makeResponse({ id: "12345" })
    );

    installMockFetch(async () => makeResponse({ error: "denied" }, 403));
    const response = await runAuthenticatedFetch(DETAIL_URL, "PUT");
    expect(response.status).toBe(403);
    expect(await getCachedResponse("GET", DETAIL_URL, {})).toBeDefined();
  });

  test("GET does NOT invalidate the cache", async () => {
    await storeCachedResponse(
      "GET",
      DETAIL_URL,
      {},
      makeResponse({ id: "12345" })
    );

    installMockFetch(async () => makeResponse({ id: "99999" }));
    await runAuthenticatedFetch(
      `${BASE}organizations/acme/issues/99999/`,
      "GET"
    );
    expect(await getCachedResponse("GET", DETAIL_URL, {})).toBeDefined();
  });

  test("cross-endpoint rule fires for project delete", async () => {
    const orgListUrl = `${BASE}organizations/acme/projects/`;
    await storeCachedResponse(
      "GET",
      `${orgListUrl}?cursor=xyz`,
      {},
      makeResponse({ data: [] })
    );

    installMockFetch(async () => new Response(null, { status: 204 }));
    await runAuthenticatedFetch(`${BASE}projects/acme/frontend/`, "DELETE");

    expect(
      await getCachedResponse("GET", `${orgListUrl}?cursor=xyz`, {})
    ).toBeUndefined();
  });

  test("another identity's cache survives a mutation", async () => {
    setAuthToken("identity-a", 3600, "refresh-a");
    await storeCachedResponse(
      "GET",
      DETAIL_URL,
      {},
      makeResponse({ owner: "a" })
    );

    setAuthToken("identity-b", 3600, "refresh-b");
    installMockFetch(async () => makeResponse({}, 200));
    await runAuthenticatedFetch(DETAIL_URL, "PUT");

    setAuthToken("identity-a", 3600, "refresh-a");
    expect(await getCachedResponse("GET", DETAIL_URL, {})).toBeDefined();
  });
});
