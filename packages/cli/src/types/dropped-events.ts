/**
 * Dropped-events types and schemas.
 *
 * Mirrors the Sentry `GET /organizations/{org}/events-dropped/` response
 * (`src/sentry/api/endpoints/organization_events_dropped.py`): per-bucket
 * drop counts by outcome and reason, plus the accepted volume so a caller can
 * compute each slice's share. Each bucket carries `tags` classifying the drop
 * as `intentional` (user-configured, e.g. sampling or inbound filters) or
 * `unintentional` (e.g. quota, abuse); accepted buckets carry no tag.
 */

import {
  array,
  description,
  type InferOutput,
  looseObject,
  number,
  object,
  pipe,
  string,
} from "valibot";

/** One drop/accept bucket for a single (outcome, reason) over one interval. */
export const DroppedEventsBucketSchema = pipe(
  looseObject({
    type: pipe(string(), description("Event type (e.g. error, transaction)")),
    category: pipe(string(), description("Data category (e.g. error, span)")),
    outcome: pipe(
      string(),
      description("Drop classification (e.g. rate_limited, filtered)"),
    ),
    reason: pipe(
      string(),
      description(
        "Sub-classification within the outcome (e.g. spike_protection)",
      ),
    ),
    start: pipe(number(), description("Bucket start (epoch ms)")),
    end: pipe(number(), description("Bucket end (epoch ms)")),
    count: pipe(number(), description("Events in this bucket")),
    tags: pipe(
      array(string()),
      description("Drop classification tags: intentional or unintentional"),
    ),
  }),
  description("A dropped or accepted events bucket"),
);

export const DroppedEventsResponseSchema = pipe(
  object({
    meta: pipe(
      looseObject({
        dataset: pipe(string(), description("Resolved dataset label")),
        start: number(),
        end: number(),
        interval: pipe(number(), description("Bucket size (ms)")),
      }),
      description("Query metadata"),
    ),
    droppedEvents: array(DroppedEventsBucketSchema),
    acceptedEvents: array(DroppedEventsBucketSchema),
  }),
  description("Dropped and accepted events by outcome and reason"),
);

export type DroppedEventsBucket = InferOutput<typeof DroppedEventsBucketSchema>;
export type DroppedEventsResponse = InferOutput<
  typeof DroppedEventsResponseSchema
>;

/** Human label for a drop outcome. Falls back to the raw code. */
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
