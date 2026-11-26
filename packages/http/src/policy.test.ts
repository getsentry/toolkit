import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identityCodec as codec } from "./body.js";
import { createMemoryStore } from "./memory-store.js";
import {
  type CacheLookup,
  type FreshnessOptions,
  lookupResponse,
  REVALIDATION_WINDOW_MS,
  storeResponse,
} from "./policy.js";
import type { CacheEntry, CacheStore } from "./store.js";

const URL = "https://api.example.com/repos/acme/web/";
const IDENTITY = "identity-a";
const KEY = "key-a";
const MINUTE = 60_000;
const TTL = 5 * MINUTE;
const BODY = { data: [{ id: 1, slug: "frontend" }] };

function json(
  body: unknown,
  headers: Record<string, string> = {},
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function notModified(headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 304, headers });
}

async function store(
  cache: CacheStore,
  response: Response,
  freshness: Partial<FreshnessOptions> = {},
): Promise<number> {
  return await storeResponse({
    ttlMs: TTL,
    ...freshness,
    store: cache,
    codec,
    key: KEY,
    identity: IDENTITY,
    url: URL,
    requestHeaders: {},
    response,
  });
}

async function lookup(
  cache: CacheStore,
  freshness: Partial<FreshnessOptions> = {},
): Promise<CacheLookup | undefined> {
  return await lookupResponse({
    ttlMs: TTL,
    ...freshness,
    store: cache,
    codec,
    key: KEY,
    url: URL,
    requestHeaders: {},
  });
}

/**
 * `cache`, but keeping every entry for an hour, so the policy rather than
 * the store's expiry decides freshness.
 */
function longLived(cache: CacheStore): CacheStore {
  return { ...cache, set: (key, entry) => cache.set(key, entry, 60 * MINUTE) };
}

/** A memory store that records the TTL of every `set`. */
function recordingStore(): CacheStore & { ttls: number[] } {
  const inner = createMemoryStore();
  const ttls: number[] = [];
  return {
    ttls,
    get: (key) => inner.get(key),
    set: (key, entry, ttlMs) => {
      ttls.push(ttlMs);
      return inner.set(key, entry, ttlMs);
    },
    delete: (key) => inner.delete(key),
    deleteMatching: (identity, prefix) =>
      inner.deleteMatching(identity, prefix),
  };
}

function expectStale(
  result: CacheLookup | undefined,
): Extract<CacheLookup, { kind: "stale" }> {
  if (result?.kind !== "stale") {
    throw new Error(`expected a stale lookup, got ${result?.kind}`);
  }
  return result;
}

