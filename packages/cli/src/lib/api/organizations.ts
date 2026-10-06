/**
 * Organization API functions
 *
 * CRUD operations and region discovery for Sentry organizations.
 */

import {
  getOrganization as sdkGetOrganization,
  listOrganizations as sdkListOrganizations,
} from "@sentry/api";

import {
  type Region,
  type SentryOrganization,
  type UserRegionsResponse,
  UserRegionsResponseSchema,
} from "../../types/index.js";
import { type CredentialContext, getCredentialContext } from "../db/auth.js";
import type { OrgRegionEntry } from "../db/regions.js";
import { ApiError, AuthError } from "../errors.js";
import {
  getControlSiloUrl,
  getResponseCredentialIdentity,
  getResponseRequestOrigin,
  getSdkConfig,
} from "../sentry-client.js";
import { normalizeHttpOrigin, normalizeRegionBaseUrl } from "../sentry-urls.js";

import {
  API_MAX_PER_PAGE,
  apiRequestToRegion,
  getOrgSdkConfig,
  MAX_PAGINATION_PAGES,
  type PaginatedResponse,
  unwrapPaginatedResult,
  unwrapResult,
} from "./infrastructure.js";

function normalizeOrganizationRegion(
  raw: string | undefined,
  responseOrigin: string,
  baseUrl: string
): string | undefined {
  if (!raw) {
    if (normalizeHttpOrigin(baseUrl) === responseOrigin) {
      return normalizeRegionBaseUrl(baseUrl, responseOrigin) ?? responseOrigin;
    }
    return responseOrigin;
  }
  return normalizeRegionBaseUrl(raw, responseOrigin);
}

/**
 * Get the list of regions the user has organization membership in.
 * This endpoint is on the control silo (sentry.io) and returns all regions.
 *
 * Kept as a lightweight, side-effect-free call used to validate a token
 * (`auth login`, sentryclirc import) — org listing itself no longer needs
 * region discovery, see {@link listOrganizationsUncached}.
 *
 * @returns Array of regions with name and URL
 */
export async function getUserRegions(): Promise<Region[]> {
  const credential = getCredentialContext();
  // /users/me/regions/ is an internal endpoint - use raw request
  const { data } = await apiRequestToRegion<UserRegionsResponse>(
    getControlSiloUrl(credential),
    "/users/me/regions/",
    { schema: UserRegionsResponseSchema, credential, validatedRedirects: true }
  );
  return data.regions;
}

/**
 * Fetch a single page of organizations from a specific base URL (a region,
 * the control silo, or a self-hosted monolith — they all serve the same
 * shape at `/organizations/`).
 *
 * @param baseUrl - Base URL to query (region, control silo, or self-hosted instance)
 * @param options - Pagination options (cursor, page size)
 * @returns The page's organizations plus pagination cursors
 * @throws {ApiError} When the response isn't an array (CLI-1CQ: a proxy/WAF
 *   interfered) or the request itself failed (enriched 401/403/etc.)
 */
export async function listOrganizationsPage(
  baseUrl: string,
  options: { cursor?: string; perPage?: number } = {},
  credential = getCredentialContext()
): Promise<PaginatedResponse<SentryOrganization[]>> {
  const config = getSdkConfig(baseUrl, {
    credential,
    validatedRedirects: true,
  });

  const result = await sdkListOrganizations({
    ...config,
    query: { cursor: options.cursor, per_page: options.perPage },
  });

  // 403 enrichment (CLI-89, 24 users) is now handled centrally by
  // throwApiError() in infrastructure.ts — no per-endpoint catch needed.
  const paginated = unwrapPaginatedResult<SentryOrganization[]>(
    result,
    "Failed to list organizations"
  );

  // CLI-1CQ: self-hosted instances can return non-array data from
  // GET /api/0/organizations/ when a reverse proxy or WAF interferes.
  if (!Array.isArray(paginated.data)) {
    throw new ApiError(
      "Failed to list organizations: unexpected response format",
      0,
      `Expected an array from ${baseUrl}/api/0/organizations/ but received ${typeof paginated.data}. ` +
        "This may indicate an incompatible self-hosted Sentry version or a proxy interfering with the response."
    );
  }
  return paginated;
}

/**
 * List all organizations, returning cached data when available.
 *
 * On first call (cold cache), fetches from the API and populates the cache.
 * On subsequent calls, returns organizations from the SQLite cache without
 * any HTTP requests. This avoids the org listing API round-trip
 * (~200-400ms) on every command.
 *
 * Callers that need guaranteed-fresh data (e.g., `org list`, `auth status`)
 * should use {@link listOrganizationsUncached} instead.
 */
