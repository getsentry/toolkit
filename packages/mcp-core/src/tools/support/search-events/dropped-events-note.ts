import { getActiveSpan } from "@sentry/core";
import type { SentryApiService } from "../../../api-client";
import { logWarn } from "../../../telem/logging";
import {
  DROPPED_EVENTS_DATASETS,
  type PublicEventsDataset,
} from "../../../utils/events-datasets";

const DROPPED_EVENTS_DATASET_SET = new Set<string>(DROPPED_EVENTS_DATASETS);

// A bucket/window is "material" once unintentional drops are at least this
// share of what Sentry accepted + dropped.
const MATERIAL_DROP_SHARE = 0.05;

const DETAIL_TOOL = "find_dropped_events";

interface DroppedBucket {
  reason: string;
  outcome: string;
  start: number;
  count: number;
  tags?: string[];
}

function isUnintentional(bucket: DroppedBucket): boolean {
  return !(bucket.tags ?? []).includes("intentional");
}

function sumCount(buckets: { count: number }[]): number {
  return buckets.reduce((total, b) => total + b.count, 0);
}

/**
 * Fetch drops for the SAME window/granularity as a just-returned timeseries and
 * render a markdown note — but only when unintentional drops are material.
 *
 * Runs in parallel with the search at the call site, swallows its own errors,
 * and returns "" whenever there is nothing material to say. It never throws
 * into the search path: a drop-fetch failure must not break the search result.
 */
export async function buildDroppedEventsNote({
  apiService,
  organizationSlug,
  projectId,
  dataset,
  interval,
  timeParams,
  toolAvailable,
}: {
  apiService: SentryApiService;
  organizationSlug: string;
  projectId?: string;
  dataset: PublicEventsDataset;
  interval: string | null;
  timeParams: { statsPeriod?: string; start?: string; end?: string };
  toolAvailable: boolean;
}): Promise<string> {
  if (!DROPPED_EVENTS_DATASET_SET.has(dataset)) {
    return "";
  }

  let response: Awaited<ReturnType<typeof apiService.getDroppedEvents>>;
  try {
    response = await apiService.getDroppedEvents({
      organizationSlug,
      dataset,
      projectId,
      interval: interval ?? undefined,
      statsPeriod: timeParams.statsPeriod,
      start: timeParams.start,
      end: timeParams.end,
    });
  } catch (error) {
    logWarn("Dropped-events note fetch failed; omitting note", {
      loggerScope: ["mcp", "search", "dropped-events-note"],
      extra: { error: error instanceof Error ? error.message : String(error) },
    });
    return "";
  }

  const dropped = response.droppedEvents.filter(isUnintentional);
  const totalDropped = sumCount(dropped);
  if (totalDropped === 0) {
    return "";
  }

  const totalAccepted = sumCount(response.acceptedEvents);
  const denom = totalDropped + totalAccepted;
  const share = denom > 0 ? totalDropped / denom : 0;
  if (share < MATERIAL_DROP_SHARE) {
    return "";
  }

  // Accepted volume per bucket start, to compute a per-bucket share. Catches a
  // partial drop that caps a chart without ever leaving a bucket empty — the
  // case an empty-bucket-only heuristic misses.
  const acceptedByStart = new Map<number, number>();
  for (const b of response.acceptedEvents) {
    acceptedByStart.set(b.start, (acceptedByStart.get(b.start) ?? 0) + b.count);
  }
  const droppedByStart = new Map<number, number>();
  for (const b of dropped) {
    droppedByStart.set(b.start, (droppedByStart.get(b.start) ?? 0) + b.count);
  }
  const affectedBuckets = [...droppedByStart.entries()]
    .filter(([start, dropCount]) => {
      const accepted = acceptedByStart.get(start) ?? 0;
      const bucketDenom = dropCount + accepted;
      return bucketDenom > 0 && dropCount / bucketDenom >= MATERIAL_DROP_SHARE;
    })
    .map(([start]) => start)
    .sort((a, b) => a - b)
    .map((start) => new Date(start).toISOString());

  // Dominant drop reasons, highest-volume first.
  const byReason = new Map<string, number>();
  for (const b of dropped) {
    byReason.set(b.reason, (byReason.get(b.reason) ?? 0) + b.count);
  }
  const dominantReasons = [...byReason.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason]) => reason);

  getActiveSpan()?.setAttribute("mcp.dropped_events.note_share", share);

  const scopedToProject = projectId !== undefined && projectId !== "-1";

  const pct = (share * 100).toFixed(1);
  const lines = [
    "## Dropped Events",
    "",
    `⚠️ Sentry dropped **${totalDropped.toLocaleString()}** ${dataset} ` +
      `(**${pct}%** of volume) in this ${scopedToProject ? "project" : "organization"} ` +
      "over this window, independent of this search's filter. A dip or flatline in " +
      "the chart above may be dropped data rather than an actual change.",
    `- **Dominant reasons**: ${dominantReasons.join(", ")}`,
  ];
  if (affectedBuckets.length > 0) {
    lines.push(`- **Affected buckets (UTC)**: ${affectedBuckets.join(", ")}`);
  }
  if (toolAvailable) {
    const scopeHint = scopedToProject
      ? "org, project, dataset, and time range"
      : "org, dataset, and time range";
    lines.push(
      "",
      `Call \`${DETAIL_TOOL}\` with the same ${scopeHint} for the full ` +
        "breakdown by outcome and reason.",
    );
  }
  return lines.join("\n");
}
