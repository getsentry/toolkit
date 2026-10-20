/**
 * Cached project information storage (by orgId:projectId or DSN public key).
 */

import type { CachedProject } from "../../types/index.js";
import { recordCacheHit } from "../telemetry.js";
import { getDatabase, maybeCleanupCaches } from "./index.js";
import { runUpsert, touchCacheEntry } from "./utils.js";

type ProjectCacheRow = {
  cache_key: string;
  org_slug: string;
  org_name: string;
  project_slug: string;
  project_name: string;
  project_id?: string;
  cached_at: number;
  last_accessed: number;
};

function projectCacheKey(orgId: string, projectId: string): string {
  return `${orgId}:${projectId}`;
}

function dsnCacheKey(publicKey: string): string {
  return `dsn:${publicKey}`;
}

function rowToCachedProject(row: ProjectCacheRow): CachedProject {
  return {
    orgSlug: row.org_slug,
    orgName: row.org_name,
    projectSlug: row.project_slug,
    projectName: row.project_name,
    projectId: row.project_id,
    cachedAt: row.cached_at,
  };
}

/** Shared get implementation — looks up by pre-computed cache key. */
function getByKey(key: string): CachedProject | undefined {
  const db = getDatabase();
  const row = db
    .query("SELECT * FROM project_cache WHERE cache_key = ?")
    .get(key) as ProjectCacheRow | undefined;

  if (!row) {
    recordCacheHit("project", false);
    return;
  }

  recordCacheHit("project", true);
  touchCacheEntry("project_cache", "cache_key", key);
  return rowToCachedProject(row);
}

/** Shared set implementation — writes by pre-computed cache key. */
function setByKey(key: string, info: Omit<CachedProject, "cachedAt">): void {
  const db = getDatabase();
  const now = Date.now();

  runUpsert(
    db,
    "project_cache",
    {
      cache_key: key,
      org_slug: info.orgSlug,
      org_name: info.orgName,
      project_slug: info.projectSlug,
      project_name: info.projectName,
      project_id: info.projectId ?? null,
      cached_at: now,
      last_accessed: now,
    },
    ["cache_key"],
  );

  maybeCleanupCaches();
}

export function getCachedProject(
  orgId: string,
  projectId: string,
): CachedProject | undefined {
  return getByKey(projectCacheKey(orgId, projectId));
}

export function setCachedProject(
  orgId: string,
  projectId: string,
  info: Omit<CachedProject, "cachedAt">,
): void {
  setByKey(projectCacheKey(orgId, projectId), info);
}

/** Get cached project by DSN public key (for self-hosted or SaaS DSNs without org ID). */
export function getCachedProjectByDsnKey(
  publicKey: string,
): CachedProject | undefined {
  return getByKey(dsnCacheKey(publicKey));
}

/** Cache project by DSN public key (for self-hosted or SaaS DSNs without org ID). */
export function setCachedProjectByDsnKey(
  publicKey: string,
  info: Omit<CachedProject, "cachedAt">,
): void {
  setByKey(dsnCacheKey(publicKey), info);
}

/**
 * Look up a cached project by organization and project slug.
 *
 * Returns the most recently cached entry matching the (org_slug, project_slug)
 * pair across ALL cache key shapes (`orgId:projectId`, `dsn:publicKey`,
 * `list:{org}/{project}`). This is useful for slug-based lookups where the
 * caller doesn't know the numeric org/project IDs upfront — e.g., when
 * resolving `<org>/<project>` from CLI arguments in `fetchProjectId`.
 *
 * Uses `MAX(cached_at)` with a covariant SELECT: SQLite guarantees the other
 * columns come from the row that produced the MAX value. This avoids the
 * ambiguity that would arise from a plain `LIMIT 1` without an ORDER BY.
 *
 * @param orgSlug - Organization slug (case-sensitive)
 * @param projectSlug - Project slug (case-sensitive)
 * @returns Cached project entry, or undefined if no match
 */
