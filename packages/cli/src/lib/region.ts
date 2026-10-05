/**
 * Region resolution for multi-region Sentry support.
 *
 * Provides utilities to resolve the correct region URL for an organization,
 * using cached data when available or fetching from the API when needed.
 */

import { getOrganization } from "@sentry/api";
import { getConfiguredSentryUrl } from "./constants.js";
import { getOrgByNumericId, getOrgRegion, setOrgRegion } from "./db/regions.js";
import { stripDsnOrgPrefix } from "./dsn/index.js";
import { withAuthGuard } from "./errors.js";
import { logger } from "./logger.js";
import { getSdkConfig } from "./sentry-client.js";
import { getSentryBaseUrl, isSentrySaasUrl } from "./sentry-urls.js";

/**
 * Promise cache for org region resolution, keyed by orgSlug.
 *
 * When multiple DSNs share an orgId, concurrent calls to resolveOrgRegion
 * deduplicate into a single HTTP request. A resolved promise returns
 * instantly on `await`, so this also serves as a warm in-memory cache.
 *
 * Rejected promises (e.g., AuthError) are automatically evicted so that
 * retries after re-authentication can succeed without restarting the CLI.
 */
const regionCache = new Map<string, Promise<string>>();

/**
 * Resolve the region URL for an organization.
 *
 * Deduplicates concurrent calls for the same orgSlug — only one HTTP
 * request fires per unique org, even when many DSNs trigger resolution
 * in parallel.
 *
 * Resolution order:
 * 1. Return in-flight or previously resolved promise (instant)
 * 2. Check SQLite cache
 * 3. Fetch organization details via SDK to get region URL
 * 4. Fall back to default URL if resolution fails
 *
 * Uses the SDK directly (not api-client) to avoid circular dependency.
 *
 * @param orgSlug - The organization slug
 * @returns The region URL for the organization
 */
export function resolveOrgRegion(orgSlug: string): Promise<string> {
  const existing = regionCache.get(orgSlug);
  if (existing) {
    return existing;
  }

  const promise = resolveOrgRegionUncached(orgSlug);
  regionCache.set(orgSlug, promise);
  // Evict on rejection (AuthError) so retries after re-login work.
  // Non-auth errors already resolve to baseUrl fallback, so only
  // AuthError re-throws can leave a rejected promise in the cache.
  promise.catch(() => regionCache.delete(orgSlug));
  return promise;
}

/**
 * Coerce a regionUrl from the API into an absolute URL.
 *
 * Self-hosted instances may return a relative regionUrl (e.g. "/") which is
 * truthy but breaks fetch calls that depend on an absolute base URL. Resolve
 * a relative value against baseUrl so it becomes absolute instead of being
 * discarded; an already-absolute value is returned unchanged.
 */
function toAbsoluteRegionUrl(rawRegionUrl: string, baseUrl: string): string {
  // Already absolute — use verbatim.
  if (URL.canParse(rawRegionUrl)) {
    return rawRegionUrl;
  }

  // Relative (e.g. "/") — resolve against baseUrl to get an absolute origin.
  if (URL.canParse(rawRegionUrl, baseUrl)) {
    return new URL(rawRegionUrl, baseUrl).origin;
  }

  logger.debug(
    `regionUrl "${rawRegionUrl}" from API could not be resolved to an absolute URL; falling back to baseUrl`
  );
  return baseUrl;
}

/**
 * Resolve org region from SQLite cache or API.
 * Called at most once per orgSlug per process lifetime.
 */
async function resolveOrgRegionUncached(orgSlug: string): Promise<string> {
  // 1. Check SQLite cache first
  const cached = getOrgRegion(orgSlug);
  if (cached) {
    return cached;
  }

  // 2. Fetch org details via SDK to discover the region URL
  const baseUrl = getSentryBaseUrl();
  const config = getSdkConfig(baseUrl);

  const result = await withAuthGuard(async () => {
    const response = await getOrganization({
      ...config,
      path: { organization_id_or_slug: orgSlug },
    });

    // Throw SDK errors so withAuthGuard can discriminate:
    // AuthError propagates, others fall back to default URL
    if (response.error !== undefined) {
      throw response.error;
    }

    // Self-hosted instances may return a relative regionUrl (e.g. "/") which
    // is truthy but would break fetch calls that depend on an absolute base
    // URL. Resolve it against baseUrl so a relative value becomes absolute
    // instead of being discarded; keep an already-absolute value as-is.
    const rawRegionUrl = response.data?.links?.regionUrl;
    const regionUrl = rawRegionUrl
      ? toAbsoluteRegionUrl(rawRegionUrl, baseUrl)
      : baseUrl;

    // Cache for future use. setOrgRegion also extends the in-process
    // trust class so the subsequent request to this region passes the
    // fetch-layer guard without needing a separate registration call.
    setOrgRegion(orgSlug, regionUrl);

    return regionUrl;
  });

  // Other errors (network, 404, etc.) fall back to default
  // This handles self-hosted instances without multi-region
  return result.ok ? result.value : baseUrl;
}

