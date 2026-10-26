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

function shareRatio(events: number, total: number): number {
  return total === 0 ? 0 : events / total;
}

/**
 * Collapse the bucketed API response into flat rows, one per (outcome, reason),
 * sorted by outcome volume then reason volume within each outcome. Share is each
 * slice's fraction of total volume (dropped + accepted), matching the Explore
 * flyout. The human formatter re-groups contiguous rows into outcome sections.
 */
export function summarizeDroppedEvents(
  response: DroppedEventsResponse,
): DroppedEventRow[] {
  const total =
    sumCounts(response.droppedEvents) + sumCounts(response.acceptedEvents);

  const byOutcome = new Map<
    string,
    Map<string, { events: number; category: string; tags: string[] }>
  >();
  for (const bucket of response.droppedEvents) {
    const reasons = byOutcome.get(bucket.outcome) ?? new Map();
    byOutcome.set(bucket.outcome, reasons);
    const existing = reasons.get(bucket.reason);
    if (existing) {
      existing.events += bucket.count;
    } else {
      // Tags are per (outcome, reason), stable across a reason's buckets, so
      // take them from the first bucket seen.
      reasons.set(bucket.reason, {
        events: bucket.count,
        category: bucket.category,
        tags: bucket.tags,
      });
    }
  }

  return [...byOutcome.entries()]
    .map(([outcome, reasons]) => {
      const rows: DroppedEventRow[] = [...reasons.entries()]
        .map(([reason, r]) => ({
          outcome,
          label: outcomeLabel(outcome),
          reason,
          category: r.category,
          events: r.events,
          share: shareRatio(r.events, total),
          tags: r.tags,
        }))
        .sort((a, b) => b.events - a.events);
      const events = rows.reduce((sum, row) => sum + row.events, 0);
      return { events, rows };
    })
    .sort((a, b) => b.events - a.events)
    .flatMap((outcome) => outcome.rows);
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

const REASON_COLUMNS: Column<DroppedEventRow>[] = [
  { header: "Reason", value: (row) => row.reason },
  { header: "Category", value: (row) => row.category },
  { header: "Dropped", value: (row) => fmtCount(row.events), align: "right" },
  { header: "Share", value: (row) => formatShare(row.share), align: "right" },
  { header: "Tags", value: (row) => formatTags(row.tags) },
];

/**
 * Render one block per outcome (header line + reason table). Rows arrive grouped
 * by outcome (contiguous), so split on outcome change rather than re-grouping.
 * Empty input yields an empty string — the command prints the "no dropped
 * events" hint instead.
 */
export function formatDroppedEvents(rows: DroppedEventRow[]): string {
  if (rows.length === 0) {
    return "";
  }
  const sections: Array<{
    outcome: string;
    label: string;
    rows: DroppedEventRow[];
  }> = [];
  for (const row of rows) {
    const last = sections.at(-1);
    if (last && last.outcome === row.outcome) {
      last.rows.push(row);
    } else {
      sections.push({ outcome: row.outcome, label: row.label, rows: [row] });
    }
  }
  return sections
    .map(({ label, rows: section }) => {
      const events = section.reduce((sum, row) => sum + row.events, 0);
      const share = section.reduce((sum, row) => sum + row.share, 0);
      const header = bold(
        `${label}: ${fmtCount(events)} dropped (${formatShare(share)})`,
      );
      return `${header}\n${formatTable(section, REASON_COLUMNS)}`;
    })
    .join("\n\n");
}
