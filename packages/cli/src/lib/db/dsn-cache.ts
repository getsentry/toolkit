/**
 * Cached DSN detection results storage (per directory).
 *
 * Supports two cache modes:
 * 1. Single DSN cache (original) - Used by detectDsn()
 * 2. Full detection cache (v4) - Used by detectAllDsns() with mtime validation
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  CachedDsnEntry,
  DetectedDsn,
  ResolvedProjectInfo,
} from "../dsn/types.js";
import { recordCacheHit } from "../telemetry.js";
import { getDatabase, maybeCleanupCaches } from "./index.js";
import { safeParseJson } from "./json.js";
import { runUpsert, touchCacheEntry } from "./utils.js";

/** Cache TTL in milliseconds (24 hours) */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Module-level flag to disable DSN cache reads.
 * When true, getCachedDsn() and getCachedDetection() return undefined.
 * Cache writes still proceed so the re-scanned result gets stored.
 */
let dsnCacheDisabled = false;

/**
 * Disable DSN cache reads for this invocation.
 * Called when `--fresh` is set to force a full re-scan.
 */
export function disableDsnCache(): void {
  dsnCacheDisabled = true;
}

/**
 * Re-enable DSN cache reads after `disableDsnCache()` was called.
 * Only needed in tests to prevent one test's `--fresh` flag from
 * leaking into subsequent tests.
 */
export function enableDsnCache(): void {
  dsnCacheDisabled = false;
}

/** Row type matching the dsn_cache table schema (including v4 columns) */
type DsnCacheRow = {
  directory: string;
  dsn: string;
  project_id: string;
  org_id: string | null;
  source: string;
  source_path: string | null;
  resolved_org_slug: string | null;
  resolved_org_name: string | null;
  resolved_project_slug: string | null;
  resolved_project_name: string | null;
  // v4 columns for full detection caching
  fingerprint: string | null;
  all_dsns_json: string | null;
  source_mtimes_json: string | null;
  dir_mtimes_json: string | null;
  root_dir_mtime: number | null;
  ttl_expires_at: number | null;
  cached_at: number;
  last_accessed: number;
};

/** Full detection cache entry (v4) */
export type CachedDetection = {
  /** Pre-computed fingerprint for alias validation */
  fingerprint: string;
  /** All detected DSNs */
  allDsns: DetectedDsn[];
  /** Map of source file paths to their mtimes (files only) */
  sourceMtimes: Record<string, number>;
  /** Map of scanned directory paths to their mtimes (for detecting new files) */
  dirMtimes: Record<string, number>;
  /** mtime of the project root directory */
  rootDirMtime: number;
  /** When the cache expires (TTL) */
  ttlExpiresAt: number;
};

/** Input for storing a full detection result */
export type DetectionCacheEntry = {
  /** Pre-computed fingerprint */
  fingerprint: string;
  /** All detected DSNs */
  allDsns: DetectedDsn[];
  /** Map of source file paths to their mtimes (files only) */
  sourceMtimes: Record<string, number>;
  /** Map of scanned directory paths to their mtimes (for detecting new files) */
  dirMtimes: Record<string, number>;
  /** mtime of the project root directory */
  rootDirMtime: number;
};

function rowToCachedDsnEntry(row: DsnCacheRow): CachedDsnEntry {
  const entry: CachedDsnEntry = {
    dsn: row.dsn,
    projectId: row.project_id,
    orgId: row.org_id ?? undefined,
    source: row.source as CachedDsnEntry["source"],
    sourcePath: row.source_path ?? undefined,
    cachedAt: row.cached_at,
  };

  if (row.resolved_org_slug && row.resolved_project_slug) {
    entry.resolved = {
      orgSlug: row.resolved_org_slug,
      orgName: row.resolved_org_name ?? "",
      projectSlug: row.resolved_project_slug,
      projectName: row.resolved_project_name ?? "",
    };
  }

  // Parse allResolved from all_dsns_json for inferred sources
  if (row.source === "inferred" && row.all_dsns_json) {
    // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    try {
      entry.allResolved = JSON.parse(
        row.all_dsns_json
      ) as CachedDsnEntry["allResolved"];
    } catch {
      // Ignore parse errors, allResolved will be undefined
    }
  }

  return entry;
}

export function getCachedDsn(directory: string): CachedDsnEntry | undefined {
  if (dsnCacheDisabled) {
    return;
  }

  const db = getDatabase();

  const row = db
    .query("SELECT * FROM dsn_cache WHERE directory = ?")
    .get(directory) as DsnCacheRow | undefined;

  if (!row) {
    recordCacheHit("dsn", false);
    return;
  }

  // Rows written by setCachedDetection() with an empty allDsns array store
  // dsn="" and project_id="". Treat these as cache misses for the single-DSN
  // path — callers expect a usable DSN when the result is defined.
  if (!row.dsn) {
    recordCacheHit("dsn", false);
    return;
  }

  recordCacheHit("dsn", true);
  touchCacheEntry("dsn_cache", "directory", directory);
  return rowToCachedDsnEntry(row);
}

