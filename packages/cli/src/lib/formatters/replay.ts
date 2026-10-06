/**
 * Replay formatting helpers
 *
 * Human-readable formatting for Session Replay data in the CLI.
 */

import type { ListProjectReplayRecordingSegmentsResponse } from "@sentry/api";

import type {
  ReplayActivityEvent,
  ReplayDetails,
  ReplayRelatedIssue,
  ReplayRelatedTrace,
} from "../../types/index.js";
import { getReplayUserLabel } from "../replay-search.js";
import { buildReplayUrl } from "../sentry-web-urls.js";
import {
  escapeMarkdownCell,
  escapeMarkdownInline,
  mdKvTable,
  renderMarkdown,
} from "./markdown.js";
import {
  formatDurationCompactMs,
  formatDurationVerbose,
} from "./time-utils.js";

/** Data bag assembled by replay view before rendering. */
export type ReplayViewData = {
  org: string;
  replay: ReplayDetails;
  activity: ReplayActivityEvent[];
  relatedIssues: ReplayRelatedIssue[];
  relatedTraces: ReplayRelatedTrace[];
};

type MarkdownRow = [string, string];
type ReplayRecordingSegments = ListProjectReplayRecordingSegmentsResponse;
type ReplayRecordingEvent = ReplayRecordingSegments[number][number];

function hasReplayTag(
  value: unknown
): value is { payload?: unknown; tag: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "tag" in value &&
    typeof value.tag === "string" &&
    value.tag.length > 0
  );
}

function hasReplayHref(value: unknown): value is { href: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "href" in value &&
    typeof value.href === "string" &&
    value.href.length > 0
  );
}

function hasPerformanceSpanFields(
  value: unknown
): value is { data?: unknown; description?: unknown; op?: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    ("data" in value || "description" in value || "op" in value)
  );
}

function hasNumericDuration(value: unknown): value is { duration: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "duration" in value &&
    typeof value.duration === "number"
  );
}

function hasClickFields(
  value: unknown
): value is { label?: unknown; selector?: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    ("label" in value || "selector" in value)
  );
}

function hasBreadcrumbFields(
  value: unknown
): value is { category?: unknown; message?: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    ("category" in value || "message" in value)
  );
}

