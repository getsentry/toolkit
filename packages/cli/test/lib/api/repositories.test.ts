/**
 * Tests for the cached repository helper.
 *
 * Covers the cache-hit / cache-miss paths and the resilience guard that
 * keeps a broken SQLite write from crashing a command whose primary API
 * fetch already succeeded (established project pattern — see AGENTS.md
 * lore on cache-write resilience).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { listRepositoriesCached } from "../../../src/lib/api/repositories.js";
import { setAuthToken } from "../../../src/lib/db/auth.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as repoCache from "../../../src/lib/db/repo-cache.js";
import type { SentryRepository } from "../../../src/types/sentry.js";
import { mockFetch, useTestConfigDir } from "../../helpers.js";

function repoApiResponse(repos: { name: string }[]): Response {
  const body = repos.map((r) => ({
    id: r.name,
    name: r.name,
    url: `https://github.com/${r.name}`,
    provider: { id: "github", name: "GitHub" },
    status: "active",
  }));
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      Link: '<https://sentry.io/end>; rel="next"; results="false"; cursor=""',
    },
  });
}

describe("listRepositoriesCached", () => {
  useTestConfigDir("repo-cache-");
  let originalFetch: typeof globalThis.fetch;
  let getSpy: ReturnType<typeof spyOn>;
  let setSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setAuthToken("test-token", 3600, "test-refresh");
    originalFetch = globalThis.fetch;
    getSpy = vi.spyOn(repoCache, "getCachedRepos");
    setSpy = vi.spyOn(repoCache, "setCachedRepos");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    getSpy.mockRestore();
    setSpy.mockRestore();
  });

  test("returns cached list without hitting the API on cache hit", async () => {
    const cached: SentryRepository[] = [
      { id: "1", name: "owner/cached" } as unknown as SentryRepository,
    ];
    getSpy.mockReturnValue(cached);
    let fetchCalled = false;
    globalThis.fetch = mockFetch(async () => {
      fetchCalled = true;
      return new Response("[]");
    });

    const result = await listRepositoriesCached("my-org");
    expect(result).toBe(cached);
    expect(fetchCalled).toBe(false);
    expect(setSpy).not.toHaveBeenCalled();
  });

  test("refetches and writes cache on cache miss", async () => {
    getSpy.mockReturnValue(null);
    setSpy.mockImplementation(() => {
      /* succeed silently */
    });
    globalThis.fetch = mockFetch(async () =>
      repoApiResponse([{ name: "owner/fresh" }])
    );

    const result = await listRepositoriesCached("my-org");
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("owner/fresh");
    expect(setSpy).toHaveBeenCalledWith(
      "my-org",
      expect.arrayContaining([expect.objectContaining({ name: "owner/fresh" })])
    );
  });

  test("does NOT crash when cache write throws (resilience)", async () => {
    getSpy.mockReturnValue(null);
    setSpy.mockImplementation(() => {
      // Simulate a read-only DB / corrupted SQLite write
      throw new Error("attempt to write a readonly database");
    });
    globalThis.fetch = mockFetch(async () =>
      repoApiResponse([{ name: "owner/primary-succeeded" }])
    );

    // The API fetch succeeded, so the command should still receive the
    // data even though the cache write failed. No exception should escape.
    const result = await listRepositoriesCached("my-org");
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("owner/primary-succeeded");
  });
});
