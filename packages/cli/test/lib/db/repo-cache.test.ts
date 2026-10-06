/**
 * Tests for the Sentry repository offline cache.
 *
 * The cache is a per-org JSON blob with a TTL — covers cache hit, cache
 * miss (no row), staleness (older than TTL), and corruption resilience.
 */

import { afterEach, describe, expect, test } from "vitest";
import { getDatabase } from "../../../src/lib/db/index.js";
import {
  clearCachedRepos,
  getCachedRepos,
  REPO_CACHE_TTL_MS,
  setCachedRepos,
} from "../../../src/lib/db/repo-cache.js";
import type { SentryRepository } from "../../../src/types/sentry.js";
import { useTestConfigDir } from "../../helpers.js";

useTestConfigDir("test-repo-cache-");

function makeRepo(name: string): SentryRepository {
  return {
    id: "1",
    name,
    url: `https://github.com/${name}`,
    provider: { id: "integrations:github", name: "GitHub" },
    status: "active",
    externalSlug: name,
  } as SentryRepository;
}

afterEach(() => {
  // Each test starts fresh — useTestConfigDir resets the DB.
});

describe("getCachedRepos", () => {
  test("returns null when no row exists", () => {
    expect(getCachedRepos("no-such-org")).toBeNull();
  });

  test("returns the stored list on cache hit", () => {
    const repos = [makeRepo("getsentry/cli"), makeRepo("getsentry/sentry")];
    setCachedRepos("my-org", repos);
    const result = getCachedRepos("my-org");
    expect(result).toHaveLength(2);
    expect(result?.[0]?.name).toBe("getsentry/cli");
    expect(result?.[1]?.name).toBe("getsentry/sentry");
  });

  test("returns null when the row is older than TTL", () => {
    setCachedRepos("aged-org", [makeRepo("foo/bar")]);
    // Manually age the row past the TTL
    const db = getDatabase();
    db.query("UPDATE repo_cache SET cached_at = ? WHERE org_slug = ?").run(
      Date.now() - (REPO_CACHE_TTL_MS + 1000),
      "aged-org"
    );
    expect(getCachedRepos("aged-org")).toBeNull();
  });

  test("returns null when repos_json is corrupted (treats as miss)", () => {
    const db = getDatabase();
    db.query(
      "INSERT INTO repo_cache (org_slug, repos_json, cached_at) VALUES (?, ?, ?)"
    ).run("broken-org", "{not-json", Date.now());
    expect(getCachedRepos("broken-org")).toBeNull();
  });

  test("returns null when repos_json is valid JSON but not an array", () => {
    const db = getDatabase();
    db.query(
      "INSERT INTO repo_cache (org_slug, repos_json, cached_at) VALUES (?, ?, ?)"
    ).run("wrong-shape-org", JSON.stringify({ not: "array" }), Date.now());
    expect(getCachedRepos("wrong-shape-org")).toBeNull();
  });
});

describe("setCachedRepos", () => {
  test("overwrites the existing entry on repeated writes", () => {
    setCachedRepos("my-org", [makeRepo("foo/bar")]);
    setCachedRepos("my-org", [makeRepo("baz/qux"), makeRepo("quux/corge")]);
    const result = getCachedRepos("my-org");
    expect(result).toHaveLength(2);
    expect(result?.[0]?.name).toBe("baz/qux");
  });

  test("stores the full repo payload (round-trip)", () => {
    const original = makeRepo("getsentry/cli");
    setCachedRepos("my-org", [original]);
    const [roundTripped] = getCachedRepos("my-org") ?? [];
    expect(roundTripped).toEqual(original);
  });
});

describe("clearCachedRepos", () => {
  test("removes a single org's entry without affecting others", () => {
    setCachedRepos("org-a", [makeRepo("a/1")]);
    setCachedRepos("org-b", [makeRepo("b/1")]);
    clearCachedRepos("org-a");
    expect(getCachedRepos("org-a")).toBeNull();
    expect(getCachedRepos("org-b")).not.toBeNull();
  });

  test("is a no-op when the entry doesn't exist", () => {
    // Should not throw
    clearCachedRepos("never-existed");
    expect(getCachedRepos("never-existed")).toBeNull();
  });
});