export async function listOrganizations(): Promise<SentryOrganization[]> {
  const credential = getCredentialContext();
  const { getCachedOrganizations } = await import("../db/regions.js");

  const cached = credential
    ? getCachedOrganizations(getControlSiloUrl(credential), credential.identity)
    : [];
  if (cached.length > 0) {
    return cached.map((org) => ({
      id: org.id,
      slug: org.slug,
      name: org.name,
      ...(org.orgRole ? { orgRole: org.orgRole } : {}),
    }));
  }

  // Cache miss — fetch from API (also populates cache for next time)
  return listOrganizationsUncached(credential);
}

type OrganizationPageContext = {
  baseUrl: string;
  credential: CredentialContext;
  organizations?: SentryOrganization[];
  regions?: OrgRegionEntry[];
  cursor?: string;
  pageIndex?: number;
};

async function listOrganizationPages({
  baseUrl,
  credential,
  organizations = [],
  regions = [],
  cursor,
  pageIndex = 0,
}: OrganizationPageContext): Promise<{
  organizations: SentryOrganization[];
  regions: OrgRegionEntry[];
}> {
  if (pageIndex >= MAX_PAGINATION_PAGES) {
    throw new ApiError(
      "Failed to list organizations: pagination limit exceeded",
      0
    );
  }
  const page = await listOrganizationsPage(
    baseUrl,
    { cursor, perPage: API_MAX_PER_PAGE },
    credential
  );
  const responseOrigin =
    page.response && getResponseRequestOrigin(page.response);
  const responseIdentity =
    page.response && getResponseCredentialIdentity(page.response);
  const entries: OrgRegionEntry[] =
    responseOrigin && responseIdentity === credential.identity
      ? page.data.flatMap((org) => {
          const region = normalizeOrganizationRegion(
            org.links?.regionUrl,
            responseOrigin,
            baseUrl
          );
          return region
            ? [
                {
                  slug: org.slug,
                  regionUrl: region,
                  sourceOrigin: responseOrigin,
                  cacheOrigin: baseUrl,
                  identity: credential.identity,
                  orgId: org.id,
                  orgName: org.name,
                  ...(org.orgRole ? { orgRole: org.orgRole } : {}),
                },
              ]
            : [];
        })
      : [];
  const accumulated = [...organizations, ...page.data];
  const accumulatedRegions = [...regions, ...entries];
  return page.nextCursor
    ? await listOrganizationPages({
        baseUrl,
        credential,
        organizations: accumulated,
        regions: accumulatedRegions,
        cursor: page.nextCursor,
        pageIndex: pageIndex + 1,
      })
    : { organizations: accumulated, regions: accumulatedRegions };
}

/**
 * List all organizations by fetching from the API, bypassing the cache.
 *
 * Makes a single call to the control silo's org listing endpoint
 * (`GET /organizations/`), which returns every organization the user
 * belongs to across all regions in one paginated response — no more
 * discovering regions via `/users/me/regions/` and fanning out to each
 * one. Self-hosted/monolith deployments serve the same endpoint from the
 * same base URL, so no special-casing is needed there either.
 *
 * Populates the org_regions cache using each org's own `links.regionUrl`,
 * so subsequent org-scoped commands still route to the right region.
 *
 * Use this when you need guaranteed-fresh data (e.g., `org list`, `auth status`).
 * Most callers should use {@link listOrganizations} instead.
 */
export async function listOrganizationsUncached(
  credential = getCredentialContext()
): Promise<SentryOrganization[]> {
  const { invalidateCachedOrganizations, setOrgRegions } = await import(
    "../db/regions.js"
  );
  if (!credential) {
    throw new AuthError("not_authenticated");
  }
  const baseUrl = getControlSiloUrl(credential);
  const result = await listOrganizationPages({
    baseUrl,
    credential,
  });
  if (
    result.organizations.length > 0 &&
    result.regions.length === result.organizations.length
  ) {
    setOrgRegions(result.regions);
  } else {
    // A skipped or unverified region has no safe route. Existing scoped rows
    // may still route requests, but cannot represent the complete org list.
    invalidateCachedOrganizations(baseUrl, credential.identity);
  }
  return result.organizations;
}

/**
 * Get a specific organization.
 * Uses region-aware routing for multi-region support.
 */
export async function getOrganization(
  orgSlug: string
): Promise<SentryOrganization> {
  const config = await getOrgSdkConfig(orgSlug);

  const result = await sdkGetOrganization({
    ...config,
    path: { organization_id_or_slug: orgSlug },
  });

  return unwrapResult<SentryOrganization>(result, "Failed to get organization");
}
