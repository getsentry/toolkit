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

import { DEFAULT_SENTRY_URL, getConfiguredSentryUrl } from "../constants.js";
import { logger } from "../logger.js";
import { normalizeHttpOrigin } from "../sentry-urls.js";
import { recordCacheHit } from "../telemetry.js";
import { getCredentialContext, getIdentityFingerprint } from "./auth.js";
import { getDatabase } from "./index.js";
import { runUpsert } from "./utils.js";

const log = logger.withTag("db.regions");

const TABLE = "org_regions";
const MAX_TRUST_GRAPH_ORIGINS = 1024;
const TRAILING_SLASHES_RE = /\/+$/;

function getActiveSourceOrigin(): string {
  return (
    getConfiguredSentryUrl() ??
    getCredentialContext()?.host ??
    DEFAULT_SENTRY_URL
  );
}

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
const trustedRegionOrigins = new Map<string, Set<string>>();
const seededTrustScopes = new Set<string>();

function trustScopeKey(identity: string, sourceOrigin: string): string {
  return `${identity}\0${sourceOrigin}`;
}

function requireOrigin(url: string, name: string): string {
  const origin = normalizeHttpOrigin(url);
  if (!origin) {
    throw new Error(`${name} must be a credential-free HTTP(S) URL`);
  }
  return origin;
}

/** Keep a self-hosted installation path while storing only validated URLs. */
function requireRegionBaseUrl(url: string): string {
  const origin = requireOrigin(url, "Organization region URL");
  const parsed = new URL(url);
  if (parsed.search || parsed.hash) {
    throw new Error(
      "Organization region URL must not contain a query or fragment"
    );
  }
  const path = parsed.pathname.replace(TRAILING_SLASHES_RE, "");
  return `${origin}${path}`;
}

function registerTrustedOrigins(
  identity: string,
  sourceOrigin: string,
  urls: readonly string[]
): void {
  const key = trustScopeKey(identity, sourceOrigin);
  if (
    !trustedRegionOrigins.has(key) &&
    trustedRegionOrigins.size >= MAX_TRUST_GRAPH_ORIGINS
  ) {
    const oldest = trustedRegionOrigins.keys().next().value;
    if (oldest) {
      trustedRegionOrigins.delete(oldest);
      seededTrustScopes.delete(oldest);
    }
  }
  const origins = trustedRegionOrigins.get(key) ?? new Set<string>();
  for (const url of urls) {
    const origin = requireOrigin(url, "Organization region URL");
    if (origins.size < MAX_TRUST_GRAPH_ORIGINS) {
      origins.add(origin);
    }
  }
  trustedRegionOrigins.set(key, origins);
}

