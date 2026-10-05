/**
 * Cached Sentry repository list (per org).
 *
 * Powers `issue resolve --in @commit` — avoids a `GET /organizations/{org}/repos/`
 * round trip on every invocation when the cache is fresh. The cache stores
 * the entire repo list as a JSON blob since the typical lookup pattern is
 * "match git origin → find one repo", not "get one repo by ID".
 *
 * TTL matches other caches (~7 days via {@link CACHE_TTL_MS}). A stale
 * cache is refreshed on the next call path that hits the API anyway.
 */

import type { SentryRepository } from "../../types/index.js";
import { recordCacheHit } from "../telemetry.js";
import { getDatabase } from "./index.js";
import { runUpsert } from "./utils.js";

/**
 * How long cached repo lists are considered fresh. Kept shorter than the
 * project cache (30 days) because repo-to-integration links change more
 * often than project listings do.
 */
export const REPO_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type RepoCacheRow = {
  org_slug: string;
  repos_json: string;
  cached_at: number;
};

/**
 * Fetch the cached repo list for an org. Returns `null` when no cache
 * entry exists or the entry is older than {@link REPO_CACHE_TTL_MS}.
 *
 * Unparseable JSON (from a corrupted or stale schema) is treated as a
 * cache miss — the caller refetches and the broken row is overwritten.
 */
export function getCachedRepos(orgSlug: string): SentryRepository[] | null {
  const db = getDatabase();
  const row = db
    .query("SELECT * FROM repo_cache WHERE org_slug = ?")
    .get(orgSlug) as RepoCacheRow | undefined;

  if (!row) {
    recordCacheHit("repo", false);
    return null;
  }

  const age = Date.now() - row.cached_at;
  if (age > REPO_CACHE_TTL_MS) {
    recordCacheHit("repo", false);
    return null;
  }

  try {
    const repos = JSON.parse(row.repos_json) as SentryRepository[];
    if (!Array.isArray(repos)) {
      recordCacheHit("repo", false);
      return null;
    }
    recordCacheHit("repo", true);
    return repos;
  } catch {
    // Corrupted cache — treat as miss; overwritten on next setCachedRepos.
    recordCacheHit("repo", false);
    return null;
  }
}

/**
 * Upsert the cached repo list for an org. Overwrites the previous entry
 * (there's only ever one row per org).
 */
export function setCachedRepos(
  orgSlug: string,
  repos: SentryRepository[]
): void {
  const db = getDatabase();
  runUpsert(
    db,
    "repo_cache",
    {
      org_slug: orgSlug,
      repos_json: JSON.stringify(repos),
      cached_at: Date.now(),
    },
    ["org_slug"]
  );
}

/** Clear the cached repo list for one org (for tests and manual refresh). */
export function clearCachedRepos(orgSlug: string): void {
  const db = getDatabase();
  db.query("DELETE FROM repo_cache WHERE org_slug = ?").run(orgSlug);
}
