import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identityCodec as codec } from "./body.js";
import { type CachedFetchOptions, fetchWithCache } from "./fetch.js";
import { buildCacheKey } from "./keys.js";
import { createMemoryStore, type MemoryStore } from "./memory-store.js";
import type { CacheStore } from "./store.js";

const URL = "https://api.example.com/repos/acme/web/pulls/1";
const IDENTITY = "installation:1";
const MINUTE = 60_000;

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

/** A `send` that answers with `responses` in order and records its headers. */
function server(...responses: (Response | Error)[]) {
  const calls: Record<string, string>[] = [];
  const send = vi.fn(async (headers: Record<string, string>) => {
    calls.push(headers);
    const next = responses.shift();
    if (!next) {
      throw new Error("unexpected request");
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  });
  return { send, calls };
}

function read(
  store: CacheStore,
  send: CachedFetchOptions["send"],
  options: Partial<CachedFetchOptions> = {},
): Promise<Response> {
  return fetchWithCache({
    store,
    codec,
    identity: IDENTITY,
    url: URL,
    ttlMs: MINUTE,
    send,
    ...options,
  });
}

let store: MemoryStore;

beforeEach(() => {
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  store = createMemoryStore();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fetchWithCache", () => {
  it("stores a response and serves it with no request while fresh", async () => {
    const { send } = server(json({ v: 1 }));

    expect(await (await read(store, send)).json()).toEqual({ v: 1 });
    expect(await (await read(store, send)).json()).toEqual({ v: 1 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("revalidates a stale entry and serves its body on a 304", async () => {
    const { send, calls } = server(
      json({ v: 1 }, { etag: '"v1"' }),
      new Response(null, { status: 304, headers: { etag: '"v1"' } }),
    );
    await read(store, send, { ttlMs: 0 });

    const response = await read(store, send, { ttlMs: 0 });

    expect(await response.json()).toEqual({ v: 1 });
    expect(calls).toEqual([{}, { "if-none-match": '"v1"' }]);
  });

  it("asks again without validators after a 304 that does not match", async () => {
    const { send, calls } = server(
      json({ v: 1 }, { etag: '"v1"' }),
      new Response(null, { status: 304, headers: { etag: '"other"' } }),
      json({ v: 2 }, { etag: '"v2"' }),
    );
    await read(store, send, { ttlMs: 0 });

    const response = await read(store, send, { ttlMs: 0 });

    expect(await response.json()).toEqual({ v: 2 });
    expect(calls).toEqual([{}, { "if-none-match": '"v1"' }, {}]);
  });

  it.each([
    ["a thrown error", new TypeError("fetch failed")],
    ["a 503", json({ detail: "down" }, {}, 503)],
    ["a 429", json({ detail: "slow down" }, {}, 429)],
  ])("serves the stale entry on %s with staleIfError", async (_, failure) => {
    const createdAt = Date.now();
    const { send } = server(json({ v: 1 }), failure);
    const onStale = vi.fn();
    await read(store, send, { staleIfError: true });
    vi.setSystemTime(Date.now() + 2 * MINUTE);

    const response = await read(store, send, {
      staleIfError: true,
      onStale,
    });

    expect(await response.json()).toEqual({ v: 1 });
    expect(onStale).toHaveBeenCalledWith(createdAt);
  });

  it("passes a failure through without staleIfError", async () => {
    const { send } = server(
      json({ v: 1 }, { etag: '"v1"' }),
      json({ detail: "down" }, {}, 503),
      new TypeError("fetch failed"),
    );
    await read(store, send, { ttlMs: 0 });

    expect((await read(store, send, { ttlMs: 0 })).status).toBe(503);
    await expect(read(store, send, { ttlMs: 0 })).rejects.toThrow(
      "fetch failed",
    );
  });

  it("drops the entry on a client error, so a later failure cannot serve it", async () => {
    const { send } = server(
      json({ v: 1 }),
      json({ message: "Not Found" }, {}, 404),
      json({ detail: "down" }, {}, 503),
    );
    const options = { staleIfError: true, ttlMs: 0 };
    await read(store, send, options);

    expect((await read(store, send, options)).status).toBe(404);
    expect((await read(store, send, options)).status).toBe(503);
    expect(store.stats().entries).toBe(0);
  });

  it("does not store a stale entry it served", async () => {
    const { send } = server(json({ v: 1 }), new TypeError("fetch failed"));
    await read(store, send, { staleIfError: true, ttlMs: 0 });
    const createdAt = (
      await store.get(await buildCacheKey("GET", URL, IDENTITY))
    )?.createdAt;
    vi.setSystemTime(Date.now() + MINUTE);

    await read(store, send, { staleIfError: true, ttlMs: 0 });

    const entry = await store.get(await buildCacheKey("GET", URL, IDENTITY));
    expect(entry?.createdAt).toBe(createdAt);
  });

  it("treats an unreadable entry as a miss and drops it", async () => {
    const key = await buildCacheKey("GET", URL, IDENTITY);
    const { send } = server(json({ v: 1 }), json({ v: 2 }));
    await read(store, send);
    const entry = await store.get(key);
    if (!entry) {
      throw new Error("expected an entry");
    }
    await store.set(key, { ...entry, policy: { v: 999 } }, MINUTE);
    const onCacheError = vi.fn();

    const response = await read(store, send, { onCacheError });

    expect(await response.json()).toEqual({ v: 2 });
    expect(onCacheError).toHaveBeenCalledOnce();
  });

  it("never fails a request when the store fails", async () => {
    const failure = new Error("store down");
    const broken: CacheStore = {
      get: () => Promise.reject(failure),
      set: () => Promise.reject(failure),
      delete: () => Promise.reject(failure),
      deleteMatching: () => Promise.reject(failure),
    };
    const onCacheError = vi.fn();
    const { send } = server(json({ v: 1 }));

    const response = await read(broken, send, { onCacheError });

    expect(await response.json()).toEqual({ v: 1 });
    expect(onCacheError).toHaveBeenCalledWith(failure);
  });

  it("keeps identities apart", async () => {
    const { send } = server(json({ v: "a" }), json({ v: "b" }));
    await read(store, send, { identity: "a" });

    const response = await read(store, send, { identity: "b" });

    expect(await response.json()).toEqual({ v: "b" });
  });
});