function getEventTimestampMillis(value: unknown): number | null {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function firstString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function compactDetails(values: Array<string | null>): string[] {
  return values.filter((value): value is string => value !== null);
}

function summarizePerformanceSpan(
  payload: unknown
): Omit<ReplayActivityEvent, "timestampMs"> | null {
  if (!hasPerformanceSpanFields(payload)) {
    return null;
  }

  const op = firstString(payload.op);
  const description = firstString(payload.description);
  const durationMs = hasNumericDuration(payload.data)
    ? payload.data.duration
    : null;

  if (!(description || op)) {
    return null;
  }

  return {
    label: op ?? "performanceSpan",
    details: compactDetails([
      description ? `description=${description}` : null,
      durationMs !== null ? `duration_ms=${durationMs}` : null,
    ]),
  };
}

function summarizeClickLikeEvent(
  label: string,
  payload: unknown,
  includeLabel = false
): Omit<ReplayActivityEvent, "timestampMs"> {
  if (!hasClickFields(payload)) {
    return { label, details: [] };
  }

  const selector = firstString(payload.selector);
  const clickLabel = firstString(payload.label);

  return {
    label,
    details: compactDetails([
      selector ? `selector=${selector}` : null,
      includeLabel && clickLabel ? `label=${clickLabel}` : null,
    ]),
  };
}

function summarizeBreadcrumb(
  payload: unknown
): Omit<ReplayActivityEvent, "timestampMs"> | null {
  if (!hasBreadcrumbFields(payload)) {
    return null;
  }

  const category = firstString(payload.category);
  const message = firstString(payload.message);
  if (!(category || message)) {
    return null;
  }

  return {
    label: category ?? "breadcrumb",
    details: compactDetails([message ? `message=${message}` : null]),
  };
}

const TAGGED_REPLAY_EVENT_SUMMARIZERS: Record<
  string,
  (payload: unknown) => Omit<ReplayActivityEvent, "timestampMs"> | null
> = {
  breadcrumb: summarizeBreadcrumb,
  click: (payload: unknown) => summarizeClickLikeEvent("click", payload, true),
  deadClick: (payload: unknown) =>
    summarizeClickLikeEvent("dead.click", payload),
  performanceSpan: summarizePerformanceSpan,
  rageClick: (payload: unknown) =>
    summarizeClickLikeEvent("rage.click", payload),
};

function summarizeTaggedReplayEvent(
  tag: string,
  payload: unknown
): Omit<ReplayActivityEvent, "timestampMs"> | null {
  const summarize = TAGGED_REPLAY_EVENT_SUMMARIZERS[tag];
  return summarize ? summarize(payload) : null;
}

function summarizeReplayEvent(
  event: ReplayRecordingEvent
): ReplayActivityEvent | null {
  const timestampMs = getEventTimestampMillis(event.timestamp);
  if (hasReplayTag(event.data)) {
    const replayEvent = summarizeTaggedReplayEvent(
      event.data.tag,
      event.data.payload
    );
    if (replayEvent) {
      return { timestampMs, ...replayEvent };
    }
  }

  if (hasReplayHref(event.data)) {
    return {
      timestampMs,
      label: "page.view",
      details: [`href=${event.data.href}`],
    };
  }

  return null;
}

/** Extract a capped list of activity events from replay recording segments. */
export function extractReplayActivityEvents(
  segments: ReplayRecordingSegments | null,
  maxEvents: number
): ReplayActivityEvent[] {
  if (!segments) {
    return [];
  }

  const events: ReplayActivityEvent[] = [];
  for (const segment of segments) {
    for (const event of segment) {
      const replayEvent = summarizeReplayEvent(event);
      if (replayEvent) {
        events.push(replayEvent);
      }
      if (events.length >= maxEvents) {
        return events;
      }
    }
  }

  return events;
}

function formatList(values: string[] | undefined): string | undefined {
  if (!values || values.length === 0) {
    return;
  }
  return values.map((value) => `- \`${value}\``).join("\n");
}

function pushMarkdownRow(
  rows: MarkdownRow[],
  label: string,
  value: string | undefined
): void {
  if (!value) {
    return;
  }
  rows.push([label, value]);
}

function formatYesNo(value: boolean | null | undefined): string | undefined {
  if (value === null || value === undefined) {
    return;
  }
  return value ? "Yes" : "No";
}

function formatNullableCount(
  value: number | null | undefined
): string | undefined {
  if (value === null || value === undefined) {
    return;
  }
  return String(value);
}

function formatJoinedMarkdown(
  values: Array<string | null | undefined>
): string | undefined {
  const joined = values.filter(Boolean).join(" ");
  return joined ? escapeMarkdownCell(joined) : undefined;
}

function formatReplayLocation(replay: ReplayDetails): string | undefined {
  const geo = replay.user?.geo;
  if (!geo) {
    return;
  }

  const location = [geo.city, geo.region, geo.country_code]
    .filter(Boolean)
    .join(", ");
  return location ? escapeMarkdownCell(location) : undefined;
}

function buildReplayOverviewRows(
  org: string,
  replay: ReplayDetails
): MarkdownRow[] {
  const rows: MarkdownRow[] = [["Replay ID", `\`${replay.id}\``]];
  pushMarkdownRow(rows, "Link", buildReplayUrl(org, replay.id));

  pushMarkdownRow(
    rows,
    "Started",
    replay.started_at ? new Date(replay.started_at).toLocaleString() : undefined
  );
  pushMarkdownRow(
    rows,
    "Finished",
    replay.finished_at
      ? new Date(replay.finished_at).toLocaleString()
      : undefined
  );
  pushMarkdownRow(
    rows,
    "Duration",
    replay.duration !== null && replay.duration !== undefined
      ? formatDurationVerbose(replay.duration)
      : undefined
  );
  pushMarkdownRow(
    rows,
    "Environment",
    replay.environment ? escapeMarkdownCell(replay.environment) : undefined
  );
  pushMarkdownRow(
    rows,
    "Platform",
    replay.platform ? escapeMarkdownCell(replay.platform) : undefined
  );
  pushMarkdownRow(
    rows,
    "Project ID",
    replay.project_id !== null && replay.project_id !== undefined
      ? String(replay.project_id)
      : undefined
  );
  pushMarkdownRow(
    rows,
    "Replay Type",
    replay.replay_type ? escapeMarkdownCell(replay.replay_type) : undefined
  );
  pushMarkdownRow(rows, "Archived", formatYesNo(replay.is_archived));
  pushMarkdownRow(rows, "Viewed", formatYesNo(replay.has_viewed));
  pushMarkdownRow(rows, "Errors", formatNullableCount(replay.count_errors));
  pushMarkdownRow(rows, "Segments", formatNullableCount(replay.count_segments));
  pushMarkdownRow(
    rows,
    "Rage Clicks",
    formatNullableCount(replay.count_rage_clicks)
  );
  pushMarkdownRow(
    rows,
    "Dead Clicks",
    formatNullableCount(replay.count_dead_clicks)
  );

  return rows;
}

function buildReplayUserRows(replay: ReplayDetails): MarkdownRow[] {
  const rows: MarkdownRow[] = [];
  const userLabel = getReplayUserLabel(replay);
  pushMarkdownRow(
    rows,
    "User",
    userLabel ? escapeMarkdownCell(userLabel) : undefined
  );
  pushMarkdownRow(
    rows,
    "Email",
    replay.user?.email ? escapeMarkdownCell(replay.user.email) : undefined
  );
  pushMarkdownRow(
    rows,
    "IP",
    replay.user?.ip ? escapeMarkdownCell(replay.user.ip) : undefined
  );
  pushMarkdownRow(rows, "Location", formatReplayLocation(replay));
  return rows;
}

function buildReplayClientRows(replay: ReplayDetails): MarkdownRow[] {
  const rows: MarkdownRow[] = [];
  pushMarkdownRow(
    rows,
    "Browser",
    formatJoinedMarkdown([replay.browser?.name, replay.browser?.version])
  );
  pushMarkdownRow(
    rows,
    "OS",
    formatJoinedMarkdown([replay.os?.name, replay.os?.version])
  );
  pushMarkdownRow(
    rows,
    "Device",
    formatJoinedMarkdown([
      replay.device?.brand,
      replay.device?.family,
      replay.device?.name,
      replay.device?.model_id,
    ])
  );
  pushMarkdownRow(
    rows,
    "SDK",
    formatJoinedMarkdown([replay.sdk?.name, replay.sdk?.version])
  );
  pushMarkdownRow(
    rows,
    "Dist",
    replay.dist ? escapeMarkdownCell(replay.dist) : undefined
  );
  return rows;
}

function pushKvSection(
  lines: string[],
  rows: MarkdownRow[],
  title?: string
): void {
  if (rows.length === 0) {
    return;
  }
  lines.push("");
  lines.push(mdKvTable(rows, title));
}

function pushListSection(
  lines: string[],
  title: string,
  values: string[] | undefined
): void {
  const content = formatList(values);
  if (!content) {
    return;
  }
  lines.push("");
  lines.push(`### ${title}`);
  lines.push("");
  lines.push(content);
}

function pushTagsSection(lines: string[], replay: ReplayDetails): void {
  if (Object.keys(replay.tags).length === 0) {
    return;
  }

  lines.push("");
  lines.push("### Tags");
  lines.push("");
  for (const [key, values] of Object.entries(replay.tags).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    lines.push(
      `- \`${escapeMarkdownInline(key)}\`: ${values.map((value) => `\`${escapeMarkdownInline(value)}\``).join(", ")}`
    );
  }
}

function pushActivitySection(
  lines: string[],
  replay: ReplayDetails,
  activity: ReplayActivityEvent[]
): void {
  lines.push("");
  lines.push("### Activity");
  lines.push("");

  if (replay.is_archived) {
    lines.push("Recording is archived and not available for playback.");
    return;
  }

  if (activity.length === 0) {
    lines.push("No activity events recorded.");
    return;
  }

  const startTime =
    getEventTimestampMillis(replay.started_at) ??
    activity[0]?.timestampMs ??
    null;
  for (const event of activity) {
    const prefix =
      event.timestampMs !== null && startTime !== null
        ? `${formatDurationCompactMs(event.timestampMs - startTime)} · `
        : "";
    const details =
      event.details.length > 0
        ? ` · ${event.details.map((detail) => escapeMarkdownInline(detail)).join(" · ")}`
        : "";
    lines.push(`- ${prefix}\`${escapeMarkdownInline(event.label)}\`${details}`);
  }
}

