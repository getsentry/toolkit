import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useTestConfigDir } from "../helpers.js";

const { customFetch } = vi.hoisted(() => ({ customFetch: vi.fn() }));
vi.mock("../../src/lib/custom-ca.js", () => ({ customFetch }));

import {
  DOCTREE_URL,
  FRESH_FOR_MS,
  loadDocsIndex,
} from "../../src/lib/docs-index.js";
import { CliError } from "../../src/lib/errors.js";

const doctree = readFileSync(
  new URL("../fixtures/docs/doctree.json", import.meta.url),
  "utf8",
);
const ETAG = 'W/"abc123"';
const T0 = 1_700_000_000_000;

function okResponse(): Response {
  return new Response(doctree, { status: 200, headers: { etag: ETAG } });
}

function requestHeaders(call: number): Record<string, string> {
  return customFetch.mock.calls[call]?.[1]?.headers ?? {};
}

const getConfigDir = useTestConfigDir("docs-index-");

let savedNoCache: string | undefined;
let savedNoPersistence: string | undefined;
beforeEach(() => {
  customFetch.mockReset();
  savedNoCache = process.env.SENTRY_NO_CACHE;
  savedNoPersistence = process.env.SENTRY_CLI_NO_PERSISTENCE;
  process.env.SENTRY_NO_CACHE = "0";
  delete process.env.SENTRY_CLI_NO_PERSISTENCE;
});
afterEach(() => {
  process.env.SENTRY_NO_CACHE = savedNoCache;
  if (savedNoPersistence === undefined) {
    delete process.env.SENTRY_CLI_NO_PERSISTENCE;
  } else {
    process.env.SENTRY_CLI_NO_PERSISTENCE = savedNoPersistence;
  }
});

describe("loadDocsIndex", () => {
  test("downloads the doctree once and searches the cached copy after", async () => {
    customFetch.mockResolvedValueOnce(okResponse());

    const first = await loadDocsIndex({ now: T0 });
    const second = await loadDocsIndex({ now: T0 + 60_000 });

    expect(customFetch).toHaveBeenCalledOnce();
    expect(customFetch.mock.calls[0]?.[0]).toBe(DOCTREE_URL);
    expect(first.index.pages.map((page) => page.path)).toContain(
      "/platforms/python/integrations/django",
    );
    expect(second.index).toEqual(first.index);
    expect(second.index.postings.django?.length).toBe(1);
    expect(await readdir(join(getConfigDir(), "cache", "docs"))).toEqual([
      "index-v1.json",
    ]);
  });

  test("revalidates a stale copy with its etag and keeps it on 304", async () => {
    customFetch.mockResolvedValueOnce(okResponse());
    await loadDocsIndex({ now: T0 });

    customFetch.mockResolvedValueOnce(new Response(null, { status: 304 }));
    const stale = await loadDocsIndex({ now: T0 + FRESH_FOR_MS + 1 });
    // The 304 made the copy fresh again.
    await loadDocsIndex({ now: T0 + FRESH_FOR_MS + 2 });

    expect(customFetch).toHaveBeenCalledTimes(2);
    expect(requestHeaders(1)["If-None-Match"]).toBe(ETAG);
    expect(stale.warning).toBeUndefined();
    expect(stale.index.pages.length).toBeGreaterThan(10);
  });

  test("--fresh revalidates a fresh copy", async () => {
    customFetch.mockResolvedValueOnce(okResponse());
    await loadDocsIndex({ now: T0 });

    customFetch.mockResolvedValueOnce(new Response(null, { status: 304 }));
    await loadDocsIndex({ now: T0 + 1, fresh: true });

    expect(customFetch).toHaveBeenCalledTimes(2);
  });

  test("gives a changed index the full download time on a refresh", async () => {
    customFetch.mockResolvedValueOnce(okResponse());
    await loadDocsIndex({ now: T0 });

    // The site answers at once but the new doctree takes 10s to arrive,
    // longer than the revalidation timeout.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      customFetch.mockImplementationOnce(
        async (_url: string, init: RequestInit) => {
          const body = new ReadableStream<Uint8Array>({
            start(stream) {
              setTimeout(() => {
                if (!init.signal?.aborted) {
                  stream.enqueue(new TextEncoder().encode(doctree));
                  stream.close();
                }
              }, 10_000);
              init.signal?.addEventListener("abort", () =>
                stream.error(init.signal?.reason),
              );
            },
          });
          return new Response(body, { status: 200, headers: { etag: "new" } });
        },
      );
      const loading = loadDocsIndex({
        now: T0 + FRESH_FOR_MS + 1,
        fresh: true,
      });
      // Reading the cache is real file I/O; wait for the request first.
      while (customFetch.mock.calls.length < 2) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      await vi.advanceTimersByTimeAsync(10_000);
      const loaded = await loading;
      expect(loaded.warning).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }

    // The new copy was saved, so the next search does not fetch again.
    await loadDocsIndex({ now: T0 + FRESH_FOR_MS + 2 });
    expect(customFetch).toHaveBeenCalledTimes(2);
  });

  test("falls back quickly when the site does not answer a refresh", async () => {
    customFetch.mockResolvedValueOnce(okResponse());
    await loadDocsIndex({ now: T0 });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      customFetch.mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) =>
            init.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason),
            ),
          ),
      );
      const loading = loadDocsIndex({ now: T0 + FRESH_FOR_MS + 1 });
      while (customFetch.mock.calls.length < 2) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      await vi.advanceTimersByTimeAsync(3000);
      const loaded = await loading;
      expect(loaded.warning).toContain("Could not refresh the docs index");
    } finally {
      vi.useRealTimers();
    }
  });

  test("serves the stale copy with a warning when the refresh fails", async () => {
    customFetch.mockResolvedValueOnce(okResponse());
    await loadDocsIndex({ now: T0 });

    customFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    const loaded = await loadDocsIndex({ now: T0 + 3 * FRESH_FOR_MS });

    expect(loaded.warning).toBe(
      "Could not refresh the docs index; using a copy from 18 hours ago.",
    );
    expect(loaded.index.pages.length).toBeGreaterThan(10);
  });

  test("fails with an API error when there is no copy to fall back to", async () => {
    customFetch.mockResolvedValueOnce(new Response("nope", { status: 503 }));

    const error = await loadDocsIndex({ now: T0 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain("HTTP 503");
  });

  test("SENTRY_NO_CACHE=1 downloads every time and writes nothing", async () => {
    process.env.SENTRY_NO_CACHE = "1";
    customFetch.mockImplementation(async () => okResponse());

    await loadDocsIndex({ now: T0 });
    await loadDocsIndex({ now: T0 + 1 });

    expect(customFetch).toHaveBeenCalledTimes(2);
    expect(requestHeaders(1)["If-None-Match"]).toBeUndefined();
    await expect(
      readdir(join(getConfigDir(), "cache", "docs")),
    ).rejects.toThrow();
  });

  test("writes nothing with persistence off, as in the SDK", async () => {
    process.env.SENTRY_CLI_NO_PERSISTENCE = "1";
    customFetch.mockImplementation(async () => okResponse());

    const loaded = await loadDocsIndex({ now: T0 });

    expect(loaded.index.pages.length).toBeGreaterThan(0);
    await expect(
      readdir(join(getConfigDir(), "cache", "docs")),
    ).rejects.toThrow();
  });
});
