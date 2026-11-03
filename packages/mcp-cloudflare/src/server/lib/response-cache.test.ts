import {
  type CacheEntry,
  createMemoryStore,
} from "@sentry/toolkit-core/api-client/response-cache";
import { ENTRY_OVERHEAD_BYTES } from "@sentry/toolkit-core/api-client/response-cache/memory-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { logInfo, sentryMetricsCount, sentryMetricsGauge } = vi.hoisted(() => ({
  logInfo: vi.fn(),
  sentryMetricsCount: vi.fn(),
  sentryMetricsGauge: vi.fn(),
}));

vi.mock("@sentry/mcp-core/telem/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/mcp-core/telem/logging")>()),
  logInfo,
}));

vi.mock("@sentry/cloudflare", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/cloudflare")>()),
  metrics: { count: sentryMetricsCount, gauge: sentryMetricsGauge },
}));

import { SentryApiService } from "@sentry/mcp-core/api-client";
import { issueFixture } from "@sentry/mcp-server-mocks/payloads";
import {
  createMeteredMemoryStore,
  createResponseCache,
  getGrantCacheIdentity,
  getResponseCache,
  resolveResponseCacheMode,
} from "./response-cache";

const USERS: Record<string, { id: string; name: string; email: string }> = {
  "Bearer token-a": { id: "1", name: "User A", email: "a@example.com" },
  "Bearer token-b": { id: "2", name: "User B", email: "b@example.com" },
};

/**
 * Answers `/api/0/auth/` with the user the Authorization header belongs to,
 * and issue reads and writes with an issue fixture.
 */
function mockSentryApi() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const user = USERS[request.headers.get("Authorization") ?? ""];
      if (!user) {
        return new Response("{}", { status: 401 });
      }
      if (new URL(request.url).pathname.includes("/issues/")) {
        return Response.json(issueFixture);
      }
      return Response.json(user);
    });
}

function lookups(result: string): number {
  return sentryMetricsCount.mock.calls.filter(
    ([name, , options]) =>
      name === "app.response_cache.lookup" &&
      options?.attributes?.["app.response_cache.result"] === result,
  ).length;
}

describe("resolveResponseCacheMode", () => {
  it.each([
    [undefined, "off"],
    ["", "off"],
    ["off", "off"],
    ["on", "off"],
    ["true", "off"],
    ["memory", "memory"],
    [" Memory ", "memory"],
    ["tiered", "tiered"],
  ])("maps %j to %s", (value, mode) => {
    expect(resolveResponseCacheMode(value)).toBe(mode);
  });
});

describe("getGrantCacheIdentity", () => {
  it("is stable for a grant and differs across users and grants", async () => {
    const identity = await getGrantCacheIdentity("user-1", "grant-1");
    expect(identity).toMatch(/^[0-9a-f]{64}$/);
    expect(await getGrantCacheIdentity("user-1", "grant-1")).toBe(identity);
    expect(await getGrantCacheIdentity("user-1", "grant-2")).not.toBe(identity);
    expect(await getGrantCacheIdentity("user-2", "grant-1")).not.toBe(identity);
    // A separator in one ID cannot make two pairs collide.
    expect(await getGrantCacheIdentity("a:b", "c")).not.toBe(
      await getGrantCacheIdentity("a", "b:c"),
    );
  });
});

