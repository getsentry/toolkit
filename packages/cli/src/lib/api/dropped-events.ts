/**
 * Dropped events API — events Sentry received but dropped before storage.
 *
 * Wraps the `events-dropped/` endpoint, which buckets dropped and accepted
 * volume by outcome and reason over a time range.
 */

import {
  type ListOrganizationEventsDroppedData,
  type ListOrganizationEventsDroppedResponse,
  listOrganizationEventsDropped,
} from "@sentry/api";
import { getOrgSdkConfig, unwrapResult } from "./infrastructure.js";

/** Options for {@link getDroppedEvents}. */
export type DroppedEventsOptions = {
  /** API-level dataset name. Callers resolve user-facing aliases first. */
  dataset?: ListOrganizationEventsDroppedData["query"]["dataset"];
  /** Numeric project ID. Omit to span every project the token can read. */
  projectId?: string;
  /** Relative time period (e.g. "24h", "7d"). Mutually exclusive with start/end. */
  statsPeriod?: string;
  /** Absolute start datetime (ISO-8601). Mutually exclusive with statsPeriod. */
  start?: string;
  /** Absolute end datetime (ISO-8601). Mutually exclusive with statsPeriod. */
  end?: string;
};

/**
 * Fetch dropped and accepted events for an organization, bucketed by outcome
 * and reason over the requested range. `dataset` is sent as given, so callers
 * pass the API-level name (e.g. `tracemetrics`). When no time range is given,
 * the endpoint defaults to 90d server-side.
 */
export async function getDroppedEvents(
  orgSlug: string,
  options: DroppedEventsOptions = {},
): Promise<ListOrganizationEventsDroppedResponse> {
  const config = getOrgSdkConfig();
  const result = await listOrganizationEventsDropped({
    ...config,
    path: { organization_id_or_slug: orgSlug },
    query: {
      dataset: options.dataset ?? "errors",
      project:
        options.projectId === undefined ? undefined : [options.projectId],
      statsPeriod:
        options.start || options.end ? undefined : options.statsPeriod,
      start: options.start,
      end: options.end,
    },
  });
  return unwrapResult<ListOrganizationEventsDroppedResponse>(
    result,
    "Failed to fetch dropped events",
  );
}