export function setCachedDsn(
  directory: string,
  entry: Omit<CachedDsnEntry, "cachedAt">
): void {
  const db = getDatabase();
  const now = Date.now();

  runUpsert(
    db,
    "dsn_cache",
    {
      directory,
      dsn: entry.dsn,
      project_id: entry.projectId,
      org_id: entry.orgId ?? null,
      source: entry.source,
      source_path: entry.sourcePath ?? null,
      resolved_org_slug: entry.resolved?.orgSlug ?? null,
      resolved_org_name: entry.resolved?.orgName ?? null,
      resolved_project_slug: entry.resolved?.projectSlug ?? null,
      resolved_project_name: entry.resolved?.projectName ?? null,
      // Store allResolved in all_dsns_json for inferred sources
      all_dsns_json: entry.allResolved
        ? JSON.stringify(entry.allResolved)
        : null,
      cached_at: now,
      last_accessed: now,
    },
    ["directory"]
  );

  maybeCleanupCaches();
}

/** Update resolved org/project info after API resolution. */
export function updateCachedResolution(
  directory: string,
  resolved: ResolvedProjectInfo
): void {
  const db = getDatabase();

  const exists = db
    .query("SELECT 1 FROM dsn_cache WHERE directory = ?")
    .get(directory);
  if (!exists) {
    return;
  }

  db.query(`
    UPDATE dsn_cache SET
      resolved_org_slug = ?,
      resolved_org_name = ?,
      resolved_project_slug = ?,
      resolved_project_name = ?,
      last_accessed = ?
    WHERE directory = ?
  `).run(
    resolved.orgSlug,
    resolved.orgName,
    resolved.projectSlug,
    resolved.projectName,
    Date.now(),
    directory
  );
}

export function clearDsnCache(directory?: string): void {
  const db = getDatabase();

  if (directory) {
    db.query("DELETE FROM dsn_cache WHERE directory = ?").run(directory);
  } else {
    db.query("DELETE FROM dsn_cache").run();
  }
}

// =============================================================================
// Full Detection Cache (v4) - mtime-based validation
// =============================================================================

/**
 * Validate a single directory mtime.
 * @returns True if mtime matches, false if changed or missing
 */
async function validateDirMtime(
  fullPath: string,
  cachedMtime: number
): Promise<boolean> {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const stats = await stat(fullPath);
    return Math.floor(stats.mtimeMs) === cachedMtime;
  } catch {
    return false;
  }
}

/**
 * Validate a single file mtime.
 * @returns True if mtime matches, false if changed or missing
 */
async function validateFileMtime(
  fullPath: string,
  cachedMtime: number
): Promise<boolean> {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const stats = await stat(fullPath);
    if (!stats.isFile()) {
      return false;
    }
    return Math.floor(stats.mtimeMs) === cachedMtime;
  } catch {
    return false;
  }
}

/**
 * Validate that cached source file mtimes still match.
 *
 * @param projectRoot - Project root directory
 * @param sourceMtimes - Map of relative file paths to cached mtimes
 * @returns True if all file mtimes match, false if any changed or missing
 */
async function validateSourceMtimes(
  projectRoot: string,
  sourceMtimes: Record<string, number>
): Promise<boolean> {
  for (const [relativePath, cachedMtime] of Object.entries(sourceMtimes)) {
    const fullPath = join(projectRoot, relativePath);
    if (!(await validateFileMtime(fullPath, cachedMtime))) {
      return false;
    }
  }
  return true;
}

/**
 * Validate that cached directory mtimes still match.
 * Used to detect when new files are added to scanned directories.
 *
 * @param projectRoot - Project root directory
 * @param dirMtimes - Map of relative directory paths to cached mtimes
 * @returns True if all directory mtimes match, false if any changed
 */
async function validateDirMtimes(
  projectRoot: string,
  dirMtimes: Record<string, number>
): Promise<boolean> {
  for (const [relativePath, cachedMtime] of Object.entries(dirMtimes)) {
    const fullPath = join(projectRoot, relativePath);
    if (!(await validateDirMtime(fullPath, cachedMtime))) {
      return false;
    }
  }
  return true;
}

/** Type guard: value is a plain object with all-numeric values (mtimes record). */
function isMtimesRecord(value: unknown): value is Record<string, number> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every(
      (v) => typeof v === "number"
    )
  );
}

