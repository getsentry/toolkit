import type { ListOrganizationEventsDroppedResponse } from "@sentry/api";
import type { EventOutcomeRow } from "../../output-schemas/event.js";
import { bold } from "./colors.js";
import { fmtCount } from "./numbers.js";
import { type Column, formatTable } from "./table.js";

export type { EventOutcomeRow };

/** Outcome (and reason) Sentry reports for accepted volume. */
export const ACCEPTED_OUTCOME = "accepted";

/** Human-readable label for an outcome code. */
function outcomeLabel(outcome: string): string {
  switch (outcome) {
    case ACCEPTED_OUTCOME:
      return "Accepted";
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

function shareRatio(events: number, total: number): number {
  return total === 0 ? 0 : events / total;
}

type Buckets = ListOrganizationEventsDroppedResponse["droppedEvents"];

function sumCounts(buckets: Buckets): number {
  return buckets.reduce((sum, bucket) => sum + bucket.count, 0);
}

/**
 * Collapse buckets into one row per (outcome, reason), sorted by outcome volume
 * then reason volume within each outcome.
 */
function collapseBuckets(buckets: Buckets, total: number): EventOutcomeRow[] {
  const byOutcome = new Map<
    string,
    Map<string, { events: number; category: string; tags: string[] }>
  >();
  for (const bucket of buckets) {
    const reasons = byOutcome.get(bucket.outcome) ?? new Map();
    byOutcome.set(bucket.outcome, reasons);
    const existing = reasons.get(bucket.reason);
    if (existing) {
      existing.events += bucket.count;
    } else {
      // Tags are per (outcome, reason), stable across a reason's buckets, so
      // take them from the first bucket seen. Sentry added them in
      // getsentry/sentry#127850; older self-hosted servers omit them.
      reasons.set(bucket.reason, {
        events: bucket.count,
        category: bucket.category,
        tags: bucket.tags ?? [],
      });
    }
  }

  return [...byOutcome.entries()]
    .map(([outcome, reasons]) => {
      const rows: EventOutcomeRow[] = [...reasons.entries()]
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

/**
 * Collapse the bucketed API response into flat rows: the accepted volume first
 * (Sentry reports it as outcome and reason `accepted`), then one row per drop
 * (outcome, reason). Share is each slice's fraction of total volume (dropped +
 * accepted), matching the Explore flyout.
 */
export function summarizeEventOutcomes(
  response: ListOrganizationEventsDroppedResponse,
): EventOutcomeRow[] {
  const total =
    sumCounts(response.droppedEvents) + sumCounts(response.acceptedEvents);
  return [
    ...collapseBuckets(response.acceptedEvents, total),
    ...collapseBuckets(response.droppedEvents, total),
  ];
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

const REASON_COLUMNS: Column<EventOutcomeRow>[] = [
  { header: "Reason", value: (row) => row.reason },
  { header: "Category", value: (row) => row.category },
  { header: "Dropped", value: (row) => fmtCount(row.events), align: "right" },
  { header: "Share", value: (row) => formatShare(row.share), align: "right" },
  { header: "Tags", value: (row) => formatTags(row.tags) },
];

/**
 * Render one block per outcome. Accepted volume is a single header line; each
 * drop outcome gets a header line plus a reason table. Rows arrive grouped by
 * outcome (contiguous), so split on outcome change rather than re-grouping.
 * Empty input yields an empty string — the command prints a hint instead.
 */
export function formatEventOutcomes(rows: EventOutcomeRow[]): string {
  if (rows.length === 0) {
    return "";
  }
  const sections: Array<{
    outcome: string;
    label: string;
    rows: EventOutcomeRow[];
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
    .map(({ outcome, label, rows: section }) => {
      const events = section.reduce((sum, row) => sum + row.events, 0);
      const share = formatShare(
        section.reduce((sum, row) => sum + row.share, 0),
      );
      if (outcome === ACCEPTED_OUTCOME) {
        return bold(`${label}: ${fmtCount(events)} (${share})`);
      }
      const header = bold(`${label}: ${fmtCount(events)} dropped (${share})`);
      return `${header}\n${formatTable(section, REASON_COLUMNS)}`;
    })
    .join("\n\n");
}
