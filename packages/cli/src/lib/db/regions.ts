/**
 * Organization region cache for multi-region support.
 *
 * Sentry has multiple regions (US, EU, etc.) and organizations are bound
 * to a specific region. This module caches the organization-to-region
 * mapping to avoid repeated lookups.
 *
 * The `org_id` column (added in schema v8) enables offline resolution
 * of numeric org IDs extracted from DSN hosts (e.g., `o1081365` →
 * look up by `org_id = '1081365'` → get the slug).
 */

import { logger } from "../logger.js";
import { normalizeOrigin } from "../sentry-urls.js";
import { recordCacheHit } from "../telemetry.js";
import { getDatabase } from "./index.js";
import { runUpsert } from "./utils.js";

const log = logger.withTag("db.regions");

const TABLE = "org_regions";

/**
 * Process-local trust extension: origins that were vouched for by the
 * active token's issuing host (via `/users/me/regions/` responses or
 * `org_regions` table entries from prior invocations). Used by the
 * fetch-layer trust check in `token-host.ts` to admit requests to
 * regional silos that share the token's trust class.
 *
 * Lazy-seeded from the persisted table on first read so that on cold
 * start (with cached orgs from a previous CLI invocation) we don't
 * re-fetch regions just to extend trust.
 */
const trustedRegionOrigins = new Set<string>();
let trustedRegionOriginsSeeded = false;

function seedTrustedRegionOriginsIfNeeded(): void {
  if (trustedRegionOriginsSeeded) {
    return;
  }
  trustedRegionOriginsSeeded = true;
  try {
    const db = getDatabase();
    const rows = db
      .query(`SELECT DISTINCT region_url FROM ${TABLE}`)
      .all() as Pick<OrgRegionRow, "region_url">[];
    for (const row of rows) {
      const origin = normalizeOrigin(row.region_url);
      if (origin) {
        trustedRegionOrigins.add(origin);
      }
    }
  } catch (error) {
    log.debug("Failed to seed trusted region origins from DB", error);
  }
}

/**
 * Register region URLs the control silo just told us about. Used to
 * extend the trust scope BEFORE region URLs are persisted (the fan-out
 * step needs trust to be admitted before we have results to write).
 *
 * Also called automatically by {@link setOrgRegion} and
 * {@link setOrgRegions} so persistent and in-process state stay in sync.
 */
export function registerTrustedRegionUrls(urls: readonly string[]): void {
  for (const url of urls) {
    const origin = normalizeOrigin(url);
    if (origin) {
      trustedRegionOrigins.add(origin);
    }
  }
}

/**
 * Whether `origin` was vouched for by the active token's issuing host.
 * Lazy-seeds from `org_regions` on first call.
 */
export function isTrustedRegionOrigin(origin: string): boolean {
  seedTrustedRegionOriginsIfNeeded();
  return trustedRegionOrigins.has(origin);
}

/**
 * Clear the in-process trust extension. Called from `clearAuth()` to
 * evict region extensions tied to the now-cleared identity.
 *
 * Does NOT clear the login trust anchor in `token-host.ts` — that
 * represents the current `auth login` command's intent and is needed
 * after clearAuth runs during re-auth.
 */
export function clearTrustedHostState(): void {
  trustedRegionOrigins.clear();
  // Force re-seed on next read in case the caller deletes table rows
  // (clearOrgRegions) between this clear and the next access.
  trustedRegionOriginsSeeded = false;
}

/** @internal exported for testing */
export function resetTrustedRegionUrlsForTesting(): void {
  trustedRegionOrigins.clear();
  trustedRegionOriginsSeeded = false;
}

/** When true, getCachedOrganizations() returns empty (forces API fetch). */
let orgCacheDisabled = false;

/** Disable the org listing cache for this invocation (e.g., `--fresh` flag). */
export function disableOrgCache(): void {
  orgCacheDisabled = true;
}

/** Re-enable the org listing cache. Exported for testing. */
export function enableOrgCache(): void {
  orgCacheDisabled = false;
}

type OrgRegionRow = {
  org_slug: string;
  org_id: string | null;
  org_name: string | null;
  org_role: string | null;
  region_url: string;
  updated_at: number;
};

/** Entry for batch-caching org regions with optional metadata. */
export type OrgRegionEntry = {
  slug: string;
  regionUrl: string;
  orgId?: string;
  orgName?: string;
  /** The authenticated user's role in this organization (e.g., "member", "admin", "owner"). */
  orgRole?: string;
};

/**
 * Get the cached region URL for an organization.
 *
 * @param orgSlug - The organization slug
 * @returns The region URL if cached, undefined otherwise
 */
export function getOrgRegion(orgSlug: string): string | undefined {
  const db = getDatabase();
  const row = db
    .query(`SELECT region_url FROM ${TABLE} WHERE org_slug = ?`)
    .get(orgSlug) as Pick<OrgRegionRow, "region_url"> | undefined;

  recordCacheHit("region", !!row);
  return row?.region_url;
}

/**
 * Look up an organization slug by its numeric ID.
 *
 * Used to resolve DSN-style org identifiers (e.g., `o1081365` → strip
 * prefix → look up `1081365` → get the slug `my-org`).
 *
 * @param numericId - The bare numeric org ID (without "o" prefix)
 * @returns The org slug and region URL if found, undefined otherwise
 */
