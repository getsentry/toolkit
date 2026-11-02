/**
 * Dropped Events Types
 *
 * Types and Valibot schemas for the organizations events-dropped endpoint,
 * which reports events Sentry received but dropped before storage, bucketed by
 * outcome and reason over time. Mirrors the MCP `find_dropped_events` schema so
 * the CLI and MCP agree on the response shape.
 */

import {
  array,
  type InferOutput,
  looseObject,
  number,
  object,
  optional,
  string,
} from "valibot";

/**
 * One drop/accept bucket for a single (outcome, reason) over one interval.
 *
 * `looseObject` tolerates extra fields the endpoint may add. `tags` is optional
 * with a `[]` default: the API omits it on accepted buckets and may omit it on
 * drops, which must not fail validation of the whole response.
 */
export const DroppedEventsBucketSchema = looseObject({
  type: string(),
  category: string(),
  outcome: string(),
  reason: string(),
  start: number(),
  end: number(),
  count: number(),
  tags: optional(array(string()), []),
});

export const DroppedEventsResponseSchema = object({
  meta: looseObject({
    dataset: string(),
    start: number(),
    end: number(),
    interval: number(),
  }),
  droppedEvents: array(DroppedEventsBucketSchema),
  acceptedEvents: array(DroppedEventsBucketSchema),
});

export type DroppedEventsBucket = InferOutput<typeof DroppedEventsBucketSchema>;
export type DroppedEventsResponse = InferOutput<
  typeof DroppedEventsResponseSchema
>;

/** Human-readable label for a drop outcome code. */
export function outcomeLabel(outcome: string): string {
  switch (outcome) {
    case "client_discard":
      return "Client Discard";
    case "filtered":
      return "Inbound Filter";
    case "invalid":
      return "Invalid or Malformed";
    case "rate_limited":
      return "Rate Limited";
    case "abuse":
      return "Abuse Limit";
    case "cardinality_limited":
      return "Cardinality Limit";
    default:
      return outcome;
  }
}
