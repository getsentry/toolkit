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
  // The events API dataset is `tracemetrics`; `metrics` is the user-facing
  // alias and 400s if sent through unchanged.
  const dataset = options.dataset ?? "errors";
  const { data } = await apiRequestToRegion<DroppedEventsResponse>(
    regionUrl,
    `/organizations/${orgSlug}/events-dropped/`,
    {
      params: {
        dataset: dataset === "metrics" ? "tracemetrics" : dataset,
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