function formatRelatedIssueLine(
  org: string,
  issue: ReplayRelatedIssue
): string {
  if (!(issue.shortId && issue.title)) {
    return `- Event \`${issue.eventId}\``;
  }

  return `- \`${issue.shortId}\`: ${escapeMarkdownInline(issue.title)} (view: \`sentry issue view ${org}/${issue.shortId}\`)`;
}

function buildRelatedTraceStats(trace: ReplayRelatedTrace): string[] {
  return [
    trace.spanCount !== null && trace.spanCount !== undefined
      ? `${trace.spanCount} spans`
      : null,
    trace.errorCount !== null && trace.errorCount !== undefined
      ? `${trace.errorCount} errors`
      : null,
    trace.logCount !== null && trace.logCount !== undefined
      ? `${trace.logCount} logs`
      : null,
    trace.performanceIssueCount !== null &&
    trace.performanceIssueCount !== undefined
      ? `${trace.performanceIssueCount} perf issues`
      : null,
  ].filter((value): value is string => value !== null);
}

function formatRelatedTraceLine(
  org: string,
  trace: ReplayRelatedTrace
): string {
  const stats = buildRelatedTraceStats(trace);
  const suffix = stats.length > 0 ? ` (${stats.join(", ")})` : "";
  return `- Trace \`${trace.traceId}\`${suffix} (view: \`sentry trace view ${org}/${trace.traceId}\`)`;
}

