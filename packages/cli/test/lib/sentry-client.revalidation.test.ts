/**
 * Conditional revalidation through the authenticated fetch: a stale cache
 * entry with an `ETag` is sent as `If-None-Match`, and a 304 serves the
 * cached body and renews the entry.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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

useTestConfigDir("revalidation-");

/** A stable-tier URL: reused for 5 minutes without server cache headers. */
const URL = "https://us.sentry.io/api/0/organizations/acme/projects/";
const MINUTE = 60_000;

type Seen = { ifNoneMatch: string | null };

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  originalFetch = globalThis.fetch;
  resetAuthenticatedFetch();
  // Outlives the day-later test, so no refresh is attempted.
  setAuthToken("test-token", 7 * 24 * 3600, "test-refresh");
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
  resetAuthenticatedFetch();
});

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Serve `replies` in order, recording each request's `If-None-Match`. */
function mockApi(...replies: Response[]): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (
    input: Request | string | URL,
    init?: RequestInit,
  ) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    seen.push({ ifNoneMatch: headers.get("if-none-match") });
    const reply = replies.shift();
    if (!reply) {
      throw new Error("Unexpected request");
    }
    return reply;
  }) as typeof fetch;
  return seen;
}

function get(): Promise<Response> {
  return getSdkConfig("https://us.sentry.io").fetch(URL, { method: "GET" });
}

/** Cache `body` as if fetched now, then let it go stale. */
async function cacheThenExpire(
  body: unknown,
  headers: Record<string, string> = {},
): Promise<void> {
  await storeCachedResponse(
    "GET",
    URL,
    { authorization: "Bearer test-token" },
    json(body, headers),
  );
  vi.advanceTimersByTime(6 * MINUTE);
}

describe("conditional revalidation", () => {
  test("a 304 serves the cached body and renews the entry", async () => {
    await cacheThenExpire({ projects: ["web"] }, { etag: '"v1"' });
    const seen = mockApi(
      new Response(null, { status: 304, headers: { etag: '"v1"' } }),
    );

    const response = await get();

    expect(seen).toEqual([{ ifNoneMatch: '"v1"' }]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ projects: ["web"] });

    // The renewed entry is fresh again, so the next read stays local.
    await vi.waitFor(async () => {
      expect(
        await getCachedResponse("GET", URL, {
          authorization: "Bearer test-token",
        }),
      ).toBeDefined();
    });
    expect(await (await get()).json()).toEqual({ projects: ["web"] });
    expect(seen).toHaveLength(1);
  });

  test("a changed resource replaces the cached body", async () => {
    await cacheThenExpire({ projects: ["web"] }, { etag: '"v1"' });
    const seen = mockApi(json({ projects: ["web", "api"] }, { etag: '"v2"' }));

    const response = await get();

    expect(seen).toEqual([{ ifNoneMatch: '"v1"' }]);
    expect(await response.json()).toEqual({ projects: ["web", "api"] });
  });

  test("an entry without an ETag is fetched unconditionally", async () => {
    await cacheThenExpire({ projects: ["web"] });
    const seen = mockApi(json({ projects: ["api"] }));

    expect(await (await get()).json()).toEqual({ projects: ["api"] });
    expect(seen).toEqual([{ ifNoneMatch: null }]);
  });

  test("a 304 for another validator is refetched without one", async () => {
    await cacheThenExpire({ projects: ["web"] }, { etag: '"v1"' });
    const seen = mockApi(
      new Response(null, { status: 304, headers: { etag: '"other"' } }),
      json({ projects: ["api"] }, { etag: '"v2"' }),
    );

    const response = await get();

    expect(seen).toEqual([{ ifNoneMatch: '"v1"' }, { ifNoneMatch: null }]);
    expect(await response.json()).toEqual({ projects: ["api"] });
  });

  test("an entry with an ETag is still revalidated a day later", async () => {
    await cacheThenExpire({ projects: ["web"] }, { etag: '"v1"' });
    vi.advanceTimersByTime(23 * 60 * MINUTE);
    const seen = mockApi(
      new Response(null, { status: 304, headers: { etag: '"v1"' } }),
    );

    expect(await (await get()).json()).toEqual({ projects: ["web"] });
    expect(seen).toEqual([{ ifNoneMatch: '"v1"' }]);
  });
});
