/**
 * Cron Monitor API functions
 *
 * Read operations for Sentry cron monitors via the stable
 * `/organizations/{org}/monitors/` endpoint. Uses region-aware routing for
 * multi-region support. Check-in ingestion is handled separately via the DSN
 * envelope transport (`src/lib/envelope/`), not this module.
 */

import { listOrganizationMonitors } from "@sentry/api";

import type { SentryMonitor } from "../../types/index.js";

import {
  API_MAX_PER_PAGE,
  autoPaginate,
  getOrgSdkConfig,
  MAX_PAGINATION_PAGES,
  type PaginatedResponse,
  unwrapPaginatedResult,
} from "./infrastructure.js";

/**
 * List all cron monitors in an organization.
 *
 * Transparently fetches multiple pages when the org has more monitors than
 * the API page size (100). Matches the `listProjects` pattern.
 *
 * @param orgSlug - Organization slug
 * @returns Monitors, including nested monitor environments
 */
export async function listMonitors(orgSlug: string): Promise<SentryMonitor[]> {
  const config = await getOrgSdkConfig(orgSlug);

  const { data: allResults } = await autoPaginate(async (cursor) => {
    const result = await listOrganizationMonitors({
      ...config,
      path: { organization_id_or_slug: orgSlug },
      query: { cursor, per_page: API_MAX_PER_PAGE } as {
        cursor?: string;
        per_page?: number;
      },
    });
    return unwrapPaginatedResult<SentryMonitor[]>(
      result,
      "Failed to list monitors"
    );
  }, MAX_PAGINATION_PAGES * API_MAX_PER_PAGE);

  return allResults;
}

/**
 * List cron monitors in an organization with pagination control.
 * Returns a single page of results with cursor metadata.
 *
 * @param orgSlug - Organization slug
 * @param options - Pagination options
 * @returns Single page of monitors with cursor metadata
 */
export async function listMonitorsPaginated(
  orgSlug: string,
  options: { cursor?: string; perPage?: number } = {}
): Promise<PaginatedResponse<SentryMonitor[]>> {
  const config = await getOrgSdkConfig(orgSlug);

  const result = await listOrganizationMonitors({
    ...config,
    path: { organization_id_or_slug: orgSlug },
    query: {
      cursor: options.cursor,
      per_page: options.perPage ?? API_MAX_PER_PAGE,
    } as { cursor?: string; per_page?: number },
  });

  return unwrapPaginatedResult<SentryMonitor[]>(
    result,
    "Failed to list monitors"
  );
}