function pushRelatedSection(
  lines: string[],
  org: string,
  relatedIssues: ReplayRelatedIssue[],
  relatedTraces: ReplayRelatedTrace[]
): void {
  if (relatedIssues.length === 0 && relatedTraces.length === 0) {
    return;
  }

  lines.push("");
  lines.push("### Related");
  lines.push("");

  for (const issue of relatedIssues) {
    lines.push(formatRelatedIssueLine(org, issue));
  }

  for (const trace of relatedTraces) {
    lines.push(formatRelatedTraceLine(org, trace));
  }
}

/** Format replay details for human-readable output. */
export function formatReplayDetails(data: ReplayViewData): string {
  const { activity, org, relatedIssues, relatedTraces, replay } = data;
  const lines: string[] = [];

  lines.push(`## Replay \`${replay.id.slice(0, 8)}\``);
  lines.push("");
  lines.push(mdKvTable(buildReplayOverviewRows(org, replay)));

  pushKvSection(lines, buildReplayUserRows(replay), "User");
  pushKvSection(lines, buildReplayClientRows(replay), "Client");

  pushListSection(lines, "Releases", replay.releases);
  pushListSection(lines, "URLs", replay.urls);
  pushListSection(lines, "Trace IDs", replay.trace_ids);
  pushListSection(lines, "Error IDs", replay.error_ids);
  pushActivitySection(lines, replay, activity);
  pushRelatedSection(lines, org, relatedIssues, relatedTraces);
  pushTagsSection(lines, replay);

  return renderMarkdown(lines.join("\n"));
}

/** Build a contextual hint pointing the user to a related trace or issue. */
export function replayHint(data: ReplayViewData): string | undefined {
  const traceId = data.replay.trace_ids?.[0];
  if (traceId) {
    return `Related trace: sentry trace view ${data.org}/${traceId}`;
  }

  const issue = data.relatedIssues[0];
  if (issue?.shortId) {
    return `Related issue: sentry issue view ${data.org}/${issue.shortId}`;
  }

  return;
}

/** Structured result for `replay download`. */
export type ReplayDownloadData = {
  /** Organization slug. */
  org: string;
  /** The downloaded replay's ID. */
  replayId: string;
  /** Local path the rrweb JSON was written to. */
  output: string;
  /** Number of recording segments fetched. */
  segmentCount: number;
  /** Number of events written. */
  eventCount: number;
  /** Time between the first and last event, in milliseconds. */
  durationMs: number;
};

/** Human-readable formatter for the `replay download` result. */
export function formatReplayDownloadResult(data: ReplayDownloadData): string {
  return renderMarkdown(
    mdKvTable([
      ["Replay ID", data.replayId],
      ["Segments", String(data.segmentCount)],
      ["Events", String(data.eventCount)],
      ["Duration", formatDurationCompactMs(data.durationMs)],
      ["Saved to", data.output],
    ])
  );
}
