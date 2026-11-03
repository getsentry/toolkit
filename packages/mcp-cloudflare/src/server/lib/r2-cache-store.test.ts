import { env } from "cloudflare:test";
import {
  type CacheEntry,
  createApiTransport,
  createMemoryStore,
  storeResponse,
} from "@sentry/api/client";
import { createBodyCodec } from "@sentry/toolkit-core/response-cache/codec";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sentryMetricsCount } = vi.hoisted(() => ({
  sentryMetricsCount: vi.fn(),
}));

vi.mock("@sentry/cloudflare", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/cloudflare")>()),
  metrics: { count: sentryMetricsCount, gauge: vi.fn() },
}));

import type { Env } from "../types";
import {
  createTieredStore,
  isR2Allowlisted,
  R2_MAX_TTL_MS,
  r2TtlMs,
} from "./r2-cache-store";
import { createResponseCache } from "./response-cache";

const bucket = (env as unknown as Env).MCP_RESPONSE_CACHE_BUCKET as R2Bucket;

const API = "https://us.sentry.io/api/0";
const ORG_EVENT_URL = `${API}/organizations/org/events/backend:0123456789abcdef0123456789abcdef/`;
const TRACE_ITEM_URL = `${API}/projects/org/backend/trace-items/0123456789abcdef/`;
const ISSUES_URL = `${API}/organizations/org/issues/?query=is%3Aunresolved`;
const PRIVATE_5M = "private, max-age=300";
const TOKEN = "sntryu_secret-upstream-token";

function entryWithCacheControl(cacheControl?: string): CacheEntry {
  return {
    url: ORG_EVENT_URL,
    identity: "identity-a",
    tier: "stable",
    status: 200,
    headers: {},
    body: { bytes: new Uint8Array(), encoding: "identity", rawSize: 0 },
    policy: { resh: cacheControl ? { "cache-control": cacheControl } : {} },
    createdAt: Date.now(),
  };
}

describe("isR2Allowlisted", () => {
  it.each([
    [ORG_EVENT_URL, true],
    [TRACE_ITEM_URL, true],
    [`${TRACE_ITEM_URL}?trace_id=abc&item_type=spans`, true],
    [`${ORG_EVENT_URL}?averageColumn=span.duration`, false],
    [`${TRACE_ITEM_URL}?debug=1`, false],
    [`${API}/projects/org/backend/events/0123456789abcdef/`, false],
    [`${API}/organizations/org/issues/1/events/latest/`, false],
    [ISSUES_URL, false],
    ["not a url", false],
  ])("%s → %s", (url, allowed) => {
    expect(isR2Allowlisted(url)).toBe(allowed);
  });
});

describe("r2TtlMs", () => {
  it.each([
    [undefined, 0],
    ["max-age=300", 0],
    ["public, max-age=300", 0],
    ["private", 0],
    ["private, max-age=0", 0],
    ["private, no-cache, max-age=300", 0],
    ["private, max-age=60", 60_000],
    [PRIVATE_5M, R2_MAX_TTL_MS],
    ["Private, Max-Age=3600", R2_MAX_TTL_MS],
  ])("%j → %d", (cacheControl, ttl) => {
    expect(r2TtlMs(entryWithCacheControl(cacheControl))).toBe(ttl);
  });
});

describe("Cache-Control on stored entries", () => {
  it("survives storeResponse, which keeps only Link in headers", async () => {
    const store = createMemoryStore();
    await storeResponse({
      store,
      codec: createBodyCodec(),
      key: "key",
      identity: "identity-a",
      url: ORG_EVENT_URL,
      requestHeaders: {},
      response: Response.json(
        { id: "event-1" },
        { headers: { "Cache-Control": "private, max-age=120" } },
      ),
    });

    const entry = await store.get("key");
    expect(entry).toBeDefined();
    expect(r2TtlMs(entry as CacheEntry)).toBe(120_000);
  });
});