/**
 * Check if the CLI is configured for multi-region support.
 * Returns false for self-hosted instances that don't have regional URLs.
 */
export function isMultiRegionEnabled(): boolean {
  // Self-hosted instances (custom SENTRY_HOST/SENTRY_URL) typically don't have multi-region
  const baseUrl = getConfiguredSentryUrl();
  if (baseUrl && !isSentrySaasUrl(baseUrl)) {
    return false;
  }
  return true;
}

/**
 * Try to resolve an org identifier from the local org cache.
 *
 * Checks the slug directly first, then falls back to DSN-style numeric ID
 * lookup (stripping the `o` prefix and querying by `org_id`).
 *
 * @param orgSlug - Raw org identifier (may be a slug or `oNNNNN` DSN form)
 * @returns The resolved slug if found in cache, `undefined` on cache miss
 */
function resolveOrgFromCache(orgSlug: string): string | undefined {
  // Check if slug is directly cached
  const cached = getOrgRegion(orgSlug);
  if (cached) {
    return orgSlug;
  }

  // Try DSN-style numeric ID lookup (e.g., `o1081365` → `1081365` → slug)
  const numericId = stripDsnOrgPrefix(orgSlug);
  if (numericId !== orgSlug) {
    const match = getOrgByNumericId(numericId);
    if (match) {
      return match.slug;
    }
  }
}

/**
 * Resolve the effective org slug for API calls, with offline cache fallback.
 *
 * When users or AI agents extract org identifiers from DSN hosts
 * (e.g., `o1081365` from `o1081365.ingest.us.sentry.io`), the `o`-prefixed
 * form isn't recognized by the Sentry API. This function resolves the
 * identifier using two strategies:
 *
 * **Normal slugs** (e.g., `acme-corp`):
 * 1. Check local cache → return slug
 * 2. Try `resolveOrgRegion(orgSlug)` — single API call to fetch org details
 *    and populate the region cache. If it succeeds, the slug is valid.
 * 3. Fall back to the original slug for downstream error handling
 *
 * **DSN numeric IDs** (e.g., `o1081365`):
 * 1. Check local cache for numeric ID → slug mapping
 * 2. Refresh the full org list from the API (fan-out to all regions)
 *    to populate the numeric-ID-to-slug mapping
 * 3. Retry cache lookup, fall back to original slug
 *
 * @param orgSlug - Raw org identifier from user input
 * @returns The org slug to use for API calls (may be normalized)
 */
export async function resolveEffectiveOrg(orgSlug: string): Promise<string> {
  // First attempt: use local cache
  const fromCache = resolveOrgFromCache(orgSlug);
  if (fromCache) {
    return fromCache;
  }

  // Check if the identifier is a DSN-style numeric ID (e.g., `o1081365`).
  // These need the full org list fan-out because we must map numeric ID → slug.
  const numericId = stripDsnOrgPrefix(orgSlug);
  const isDsnNumericId = numericId !== orgSlug;

  if (!isDsnNumericId) {
    // Normal slug: try a single resolveOrgRegion() call (1 API request)
    // instead of the heavy listOrganizationsUncached() fan-out (1+N requests).
    // If it succeeds, the slug is valid and the region is now cached.
    try {
      await resolveOrgRegion(orgSlug);
      return orgSlug;
    } catch (error) {
      // AuthError (and similar) — the downstream API call produces the
      // user-facing error and reportCliError already runs at the command
      // boundary. Log here so --verbose shows why we used the raw slug.
      logger.debug(
        `resolveOrgRegion failed for '${orgSlug}', using raw slug`,
        error
      );
      return orgSlug;
    }
  }

  // DSN numeric ID: refresh the full org list to populate ID → slug mapping.
  // listOrganizationsUncached() populates org_regions with slug, region, org_id, and name.
  try {
    const { listOrganizationsUncached } = await import("./api-client.js");
    await listOrganizationsUncached();
  } catch (error) {
    // Same as above: the command fails downstream and is reported there.
    logger.debug(
      `Failed to refresh org list for numeric ID '${orgSlug}'`,
      error
    );
    return orgSlug;
  }

  // Retry after refresh
  const afterRefresh = resolveOrgFromCache(orgSlug);
  return afterRefresh ?? orgSlug;
}