export function getOrgByNumericId(
  numericId: string
): { slug: string; regionUrl: string } | undefined {
  const db = getDatabase();
  const row = db
    .query(`SELECT org_slug, region_url FROM ${TABLE} WHERE org_id = ?`)
    .get(numericId) as
    | Pick<OrgRegionRow, "org_slug" | "region_url">
    | undefined;

  if (!row) {
    return;
  }
  return { slug: row.org_slug, regionUrl: row.region_url };
}

/**
 * Cache the region URL for an organization.
 *
 * @param orgSlug - The organization slug
 * @param regionUrl - The region URL (e.g., https://us.sentry.io)
 */
export function setOrgRegion(orgSlug: string, regionUrl: string): void {
  const db = getDatabase();
  const now = Date.now();

  runUpsert(
    db,
    TABLE,
    { org_slug: orgSlug, region_url: regionUrl, updated_at: now },
    ["org_slug"]
  );
  registerTrustedRegionUrls([regionUrl]);
}

/**
 * Cache region URLs for multiple organizations in a single transaction.
 * More efficient than calling setOrgRegion() multiple times.
 *
 * Each entry includes the org slug, region URL, and optionally the
 * numeric org ID for offline ID→slug lookups.
 *
 * @param entries - Array of org region entries
 */
export function setOrgRegions(entries: OrgRegionEntry[]): void {
  if (entries.length === 0) {
    return;
  }

  const db = getDatabase();
  const now = Date.now();

  db.transaction(() => {
    for (const entry of entries) {
      const row: Record<string, string | number | null> = {
        org_slug: entry.slug,
        region_url: entry.regionUrl,
        updated_at: now,
      };
      if (entry.orgId) {
        row.org_id = entry.orgId;
      }
      if (entry.orgName) {
        row.org_name = entry.orgName;
      }
      if (entry.orgRole) {
        row.org_role = entry.orgRole;
      }
      runUpsert(db, TABLE, row, ["org_slug"]);
    }
  })();
  registerTrustedRegionUrls(entries.map((e) => e.regionUrl));
}

/**
 * Clear all cached organization regions.
 * Should be called when the user logs out.
 */
export function clearOrgRegions(): void {
  const db = getDatabase();
  db.query(`DELETE FROM ${TABLE}`).run();
  clearTrustedHostState();
}

/**
 * Get all cached organization regions.
 * Used for determining if user has orgs in multiple regions.
 *
 * @returns Map of org slug to region URL
 */
export function getAllOrgRegions(): Map<string, string> {
  const db = getDatabase();
  const rows = db
    .query(`SELECT org_slug, region_url FROM ${TABLE}`)
    .all() as Pick<OrgRegionRow, "org_slug" | "region_url">[];

  return new Map(rows.map((row) => [row.org_slug, row.region_url]));
}

/** Cached org entry with the fields needed to reconstruct a SentryOrganization. */
export type CachedOrg = {
  slug: string;
  id: string;
  name: string;
  /** The authenticated user's role in this organization, if available. */
  orgRole?: string;
};

/**
 * Maximum age (ms) for cached organization entries.
 * Entries older than this are considered stale and ignored, forcing a
 * fresh API fetch. 7 days balances offline usability with picking up
 * new org memberships.
 */
const ORG_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Get all cached organizations with id, slug, and name.
 *
 * Returns organizations that have all three fields populated and were
 * updated within the TTL window. Rows with missing `org_id` or `org_name`
 * (from before schema v9) or stale `updated_at` are excluded — callers
 * should fall back to the API when the result is empty.
 *
 * Returns empty when the cache is disabled via {@link disableOrgCache}
 * (e.g., `--fresh` flag).
 *
 * @returns Array of cached org entries, or empty if cache is cold/stale/disabled/incomplete
 */
export function getCachedOrganizations(): CachedOrg[] {
  if (orgCacheDisabled) {
    return [];
  }

  const db = getDatabase();
  const cutoff = Date.now() - ORG_CACHE_TTL_MS;
  const rows = db
    .query(
      `SELECT org_slug, org_id, org_name, org_role FROM ${TABLE} WHERE org_id IS NOT NULL AND org_name IS NOT NULL AND updated_at > ?`
    )
    .all(cutoff) as Pick<
    OrgRegionRow,
    "org_slug" | "org_id" | "org_name" | "org_role"
  >[];

  return rows.map((row) => ({
    slug: row.org_slug,
    // org_id and org_name are guaranteed non-null by the WHERE clause
    id: row.org_id as string,
    name: row.org_name as string,
    ...(row.org_role ? { orgRole: row.org_role } : {}),
  }));
}

/**
 * Get the cached org role for a single organization.
 *
 * Returns the user's role from the org cache without an API call.
 * The role is populated when `listOrganizations()` fetches from the API.
 *
 * @param orgSlug - The organization slug
 * @returns The user's role (e.g., "member", "admin", "owner"), or undefined if not cached
 */
export function getCachedOrgRole(orgSlug: string): string | undefined {
  const db = getDatabase();
  const cutoff = Date.now() - ORG_CACHE_TTL_MS;
  const row = db
    .query(
      `SELECT org_role FROM ${TABLE} WHERE org_slug = ? AND org_role IS NOT NULL AND updated_at > ?`
    )
    .get(orgSlug, cutoff) as Pick<OrgRegionRow, "org_role"> | undefined;

  return row?.org_role ?? undefined;
}
