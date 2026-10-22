import {
  array,
  description,
  type InferOutput,
  looseObject,
  number,
  object,
  optional,
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
    // Optional with a [] default: the API omits tags on accepted buckets and
    // may omit them on drops, which must not fail the whole response.
    tags: optional(
      pipe(
        array(string()),
        description("Drop classification tags: intentional or unintentional"),
      ),
      [],
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
