import {
  array,
  description,
  type InferOutput,
  number,
  object,
  pipe,
  string,
} from "valibot";
import type { DroppedEventsResponse } from "../../types/dropped-events.js";
import { outcomeLabel } from "../../types/dropped-events.js";
import { bold } from "./colors.js";
import { fmtCount } from "./numbers.js";
import { type Column, formatTable } from "./table.js";

const ReasonRowSchema = pipe(
  object({
    reason: pipe(string(), description("Drop reason (sub-classification)")),
    category: pipe(string(), description("Data category (e.g. error, span)")),
    events: pipe(number(), description("Events dropped for this reason")),
    share: pipe(
      number(),
      description("Fraction of total volume (0-1), not a percentage string"),
    ),
    tags: pipe(
      array(string()),
      description("Drop classification: intentional or unintentional"),
    ),
  }),
  description("A reason row within an outcome"),
);

export const DroppedEventsOutputSchema = pipe(
  object({
    outcomes: array(
      pipe(
        object({
          outcome: pipe(string(), description("Drop outcome code")),
          label: pipe(string(), description("Human-readable outcome label")),
          events: pipe(
            number(),
            description("Events dropped for this outcome"),
          ),
          share: pipe(number(), description("Fraction of total volume (0-1)")),
          reasons: array(ReasonRowSchema),
        }),
        description("An outcome section"),
      ),
    ),
  }),
  description("Dropped events grouped by outcome and reason"),
);

export type DroppedEventsResult = InferOutput<typeof DroppedEventsOutputSchema>;
type ReasonRow = InferOutput<typeof ReasonRowSchema>;
type OutcomeSection = DroppedEventsResult["outcomes"][number];

function shareRatio(events: number, total: number): number {
  return total === 0 ? 0 : events / total;
}

/**
 * Collapse the bucketed API response into outcome sections sorted by volume,
 * each with reason rows sorted by volume. Share is each slice's fraction of
 * total volume (dropped + accepted), matching the Explore flyout.
 */
export function summarizeDroppedEvents(
  response: DroppedEventsResponse,
): DroppedEventsResult {
  const total =
    sumCounts(response.droppedEvents) + sumCounts(response.acceptedEvents);

  const byOutcome = new Map<string, Map<string, ReasonRow>>();
  for (const bucket of response.droppedEvents) {
    const reasons = byOutcome.get(bucket.outcome) ?? new Map();
    byOutcome.set(bucket.outcome, reasons);
    const existing = reasons.get(bucket.reason);
    if (existing) {
      existing.events += bucket.count;
    } else {
      reasons.set(bucket.reason, {
        reason: bucket.reason,
        category: bucket.category,
        events: bucket.count,
        share: 0,
        // Tags are per (outcome, reason), stable across a reason's buckets, so
        // take them from the first bucket seen.
        tags: bucket.tags,
      });
    }
  }

  const outcomes: OutcomeSection[] = [...byOutcome.entries()]
    .map(([outcome, reasons]) => {
      const rows = [...reasons.values()]
        .map((row) => ({ ...row, share: shareRatio(row.events, total) }))
        .sort((a, b) => b.events - a.events);
      const events = rows.reduce((sum, row) => sum + row.events, 0);
      return {
        outcome,
        label: outcomeLabel(outcome),
        events,
        share: shareRatio(events, total),
        reasons: rows,
      };
    })
    .sort((a, b) => b.events - a.events);

  return { outcomes };
}

function sumCounts(buckets: DroppedEventsResponse["droppedEvents"]): number {
  return buckets.reduce((sum, bucket) => sum + bucket.count, 0);
}

function formatShare(ratio: number): string {
  if (ratio > 0 && ratio < 0.0001) {
    return "<0.01%";
  }
  return `${(ratio * 100).toFixed(2)}%`;
}

function formatTags(tags: string[]): string {
  return tags.length > 0 ? tags.join(", ") : "—";
}

const REASON_COLUMNS: Column<ReasonRow>[] = [
  { header: "Reason", value: (row) => row.reason },
  { header: "Category", value: (row) => row.category },
  { header: "Dropped", value: (row) => fmtCount(row.events), align: "right" },
  { header: "Share", value: (row) => formatShare(row.share), align: "right" },
  { header: "Tags", value: (row) => formatTags(row.tags) },
];

/**
 * Render the sectioned table: one block per outcome (header line + reason
 * table). Empty input yields an empty string — the command prints the "no
 * dropped events" hint instead.
 */
export function formatDroppedEvents(result: DroppedEventsResult): string {
  if (result.outcomes.length === 0) {
    return "";
  }
  return result.outcomes
    .map((section) => {
      const header = bold(
        `${section.label}: ${fmtCount(section.events)} dropped (${formatShare(section.share)})`,
      );
      return `${header}\n${formatTable(section.reasons, REASON_COLUMNS)}`;
    })
    .join("\n\n");
}
