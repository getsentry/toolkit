import { describe, expect, it, vi } from "vitest";
import { resolveCachedRegion } from "./region-cache.js";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("resolveCachedRegion", () => {
  it("starts the lookup before its source credentials can change", async () => {
    const cache = new Map<string, Promise<string>>();
    const source = { accessToken: "first" };
    const lookup = vi.fn(async () => source.accessToken);

    const result = resolveCachedRegion(cache, "org", lookup);
    source.accessToken = "second";

    expect(await result).toBe("first");
    expect(lookup).toHaveBeenCalledOnce();
  });

  it("shares a pending lookup and caches a successful result", async () => {
    const cache = new Map<string, Promise<string | null>>();
    const pending = deferred<string | null>();
    const lookup = vi.fn(() => pending.promise);

    const first = resolveCachedRegion(cache, "org", lookup);
    const second = resolveCachedRegion(cache, "org", lookup);
    expect(second).toBe(first);

    pending.resolve(null);
    expect(await Promise.all([first, second])).toEqual([null, null]);
    expect(await resolveCachedRegion(cache, "org", lookup)).toBeNull();
    expect(lookup).toHaveBeenCalledOnce();
  });

  it("evicts failures so later lookups can retry", async () => {
    const cache = new Map<string, Promise<string>>();
    const lookup = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue("https://us.sentry.io");

    const first = resolveCachedRegion(cache, "org", lookup);
    const second = resolveCachedRegion(cache, "org", lookup);
    expect(second).toBe(first);
    await expect(first).rejects.toThrow("offline");
    expect(await resolveCachedRegion(cache, "org", lookup)).toBe(
      "https://us.sentry.io",
    );
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("evicts non-cacheable results without deleting a replacement", async () => {
    const cache = new Map<string, Promise<string>>();
    const pending = deferred<string>();
    const first = resolveCachedRegion(
      cache,
      "org",
      () => pending.promise,
      () => false,
    );
    const replacement = Promise.resolve("https://de.sentry.io");
    cache.set("org", replacement);

    pending.resolve("fallback");
    expect(await first).toBe("fallback");
    expect(cache.get("org")).toBe(replacement);
  });

  it("evicts a failed cacheability check", async () => {
    const cache = new Map<string, Promise<string>>();
    const lookup = vi.fn(async () => "region");
    const first = resolveCachedRegion(cache, "org", lookup, () => {
      throw new Error("invalid cache state");
    });

    await expect(first).rejects.toThrow("invalid cache state");
    expect(await resolveCachedRegion(cache, "org", lookup)).toBe("region");
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});