function seedTrustedOrigins(identity: string, sourceOrigin: string): void {
  const key = trustScopeKey(identity, sourceOrigin);
  if (seededTrustScopes.has(key)) {
    return;
  }
  seededTrustScopes.add(key);
  try {
    const rows = getDatabase()
      .query(
        `SELECT DISTINCT source_origin, response_origin, region_url FROM ${TABLE} WHERE credential_identity = ? AND (source_origin = ? OR response_origin = ?)`
      )
      .all(identity, sourceOrigin, sourceOrigin) as Pick<
      OrgRegionRow,
      "source_origin" | "response_origin" | "region_url"
    >[];
    for (const row of rows) {
      if (row.source_origin === sourceOrigin) {
        registerTrustedOrigins(identity, sourceOrigin, [row.response_origin]);
      }
      if (row.response_origin === sourceOrigin) {
        registerTrustedOrigins(identity, sourceOrigin, [row.region_url]);
      }
    }
  } catch (error) {
    seededTrustScopes.delete(key);
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
export function registerTrustedRegionUrls(
  urls: readonly string[],
  sourceOrigin = getActiveSourceOrigin(),
  identity = getIdentityFingerprint()
): void {
  registerTrustedOrigins(
    identity,
    requireOrigin(sourceOrigin, "Region source origin"),
    urls
  );
}

/**
 * Whether `origin` was vouched for by the active token's issuing host.
 * Lazy-seeds from `org_regions` on first call.
 */
export function isTrustedRegionOrigin(
  origin: string,
  sourceOrigin = getActiveSourceOrigin(),
  identity = getIdentityFingerprint()
): boolean {
  const candidate = normalizeHttpOrigin(origin);
  const source = normalizeHttpOrigin(sourceOrigin);
  if (!(candidate && source)) {
    return false;
  }
  const pending = [source];
  const visited = new Set<string>();
  while (pending.length > 0 && visited.size < MAX_TRUST_GRAPH_ORIGINS) {
    const current = pending.shift();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);
    seedTrustedOrigins(identity, current);
    const trusted = trustedRegionOrigins.get(trustScopeKey(identity, current));
    if (trusted?.has(candidate)) {
      return true;
    }
    for (const next of trusted ?? []) {
      if (!visited.has(next)) {
        pending.push(next);
      }
    }
  }
  return false;
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
  seededTrustScopes.clear();
}

/** @internal exported for testing */
export function resetTrustedRegionUrlsForTesting(): void {
  clearTrustedHostState();
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
  credential_identity: string;
  source_origin: string;
  response_origin: string;
  updated_at: number;
};

/** Entry for batch-caching org regions with optional metadata. */
export type OrgRegionEntry = {
  slug: string;
  regionUrl: string;
  sourceOrigin?: string;
  cacheOrigin?: string;
  identity?: string;
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
export function getOrgRegion(
  orgSlug: string,
  sourceOrigin = getActiveSourceOrigin(),
  identity = getIdentityFingerprint()
): string | undefined {
  const source = normalizeHttpOrigin(sourceOrigin);
  if (!source) {
    recordCacheHit("region", false);
    return;
  }
  const db = getDatabase();
  const row = db
    .query(
      `SELECT region_url FROM ${TABLE} WHERE org_slug = ? AND source_origin = ? AND credential_identity = ?`
    )
    .get(orgSlug, source, identity) as
    | Pick<OrgRegionRow, "region_url">
    | undefined;

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
  numericId: string,
  sourceOrigin = getActiveSourceOrigin(),
  identity = getIdentityFingerprint()
): { slug: string; regionUrl: string } | undefined {
  const source = normalizeHttpOrigin(sourceOrigin);
  if (!source) {
    return;
  }
  const db = getDatabase();
  const row = db
    .query(
      `SELECT org_slug, region_url FROM ${TABLE} WHERE org_id = ? AND source_origin = ? AND credential_identity = ?`
    )
    .get(numericId, source, identity) as
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
// biome-ignore lint/nursery/useMaxParams: provenance fields are explicit at the persistence boundary.
export function setOrgRegion(
  orgSlug: string,
  regionUrl: string,
  responseOrigin = getActiveSourceOrigin(),
  cacheOrigin = responseOrigin,
  identity = getIdentityFingerprint()
): void {
  const db = getDatabase();
  const now = Date.now();
  const region = requireRegionBaseUrl(regionUrl);
  const response = requireOrigin(responseOrigin, "Region response origin");
  const source = requireOrigin(cacheOrigin, "Region lookup origin");

  runUpsert(
    db,
    TABLE,
    {
      org_slug: orgSlug,
      region_url: region,
      credential_identity: identity,
      source_origin: source,
      response_origin: response,
      updated_at: now,
    },
    ["credential_identity", "source_origin", "org_slug"]
  );
  registerTrustedOrigins(identity, source, [response]);
  registerTrustedOrigins(identity, response, [region]);
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

  const normalized = entries.map((entry) => {
    const response = requireOrigin(
      entry.sourceOrigin ?? getActiveSourceOrigin(),
      "Region response origin"
    );
    const source = requireOrigin(
      entry.cacheOrigin ?? response,
      "Region lookup origin"
    );
    return {
      entry,
      identity: entry.identity ?? getIdentityFingerprint(),
      region: requireRegionBaseUrl(entry.regionUrl),
      response,
      source,
    };
  });
  const db = getDatabase();
  const now = Date.now();

  db.transaction(() => {
    for (const item of normalized) {
      const { entry } = item;
      const row: Record<string, string | number | null> = {
        org_slug: entry.slug,
        region_url: item.region,
        credential_identity: item.identity,
        source_origin: item.source,
        response_origin: item.response,
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
      runUpsert(db, TABLE, row, [
        "credential_identity",
        "source_origin",
        "org_slug",
      ]);
    }
  })();
  for (const item of normalized) {
    registerTrustedOrigins(item.identity, item.source, [item.response]);
    registerTrustedOrigins(item.identity, item.response, [item.region]);
  }
}

/** Keep trusted region routes but make an incomplete org list a cache miss. */
export function invalidateCachedOrganizations(
  sourceOrigin: string,
  identity: string
): void {
  const source = requireOrigin(sourceOrigin, "Region lookup origin");
  getDatabase()
    .query(
      `UPDATE ${TABLE} SET org_id = NULL, org_name = NULL, org_role = NULL WHERE source_origin = ? AND credential_identity = ?`
    )
    .run(source, identity);
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
export function getAllOrgRegions(
  sourceOrigin = getActiveSourceOrigin(),
  identity = getIdentityFingerprint()
): Map<string, string> {
  const source = normalizeHttpOrigin(sourceOrigin);
  if (!source) {
    return new Map();
  }
  const db = getDatabase();
  const rows = db
    .query(
      `SELECT org_slug, region_url FROM ${TABLE} WHERE source_origin = ? AND credential_identity = ?`
    )
    .all(source, identity) as Pick<OrgRegionRow, "org_slug" | "region_url">[];

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
export function getCachedOrganizations(
  sourceOrigin = getActiveSourceOrigin(),
  identity = getIdentityFingerprint()
): CachedOrg[] {
  if (orgCacheDisabled) {
    return [];
  }

  const source = normalizeHttpOrigin(sourceOrigin);
  if (!source) {
    return [];
  }

  const db = getDatabase();
  const cutoff = Date.now() - ORG_CACHE_TTL_MS;
  const rows = db
    .query(
      `SELECT org_slug, org_id, org_name, org_role FROM ${TABLE} WHERE source_origin = ? AND credential_identity = ? AND org_id IS NOT NULL AND org_name IS NOT NULL AND updated_at > ?`
    )
    .all(source, identity, cutoff) as Pick<
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
export function getCachedOrgRole(
  orgSlug: string,
  sourceOrigin = getActiveSourceOrigin(),
  identity = getIdentityFingerprint()
): string | undefined {
  const source = normalizeHttpOrigin(sourceOrigin);
  if (!source) {
    return;
  }
  const db = getDatabase();
  const cutoff = Date.now() - ORG_CACHE_TTL_MS;
  const row = db
    .query(
      `SELECT org_role FROM ${TABLE} WHERE org_slug = ? AND source_origin = ? AND credential_identity = ? AND org_role IS NOT NULL AND updated_at > ?`
    )
    .get(orgSlug, source, identity, cutoff) as
    | Pick<OrgRegionRow, "org_role">
    | undefined;

  return row?.org_role ?? undefined;
}