describe("createTieredStore", () => {
  let upstream: ReturnType<typeof vi.fn<typeof fetch>>;
  let pending: Promise<unknown>[] = [];
  const waitUntil = (promise: Promise<unknown>) => {
    pending.push(promise);
  };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    sentryMetricsCount.mockReset();
    pending = [];
    for (const object of (await bucket.list()).objects) {
      await bucket.delete(object.key);
    }
    upstream = vi.fn<typeof fetch>();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Answer every request with `body` and these response headers. */
  function respondWith(body: unknown, headers: Record<string, string> = {}) {
    upstream.mockImplementation(async () =>
      Response.json(body, { headers: { ...headers } }),
    );
  }

  /**
   * One Worker isolate: its own memory store over the shared bucket, and a
   * transport that caches for `identity`.
   */
  function isolate(identity: string) {
    const memory = createMemoryStore();
    const { cache } = createResponseCache({
      store: memory,
      allowlistedStore: createTieredStore({
        memory,
        bucket,
        identity,
        waitUntil,
      }),
      identity,
      apiBaseUrl: "https://sentry.io",
      waitUntil,
    });
    const transport = createApiTransport({
      retry: {
        maxRetries: 0,
        baseDelayMs: 0,
        maxDelayMs: 0,
        maxTotalDelayMs: 0,
      },
      credentials: { current: () => ({ token: TOKEN, identity }) },
      cache,
      fetch: upstream,
    });
    return {
      memory,
      async get(url: string): Promise<unknown> {
        const response = await transport.request(url);
        const body = await response.json();
        // Writes finish in waitUntil, as on a Worker.
        while (pending.length > 0) {
          await Promise.all(pending.splice(0));
        }
        return body;
      },
    };
  }

  async function objectKeys(): Promise<string[]> {
    return (await bucket.list()).objects.map((object) => object.key);
  }

  it("serves an allowlisted response from another isolate", async () => {
    respondWith({ id: "event-1" }, { "Cache-Control": PRIVATE_5M });

    expect(await isolate("identity-a").get(ORG_EVENT_URL)).toEqual({
      id: "event-1",
    });
    expect(upstream).toHaveBeenCalledTimes(1);
    const keys = await objectKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^identity-a\/[0-9a-f]{64}$/);

    const second = isolate("identity-a");
    expect(await second.get(ORG_EVENT_URL)).toEqual({ id: "event-1" });
    expect(upstream).toHaveBeenCalledTimes(1);
    // The R2 hit was copied into the second isolate's memory.
    expect(second.memory.stats().entries).toBe(1);
    expect(sentryMetricsCount).toHaveBeenCalledWith(
      "app.response_cache.r2.lookup",
      1,
      { attributes: { "app.response_cache.result": "hit" } },
    );
  });

  it("never serves one identity's R2 entry to another", async () => {
    respondWith({ id: "event-1" }, { "Cache-Control": PRIVATE_5M });
    await isolate("identity-a").get(ORG_EVENT_URL);

    await isolate("identity-b").get(ORG_EVENT_URL);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect((await objectKeys()).sort()).toEqual([
      expect.stringMatching(/^identity-a\//),
      expect.stringMatching(/^identity-b\//),
    ]);
  });

  it.each([
    ["no server cache headers", {}],
    ["a public response", { "Cache-Control": "public, max-age=300" }],
    ["a zero max-age", { "Cache-Control": "private, max-age=0" }],
  ])("does not write to R2 for %s", async (_, headers) => {
    respondWith({ id: "event-1" }, headers);
    const first = isolate("identity-a");
    await first.get(ORG_EVENT_URL);

    expect(await objectKeys()).toEqual([]);
    expect(upstream).toHaveBeenCalledTimes(1);
    await isolate("identity-a").get(ORG_EVENT_URL);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("keeps an allowlisted response without server headers in memory", async () => {
    respondWith({ id: "event-1" });
    const first = isolate("identity-a");
    await first.get(ORG_EVENT_URL);
    await first.get(ORG_EVENT_URL);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(await objectKeys()).toEqual([]);
  });

  it.each([
    ["an issue list", ISSUES_URL],
    ["an event with averageColumn", `${ORG_EVENT_URL}?averageColumn=x`],
    ["a trace item with debug", `${TRACE_ITEM_URL}?debug=1`],
  ])("keeps %s in memory only", async (_, url) => {
    respondWith({ id: "1" }, { "Cache-Control": PRIVATE_5M });
    const first = isolate("identity-a");
    await first.get(url);
    await first.get(url);

    expect(upstream).toHaveBeenCalledTimes(1);
    expect(await objectKeys()).toEqual([]);
    await isolate("identity-a").get(url);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("persists an allowlisted trace item", async () => {
    respondWith({ itemId: "1" }, { "Cache-Control": PRIVATE_5M });
    await isolate("identity-a").get(TRACE_ITEM_URL);
    expect(await objectKeys()).toHaveLength(1);
  });

  it("enforces the 5-minute cap on read, whatever max-age says", async () => {
    respondWith(
      { id: "event-1" },
      { "Cache-Control": "private, max-age=3600" },
    );
    await isolate("identity-a").get(ORG_EVENT_URL);

    vi.setSystemTime(Date.now() + R2_MAX_TTL_MS - 1000);
    await isolate("identity-a").get(ORG_EVENT_URL);
    expect(upstream).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 2000);
    await isolate("identity-a").get(ORG_EVENT_URL);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(sentryMetricsCount).toHaveBeenCalledWith(
      "app.response_cache.r2.lookup",
      1,
      { attributes: { "app.response_cache.result": "expired" } },
    );
  });

  it("expires at a server max-age shorter than 5 minutes", async () => {
    respondWith({ id: "event-1" }, { "Cache-Control": "private, max-age=60" });
    await isolate("identity-a").get(ORG_EVENT_URL);

    vi.setSystemTime(Date.now() + 61_000);
    await isolate("identity-a").get(ORG_EVENT_URL);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("never persists the raw upstream token", async () => {
    respondWith(
      { id: "event-1" },
      { "Cache-Control": PRIVATE_5M, Vary: "Authorization" },
    );
    await isolate("identity-a").get(ORG_EVENT_URL);

    const [key] = await objectKeys();
    const object = await bucket.get(key ?? "");
    const stored = new TextDecoder().decode(await object?.arrayBuffer());
    expect(stored).not.toContain(TOKEN);
    // The hashed Authorization still matches for the same token.
    await isolate("identity-a").get(ORG_EVENT_URL);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
