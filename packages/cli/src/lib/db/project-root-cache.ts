/**
 * Project Root Cache
 *
 * Caches cwd → projectRoot mappings to avoid expensive directory walks.
 * Uses mtime-based invalidation: if the cwd directory's mtime changes
 * (files added/removed), the cache is invalidated.
 *
 * TTL: 24 hours as a safety net for edge cases (NFS clock skew, etc.)
 */

import { stat } from "node:fs/promises";
import type { ProjectRootReason } from "../dsn/project-root.js";
import { recordCacheHit } from "../telemetry.js";
import { getDatabase, maybeCleanupCaches } from "./index.js";
import { runUpsert } from "./utils.js";

/** Cache TTL in milliseconds (24 hours) */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Row type matching the project_root_cache table schema */
type ProjectRootCacheRow = {
  cwd: string;
  project_root: string;
  reason: string;
  cwd_mtime: number;
  cached_at: number;
  ttl_expires_at: number;
};

/** Cached project root entry */
export type CachedProjectRoot = {
  projectRoot: string;
  reason: ProjectRootReason;
};

/** Input for setting a project root cache entry */
export type ProjectRootCacheEntry = {
  projectRoot: string;
  reason: ProjectRootReason;
};

/**
 * Get cached project root for a directory if valid.
 *
 * Validation checks:
 * 1. TTL not expired (24h max age)
 * 2. cwd directory mtime hasn't changed (files added/removed)
 *
 * @param cwd - Directory to look up
 * @returns Cached project root or undefined if not cached/invalid
 */
export async function getCachedProjectRoot(
  cwd: string
): Promise<CachedProjectRoot | undefined> {
  const db = getDatabase();

  const row = db
    .query("SELECT * FROM project_root_cache WHERE cwd = ?")
    .get(cwd) as ProjectRootCacheRow | undefined;

  if (!row) {
    recordCacheHit("project-root", false);
    return;
  }

  const now = Date.now();

  // Check TTL expiration
  if (now > row.ttl_expires_at) {
    // Cache expired, delete it
    db.query("DELETE FROM project_root_cache WHERE cwd = ?").run(cwd);
    recordCacheHit("project-root", false);
    return;
  }

  // Check if cwd directory mtime has changed
  try {
    const stats = await stat(cwd);
    const currentMtime = Math.floor(stats.mtimeMs);

    if (currentMtime !== row.cwd_mtime) {
      // Directory structure changed, invalidate cache
      db.query("DELETE FROM project_root_cache WHERE cwd = ?").run(cwd);
      recordCacheHit("project-root", false);
      return;
    }
  } catch {
    // Directory doesn't exist or can't stat - invalidate cache
    db.query("DELETE FROM project_root_cache WHERE cwd = ?").run(cwd);
    recordCacheHit("project-root", false);
    return;
  }

  recordCacheHit("project-root", true);
  return {
    projectRoot: row.project_root,
    reason: row.reason as ProjectRootReason,
  };
}

/**
 * Store project root lookup result in cache.
 *
 * @param cwd - Directory that was looked up
 * @param entry - Project root result to cache
 */
export async function setCachedProjectRoot(
  cwd: string,
  entry: ProjectRootCacheEntry
): Promise<void> {
  const db = getDatabase();
  const now = Date.now();

  // Get current mtime of the cwd directory
  let cwdMtime: number;
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const stats = await stat(cwd);
    cwdMtime = Math.floor(stats.mtimeMs);
  } catch {
    // Can't stat directory - don't cache
    return;
  }

  runUpsert(
    db,
    "project_root_cache",
    {
      cwd,
      project_root: entry.projectRoot,
      reason: entry.reason,
      cwd_mtime: cwdMtime,
      cached_at: now,
      ttl_expires_at: now + CACHE_TTL_MS,
    },
    ["cwd"]
  );

  maybeCleanupCaches();
}

/**
 * Clear all project root cache entries.
 */
export async function clearProjectRootCache(): Promise<void> {
  const db = getDatabase();
  db.query("DELETE FROM project_root_cache").run();
}

/**
 * Clear project root cache for a specific directory.
 *
 * @param cwd - Directory to clear cache for
 */
export async function clearProjectRootCacheFor(cwd: string): Promise<void> {
  const db = getDatabase();
  db.query("DELETE FROM project_root_cache WHERE cwd = ?").run(cwd);
}
