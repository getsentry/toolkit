import {
  type DroppedEventsResponse,
  DroppedEventsResponseSchema,
} from "../../types/dropped-events.js";
import { resolveOrgRegion } from "../region.js";
import { apiRequestToRegion } from "./infrastructure.js";

/** Options for {@link getDroppedEvents}. */
export type DroppedEventsOptions = {
  /** API-level dataset name. Callers resolve user-facing aliases first. */
  dataset?: string;
  /** Numeric project ID. Omit to span every project the token can read. */
  projectId?: string;
  /** Relative time range (e.g. "24h", "7d"). Mutually exclusive with start/end. */
  statsPeriod?: string;
  /** Absolute start (ISO-8601). Paired with end. */
  start?: string;
  /** Absolute end (ISO-8601). Paired with start. */
  end?: string;
};

/**
 * Fetch dropped and accepted events for an organization, bucketed by outcome
 * and reason over the requested time range. Plain transport: `dataset` is sent
 * as given, so callers must pass the API-level name (e.g. `tracemetrics`).
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
      },
      schema: DroppedEventsResponseSchema,
    },
  );
  return data;
}