beforeEach(() => {
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("storeResponse", () => {
  it("stores a response that a hit serves back", async () => {
    const cache = createMemoryStore();
    const link = `<${URL}?cursor=0:100:0>; rel="next"`;
    const size = await store(cache, json(BODY, { link, "x-other": "kept" }));
    expect(size).toBeGreaterThan(0);

    const result = await lookup(cache);
    expect(result?.kind).toBe("hit");
    if (result?.kind !== "hit") {
      return;
    }
    expect(result.response.status).toBe(200);
    expect(await result.response.json()).toEqual(BODY);
    expect(result.response.headers.get("link")).toBe(link);
    expect(result.response.headers.get("content-type")).toBe(
      "application/json",
    );
    expect(result.createdAt).toBe(Date.now());
    expect(result.size).toBe(JSON.stringify(BODY).length);

    const entry = (await cache.get(KEY)) as CacheEntry;
    expect(entry).toMatchObject({
      url: URL,
      identity: IDENTITY,
      headers: { link },
    });
  });

  it("never persists the authorization token, and still varies on it", async () => {
    const cache = createMemoryStore();
    const token = "Bearer secret-token";
    const withToken = (authorization: string) => ({
      ttlMs: TTL,
      store: cache,
      codec,
      key: KEY,
      url: URL,
      requestHeaders: { authorization },
    });
    await storeResponse({
      ...withToken(token),
      identity: IDENTITY,
      response: json(BODY, {
        "cache-control": "private, max-age=60",
        vary: "Authorization",
      }),
    });

    const entry = (await cache.get(KEY)) as CacheEntry;
    expect(JSON.stringify(entry.policy)).not.toContain("secret-token");
    expect((await lookupResponse(withToken(token)))?.kind).toBe("hit");
    expect(
      await lookupResponse(withToken("Bearer other-token")),
    ).toBeUndefined();
  });

  it.each<[string, Response, Partial<FreshnessOptions>]>([
    [
      "Cache-Control: no-store",
      json(BODY, { "cache-control": "no-store" }),
      {},
    ],
    ["a non-2xx status", json({ detail: "Not found" }, {}, 404), {}],
    ["a zero TTL without a validator", json(BODY), { ttlMs: 0 }],
  ])("does not store %s", async (_, response, freshness) => {
    const cache = createMemoryStore();
    expect(await store(cache, response, freshness)).toBe(0);
    expect(await cache.get(KEY)).toBeUndefined();
  });

  it("stores any body, and only JSON with requireJson", async () => {
    const cache = createMemoryStore();
    const html = () =>
      new Response("<html></html>", {
        headers: { "content-type": "text/html" },
      });
    expect(await store(cache, html())).toBeGreaterThan(0);

    await cache.delete(KEY);
    await expect(
      storeResponse({
        ttlMs: TTL,
        store: cache,
        codec,
        key: KEY,
        identity: IDENTITY,
        url: URL,
        requestHeaders: {},
        response: html(),
        requireJson: true,
      }),
    ).rejects.toThrow(SyntaxError);
    expect(await cache.get(KEY)).toBeUndefined();
  });

  it("keeps an entry for the caller's TTL without server directives", async () => {
    const cache = recordingStore();
    await store(cache, json(BODY));
    await store(cache, json(BODY), { ttlMs: MINUTE });
    expect(cache.ttls).toEqual([TTL, MINUTE]);
  });

  it("keeps an entry with a validator for the retention window too", async () => {
    const cache = recordingStore();
    await store(cache, json(BODY, { etag: '"v1"' }));
    await store(
      cache,
      json(BODY, { "last-modified": new Date().toUTCString() }),
    );
    await store(
      cache,
      json(BODY, { etag: '"v1"', "cache-control": "private, max-age=60" }),
    );
    await store(cache, json(BODY, { etag: '"v1"' }), { retainMs: MINUTE });
    expect(cache.ttls).toEqual([
      TTL + REVALIDATION_WINDOW_MS,
      TTL + REVALIDATION_WINDOW_MS,
      MINUTE + REVALIDATION_WINDOW_MS,
      TTL + MINUTE,
    ]);
  });

  it("keeps an entry without a validator for the window with staleIfError", async () => {
    const cache = recordingStore();
    await store(cache, json(BODY), { staleIfError: true, retainMs: MINUTE });
    expect(cache.ttls).toEqual([TTL + MINUTE]);
  });

  it("caps the server's max-age at the caller's TTL unless maxTtlMs raises it", async () => {
    const cache = recordingStore();
    const longLivedResponse = () =>
      json(BODY, { "cache-control": "private, max-age=3600" });
    await store(cache, longLivedResponse());
    await store(cache, longLivedResponse(), { maxTtlMs: Infinity });
    expect(cache.ttls).toEqual([TTL, 3_600_000]);
  });
});

describe("lookupResponse freshness", () => {
  it("misses when there is no entry", async () => {
    expect(await lookup(createMemoryStore())).toBeUndefined();
  });

  it("serves an entry without server directives for the caller's TTL", async () => {
    const cache = createMemoryStore();
    await store(longLived(cache), json(BODY));

    vi.setSystemTime(Date.now() + TTL - 1);
    expect((await lookup(cache))?.kind).toBe("hit");

    vi.setSystemTime(Date.now() + 1);
    expect(await lookup(cache)).toBeUndefined();
  });

  it("revalidates every read with a zero TTL", async () => {
    const cache = createMemoryStore();
    await store(cache, json(BODY, { etag: '"v1"' }), { ttlMs: 0 });
    expect((await lookup(cache, { ttlMs: 0 }))?.kind).toBe("stale");
  });

  it("does not let server max-age outlast the caller's TTL", async () => {
    const cache = createMemoryStore();
    const response = json(BODY, {
      "cache-control": "private, max-age=600",
      etag: '"v1"',
    });
    await store(cache, response, { ttlMs: 0 });
    expect((await lookup(cache, { ttlMs: 0 }))?.kind).toBe("stale");
  });

  it("lets server max-age outlast the TTL with maxTtlMs", async () => {
    const cache = createMemoryStore();
    const freshness = { ttlMs: MINUTE, maxTtlMs: Infinity };
    await store(
      cache,
      json(BODY, { "cache-control": "private, max-age=600" }),
      freshness,
    );
    vi.setSystemTime(Date.now() + 5 * MINUTE);
    expect((await lookup(cache, freshness))?.kind).toBe("hit");
  });

  it("lets server max-age shorten the caller's TTL", async () => {
    const cache = createMemoryStore();
    await store(
      longLived(cache),
      json(BODY, { "cache-control": "private, max-age=60", etag: '"v1"' }),
    );
    vi.setSystemTime(Date.now() + 2 * MINUTE);
    expect((await lookup(cache))?.kind).toBe("stale");
  });

  it("treats max-age=0 as stale rather than falling back to the TTL", async () => {
    const cache = createMemoryStore();
    await store(
      cache,
      json(BODY, { "cache-control": "max-age=0", etag: '"v1"' }),
    );
    expect((await lookup(cache))?.kind).toBe("stale");
  });

  it("misses for a body this runtime cannot decode", async () => {
    const cache = createMemoryStore();
    await store(cache, json(BODY));
    const entry = (await cache.get(KEY)) as CacheEntry;
    await cache.set(
      KEY,
      { ...entry, body: { ...entry.body, dictId: "unknown" } },
      MINUTE,
    );
    expect(await lookup(cache)).toBeUndefined();
  });

  it("throws for a corrupt policy", async () => {
    const cache = createMemoryStore();
    await store(cache, json(BODY));
    const entry = (await cache.get(KEY)) as CacheEntry;
    await cache.set(KEY, { ...entry, policy: { v: 999 } }, MINUTE);
    await expect(lookup(cache)).rejects.toThrow();
  });
});

describe("lookupResponse revalidation", () => {
  async function staleEntry(
    cache: CacheStore,
    headers: Record<string, string> = { etag: '"v1"' },
  ): Promise<void> {
    await store(cache, json(BODY, headers));
    vi.setSystemTime(Date.now() + TTL + MINUTE);
  }

  it("misses for a stale entry without a validator", async () => {
    const cache = createMemoryStore();
    await staleEntry(longLived(cache), {});
    expect(await lookup(cache)).toBeUndefined();
  });

  it("sends If-None-Match and serves the cached body on a matching 304", async () => {
    const cache = createMemoryStore();
    await staleEntry(cache);

    const stale = expectStale(await lookup(cache));
    expect(stale.conditionalHeaders).toEqual({ "if-none-match": '"v1"' });
    expect(stale.serveStale).toBeUndefined();

    const response = await stale.revalidate(notModified({ etag: '"v1"' }));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual(BODY);

    // The renewed entry is fresh again.
    await vi.waitFor(async () => {
      expect((await lookup(cache))?.kind).toBe("hit");
    });
  });

  it("sends If-Modified-Since for an entry with only Last-Modified", async () => {
    const cache = createMemoryStore();
    const lastModified = new Date(Date.now() - MINUTE).toUTCString();
    await staleEntry(cache, { "last-modified": lastModified });

    const stale = expectStale(await lookup(cache));
    expect(stale.conditionalHeaders).toEqual({
      "if-modified-since": lastModified,
    });
    const response = await stale.revalidate(
      notModified({ "last-modified": lastModified }),
    );
    expect(await response?.json()).toEqual(BODY);
  });

  it.each([
    ["a 200", json({ data: [] }, { etag: '"v2"' })],
    ["a 304 for another ETag", notModified({ etag: '"v2"' })],
  ])("returns undefined for %s", async (_, response) => {
    const cache = createMemoryStore();
    await staleEntry(cache);
    const stale = expectStale(await lookup(cache));
    expect(await stale.revalidate(response)).toBeUndefined();
  });

  it("reports a failed renewal and still serves the body", async () => {
    const cache = createMemoryStore();
    await staleEntry(cache);
    const failure = new Error("disk full");
    const failing: CacheStore = {
      ...cache,
      set: () => Promise.reject(failure),
    };
    const onRenewError = vi.fn();

    const stale = expectStale(
      await lookupResponse({
        ttlMs: TTL,
        store: failing,
        codec,
        key: KEY,
        url: URL,
        requestHeaders: {},
        onRenewError,
      }),
    );
    const response = await stale.revalidate(notModified({ etag: '"v1"' }));
    expect(await response?.json()).toEqual(BODY);
    await vi.waitFor(() => expect(onRenewError).toHaveBeenCalledWith(failure));
  });
});

describe("lookupResponse with staleIfError", () => {
  it("returns a stale entry without a validator so it can serve on errors", async () => {
    const cache = createMemoryStore();
    const createdAt = Date.now();
    await store(cache, json(BODY), { staleIfError: true });
    vi.setSystemTime(Date.now() + TTL + MINUTE);

    const stale = expectStale(await lookup(cache, { staleIfError: true }));
    expect(stale.conditionalHeaders).toEqual({});
    expect(stale.createdAt).toBe(createdAt);
    expect(await stale.revalidate(notModified())).toBeUndefined();

    const response = await stale.serveStale?.();
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual(BODY);
  });
});

describe("lookupResponse with Vary", () => {
  async function storeVarying(
    cache: CacheStore,
    vary: string,
    requestHeaders: Record<string, string>,
  ): Promise<void> {
    await storeResponse({
      ttlMs: TTL,
      staleIfError: true,
      store: cache,
      codec,
      key: KEY,
      identity: IDENTITY,
      url: URL,
      requestHeaders,
      response: json(BODY, { vary }),
    });
  }

  function lookupWith(
    cache: CacheStore,
    requestHeaders: Record<string, string>,
  ): Promise<CacheLookup | undefined> {
    return lookupResponse({
      ttlMs: TTL,
      staleIfError: true,
      store: cache,
      codec,
      key: KEY,
      url: URL,
      requestHeaders,
    });
  }

  it("serves an entry without server directives only to a matching request", async () => {
    const cache = createMemoryStore();
    await storeVarying(cache, "Accept", { accept: "application/json" });

    expect(
      (await lookupWith(cache, { accept: "application/json" }))?.kind,
    ).toBe("hit");
    expect(await lookupWith(cache, { accept: "text/html" })).toBeUndefined();
  });

  it("does not offer another variant as stale", async () => {
    const cache = createMemoryStore();
    await storeVarying(cache, "Accept", { accept: "application/json" });
    vi.setSystemTime(Date.now() + TTL + MINUTE);

    expect(await lookupWith(cache, { accept: "text/html" })).toBeUndefined();
    expect(
      (await lookupWith(cache, { accept: "application/json" }))?.kind,
    ).toBe("stale");
  });

  it("matches no request for Vary: *", async () => {
    const cache = createMemoryStore();
    await storeVarying(cache, "*", {});

    expect(await lookupWith(cache, {})).toBeUndefined();
  });
});

describe("null-body statuses", () => {
  it("serves a cached 204 with a null body", async () => {
    const cache = createMemoryStore();
    await store(cache, new Response(null, { status: 204 }));

    const hit = await lookup(cache);
    if (hit?.kind !== "hit") {
      throw new Error(`expected a hit, got ${hit?.kind}`);
    }
    expect(hit.response.status).toBe(204);
    expect(hit.response.body).toBeNull();
  });
});

describe("storeResponse body release", () => {
  it.each([
    ["Cache-Control: no-store", json(BODY, { "cache-control": "no-store" })],
    ["a non-2xx status", json({ detail: "Not found" }, {}, 404)],
  ])("cancels the body it does not store for %s", async (_, response) => {
    const cancel = vi.spyOn(response.body as ReadableStream, "cancel");

    expect(await store(createMemoryStore(), response)).toBe(0);
    expect(cancel).toHaveBeenCalled();
  });
});