describe("createResponseCache", () => {
  let fetchSpy: ReturnType<typeof mockSentryApi>;
  const pending: Promise<unknown>[] = [];
  const waitUntil = (promise: Promise<unknown>) => {
    pending.push(promise);
  };

  beforeEach(() => {
    sentryMetricsCount.mockReset();
    sentryMetricsGauge.mockReset();
    fetchSpy = mockSentryApi();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    pending.length = 0;
  });

  async function apiFor(
    token: string,
    identity: string,
    store: ReturnType<typeof createMemoryStore>,
  ) {
    return new SentryApiService({
      accessToken: token,
      responseCache: createResponseCache({
        store,
        identity,
        apiBaseUrl: "https://sentry.io",
        waitUntil,
      }),
    });
  }

  async function whoami(api: SentryApiService) {
    const user = await api.getAuthenticatedUser();
    // Writes finish in waitUntil, as on a Worker.
    await Promise.all(pending);
    return user;
  }

  it("never serves one identity's entry to another for the same URL", async () => {
    const store = createMemoryStore();
    const identityA = await getGrantCacheIdentity("user-1", "grant-a");
    const identityB = await getGrantCacheIdentity("user-1", "grant-b");
    const apiA = await apiFor("token-a", identityA, store);
    const apiB = await apiFor("token-b", identityB, store);

    expect(await whoami(apiA)).toMatchObject({ email: "a@example.com" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await whoami(apiA)).toMatchObject({ email: "a@example.com" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Same URL, same isolate store, other identity: a miss, not A's body.
    expect(await whoami(apiB)).toMatchObject({ email: "b@example.com" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(await whoami(apiB)).toMatchObject({ email: "b@example.com" });
    expect(await whoami(apiA)).toMatchObject({ email: "a@example.com" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    expect(store.stats().entries).toBe(2);
    expect(lookups("miss")).toBe(2);
    expect(lookups("hit")).toBe(3);
  });

  it("invalidates only the writing identity's entries", async () => {
    const store = createMemoryStore();
    const apiA = await apiFor("token-a", "identity-a", store);
    const apiB = await apiFor("token-b", "identity-b", store);
    const issue = { organizationSlug: "org", issueId: "CLOUDFLARE-MCP-41" };
    await apiA.getIssue(issue);
    await apiB.getIssue(issue);
    await Promise.all(pending);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    await apiA.updateIssue({ ...issue, status: "resolved" });
    fetchSpy.mockClear();

    await apiB.getIssue(issue);
    expect(fetchSpy).not.toHaveBeenCalled();
    await apiA.getIssue(issue);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not read or keep a non-JSON body", async () => {
    const store = createMemoryStore();
    const { cache } = createResponseCache({
      store,
      identity: "identity-a",
      apiBaseUrl: "https://sentry.io",
      waitUntil,
    });
    await cache.store(
      { url: "https://sentry.io/api/0/x/", requestHeaders: {}, identity: "" },
      new Response("plain text", { headers: { "Content-Type": "text/plain" } }),
    );
    expect(store.stats().entries).toBe(0);
  });
});

describe("createMeteredMemoryStore", () => {
  beforeEach(() => {
    sentryMetricsCount.mockReset();
    sentryMetricsGauge.mockReset();
    logInfo.mockReset();
  });

  function entry(size: number): CacheEntry {
    return {
      url: "https://sentry.io/api/0/x/",
      identity: "identity-a",
      tier: "stable",
      status: 200,
      headers: {},
      body: {
        bytes: new Uint8Array(size),
        encoding: "identity",
        rawSize: size,
      },
      policy: {},
      createdAt: Date.now(),
    };
  }

  it("reports each write, its usage, and every eviction", async () => {
    const entrySize = 100 + ENTRY_OVERHEAD_BYTES;
    const store = createMeteredMemoryStore(entrySize * 2);
    for (const key of ["a", "b", "c", "d"]) {
      await store.set(key, entry(100), 60_000);
    }

    expect(sentryMetricsGauge).toHaveBeenLastCalledWith(
      "app.response_cache.memory.entries",
      2,
    );
    expect(sentryMetricsGauge).toHaveBeenCalledWith(
      "app.response_cache.memory.bytes",
      entrySize * 2,
    );
    expect(
      sentryMetricsCount.mock.calls.filter(
        ([name]) => name === "app.response_cache.eviction",
      ),
    ).toHaveLength(2);
    expect(sentryMetricsCount).toHaveBeenCalledWith(
      "app.response_cache.write",
      1,
      { attributes: { "app.response_cache.encoding": "identity" } },
    );
    // The budget is logged once per store, not on every eviction.
    expect(logInfo).toHaveBeenCalledTimes(1);
    expect(logInfo).toHaveBeenCalledWith(
      "Response cache reached its memory budget",
      expect.objectContaining({
        extra: expect.objectContaining({ budgetBytes: entrySize * 2 }),
      }),
    );
  });
});

describe("getResponseCache", () => {
  const options = {
    userId: "user-1",
    grantId: "grant-1",
    sentryHost: "sentry.io",
    waitUntil: () => {},
  };

  it("is off unless a mode enables it", async () => {
    expect(await getResponseCache({ ...options, mode: "off" })).toBeUndefined();
  });

  it("scopes the cache to the grant", async () => {
    const cache = await getResponseCache({ ...options, mode: "memory" });
    expect(cache?.identity).toBe(
      await getGrantCacheIdentity("user-1", "grant-1"),
    );
  });
});