/** Type guard: value is an array (used for the cached DSN list). */
function isArray(value: unknown): value is DetectedDsn[] {
  return Array.isArray(value);
}

/**
 * Get cached full detection result if valid.
 *
 * Validation checks (in order):
 * 1. Cache entry exists with full detection data
 * 2. TTL not expired (24h max age)
 * 3. Project root directory mtime unchanged (no new files)
 * 4. All source file mtimes unchanged
 *
 * @param projectRoot - Project root directory
 * @returns Cached detection or undefined if not cached/invalid
 */
export async function getCachedDetection(
  projectRoot: string
): Promise<CachedDetection | undefined> {
  if (dsnCacheDisabled) {
    return;
  }

  const db = getDatabase();

  const row = db
    .query("SELECT * FROM dsn_cache WHERE directory = ?")
    .get(projectRoot) as DsnCacheRow | undefined;

  if (!row) {
    recordCacheHit("dsn-detection", false);
    return;
  }

  // Check if full detection data exists (v4 columns)
  if (
    !(row.fingerprint && row.all_dsns_json && row.source_mtimes_json) ||
    row.root_dir_mtime === null ||
    row.ttl_expires_at === null
  ) {
    // Old cache entry without full detection data
    recordCacheHit("dsn-detection", false);
    return;
  }

  const now = Date.now();

  // Check TTL expiration
  if (now > row.ttl_expires_at) {
    recordCacheHit("dsn-detection", false);
    return;
  }

  // Check project root directory mtime
  if (!(await validateDirMtime(projectRoot, row.root_dir_mtime))) {
    recordCacheHit("dsn-detection", false);
    return;
  }

  // Parse all cached JSON columns up front, validating their shape. Corruption
  // (partial write, manual edit, schema drift) — including a structurally wrong
  // value like an object where an array is expected — is treated as a cache miss
  // so detection re-runs from scratch instead of crashing downstream.
  const sourceMtimes = safeParseJson(row.source_mtimes_json, isMtimesRecord);
  const dirMtimes = row.dir_mtimes_json
    ? safeParseJson(row.dir_mtimes_json, isMtimesRecord)
    : {};
  const allDsns = safeParseJson(row.all_dsns_json, isArray);
  if (sourceMtimes === undefined || dirMtimes === undefined || !allDsns) {
    recordCacheHit("dsn-detection", false);
    return;
  }

  if (!(await validateSourceMtimes(projectRoot, sourceMtimes))) {
    recordCacheHit("dsn-detection", false);
    return;
  }

  if (!(await validateDirMtimes(projectRoot, dirMtimes))) {
    recordCacheHit("dsn-detection", false);
    return;
  }

  recordCacheHit("dsn-detection", true);
  // Cache is valid - update last access time
  touchCacheEntry("dsn_cache", "directory", projectRoot);

  return {
    fingerprint: row.fingerprint,
    allDsns,
    sourceMtimes,
    dirMtimes,
    rootDirMtime: row.root_dir_mtime,
    ttlExpiresAt: row.ttl_expires_at,
  };
}

/**
 * Store full detection result in cache.
 *
 * This updates the existing cache entry (if any) with full detection data.
 * The primary DSN from allDsns[0] is used for the single-DSN fields.
 *
 * @param projectRoot - Project root directory
 * @param entry - Detection result to cache
 */
export function setCachedDetection(
  projectRoot: string,
  entry: DetectionCacheEntry
): void {
  const db = getDatabase();
  const now = Date.now();

  // Use primary DSN for backwards-compatible single-DSN fields
  const primaryDsn = entry.allDsns[0];

  runUpsert(
    db,
    "dsn_cache",
    {
      directory: projectRoot,
      // Single-DSN fields (for backwards compatibility)
      dsn: primaryDsn?.raw ?? "",
      project_id: primaryDsn?.projectId ?? "",
      org_id: primaryDsn?.orgId ?? null,
      source: primaryDsn?.source ?? "code",
      source_path: primaryDsn?.sourcePath ?? null,
      resolved_org_slug: null,
      resolved_org_name: null,
      resolved_project_slug: null,
      resolved_project_name: null,
      // Full detection fields (v4)
      fingerprint: entry.fingerprint,
      all_dsns_json: JSON.stringify(entry.allDsns),
      source_mtimes_json: JSON.stringify(entry.sourceMtimes),
      dir_mtimes_json: JSON.stringify(entry.dirMtimes),
      root_dir_mtime: entry.rootDirMtime,
      ttl_expires_at: now + CACHE_TTL_MS,
      // Timestamps
      cached_at: now,
      last_accessed: now,
    },
    ["directory"]
  );

  maybeCleanupCaches();
}