export function getCachedProjectBySlug(
  orgSlug: string,
  projectSlug: string,
): CachedProject | undefined {
  const db = getDatabase();
  const row = db
    .query(
      "SELECT cache_key, org_slug, org_name, project_slug, project_name, project_id, MAX(cached_at) AS cached_at, last_accessed FROM project_cache WHERE org_slug = ? AND project_slug = ?",
    )
    .get(orgSlug, projectSlug) as ProjectCacheRow | undefined;

  // When no rows match, SQLite still returns a single row with NULL columns
  // because of the MAX aggregate — guard on cache_key being populated.
  if (!row?.cache_key) {
    recordCacheHit("project", false);
    return;
  }

  recordCacheHit("project", true);
  touchCacheEntry("project_cache", "cache_key", row.cache_key);
  return rowToCachedProject(row);
}

/**
 * Look up a project ID within an organization slug across all cache key shapes.
 * Reuses entries populated by project discovery even when the caller only has
 * the project's numeric ID, as with a DSN and a cached organization slug.
 */
export function getCachedProjectById(
  orgSlug: string,
  projectId: string,
): CachedProject | undefined {
  const db = getDatabase();
  const row = db
    .query(
      "SELECT * FROM project_cache WHERE org_slug = ? AND project_id = ? ORDER BY cached_at DESC, cache_key LIMIT 1",
    )
    .get(orgSlug, projectId) as ProjectCacheRow | undefined;

  recordCacheHit("project", !!row);
  if (!row) {
    return;
  }

  touchCacheEntry("project_cache", "cache_key", row.cache_key);
  return rowToCachedProject(row);
}

/**
 * Get cached project slugs for a specific organization.
 *
 * Used by shell completions to suggest projects within a known org.
 * Matches on `org_slug` (case-sensitive) and deduplicates by project slug.
 *
 * @param orgSlug - The organization slug to filter by
 */
export function getCachedProjectsForOrg(
  orgSlug: string,
): { projectSlug: string; projectName: string }[] {
  const db = getDatabase();
  // Use MAX(cached_at) to deterministically pick the most recently cached
  // project_name when the same project appears under different cache keys
  // (e.g., both orgId:projectId and dsn:publicKey).
  // SQLite guarantees that non-aggregated columns come from the row that
  // produced the MAX/MIN aggregate value.
  const rows = db
    .query(
      "SELECT project_slug, project_name, MAX(cached_at) FROM project_cache WHERE org_slug = ? GROUP BY project_slug",
    )
    .all(orgSlug) as Pick<ProjectCacheRow, "project_slug" | "project_name">[];

  return rows.map((row) => ({
    projectSlug: row.project_slug,
    projectName: row.project_name,
  }));
}

/**
 * Batch-cache projects for an organization.
 *
 * Called from `listProjects()` at the API layer so every command that
 * lists projects (project list, findProjectsByPattern, etc.) automatically
 * seeds the completion cache. Follows the `setOrgRegions()` pattern.
 *
 * @param orgSlug - Organization slug
 * @param orgName - Organization display name
 * @param projects - Projects to cache (id, slug, name from SentryProject)
 */
export function cacheProjectsForOrg(
  orgSlug: string,
  orgName: string,
  projects: Array<{ id: string; slug: string; name: string }>,
): void {
  if (projects.length === 0) {
    return;
  }

  const db = getDatabase();
  const now = Date.now();

  db.transaction(() => {
    for (const p of projects) {
      runUpsert(
        db,
        "project_cache",
        {
          cache_key: `list:${orgSlug}/${p.slug}`,
          org_slug: orgSlug,
          org_name: orgName,
          project_slug: p.slug,
          project_name: p.name,
          project_id: p.id,
          cached_at: now,
          last_accessed: now,
        },
        ["cache_key"],
      );
    }
  })();

  maybeCleanupCaches();
}

export function clearProjectCache(): void {
  const db = getDatabase();
  db.query("DELETE FROM project_cache").run();
}
