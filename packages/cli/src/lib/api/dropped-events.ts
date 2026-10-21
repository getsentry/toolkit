/**
 * Sentry dropped-events API — events received but discarded before storage.
 *
 * Wraps `GET /organizations/{org}/events-dropped/`, the same endpoint the
 * Explore dropped-data UI, MCP `find_dropped_events`, and Seer use. Returns
 * drop counts bucketed by outcome and reason plus the accepted volume per
 * bucket. The `project` param is a numeric ID, so callers resolve a slug to an
 * ID first (see `getProject`).
 */

import {
  type DroppedEventsResponse,
  DroppedEventsResponseSchema,
} from "../../types/dropped-events.js";
import { resolveOrgRegion } from "../region.js";
import { apiRequestToRegion } from "./infrastructure.js";

/** Options for {@link getDroppedEvents}. */
export type DroppedEventsOptions = {
  /** Which dropped-data type to summarize. */
  dataset?: string;
  /** Numeric project ID. Omit to span every project the token can read. */
  projectId?: string;
  /** Relative time range (e.g. "24h", "7d"). Mutually exclusive with start/end. */
  statsPeriod?: string;
  /** Absolute start (ISO-8601). Paired with end. */
  start?: string;
  /** Absolute end (ISO-8601). Paired with start. */
  end?: string;
  /** Bucket size (e.g. "1h", "1d"). Omit to let Sentry pick. */
  interval?: string;
};

/**
 * Fetch dropped and accepted events for an organization, bucketed by outcome
 * and reason over the requested time range.
 */
export async function getDroppedEvents(
  orgSlug: string,
  options: DroppedEventsOptions = {},
): Promise<DroppedEventsResponse> {
  const regionUrl = await resolveOrgRegion(orgSlug);
  const { data } = await apiRequestToRegion<DroppedEventsResponse>(
    regionUrl,
    `/organizations/${orgSlug}/events-dropped/`,
    {
      params: {
        dataset: options.dataset ?? "errors",
        project: options.projectId,
        statsPeriod:
          options.start || options.end
            ? undefined
            : (options.statsPeriod ?? "90d"),
        start: options.start,
        end: options.end,
        interval: options.interval,
      },
      schema: DroppedEventsResponseSchema,
    },
  );
  return data;
}
