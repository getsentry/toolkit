/**
 * Output schema of the `sentry event analytics` command.
 */

import {
  array,
  description,
  type InferOutput,
  number,
  object,
  pipe,
  string,
} from "valibot";

/** One (outcome, reason) slice of dropped volume. One JSON row, one table line. */
export const DroppedEventRowSchema = pipe(
  object({
    outcome: pipe(
      string(),
      description("Drop outcome code (e.g. rate_limited, filtered)"),
    ),
    label: pipe(string(), description("Human-readable outcome label")),
    reason: pipe(
      string(),
      description("Drop reason within the outcome (e.g. spike_protection)"),
    ),
    category: pipe(string(), description("Data category (e.g. error, span)")),
    events: pipe(number(), description("Events dropped for this slice")),
    share: pipe(
      number(),
      description("Fraction of total volume (0-1), not a percentage string"),
    ),
    tags: pipe(
      array(string()),
      description("Drop classification: intentional or unintentional"),
    ),
  }),
  description("A dropped-events row: one outcome/reason slice"),
);

export type DroppedEventRow = InferOutput<typeof DroppedEventRowSchema>;
