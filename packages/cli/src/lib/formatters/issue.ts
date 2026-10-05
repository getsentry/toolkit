/**
 * Issue view output types and formatters.
 */

import type { SentryEvent, SentryIssue } from "../../types/index.js";
import { getReplayIdFromEvent } from "../replay-search.js";
import { formatEventDetails, formatIssueDetails } from "./human.js";
import { filterFields } from "./json.js";
import { renderMarkdown } from "./markdown.js";

/** Data rendered for one issue. */
export type SingleIssueViewData = {
  /** Resolved organization slug, or null when resolution was unscoped. */
  org: string | null;
  /** Full issue details. */
  issue: SentryIssue;
  /** Latest event, or null when it could not be loaded. */
  event: SentryEvent | null;
  /** Related Session Replay identifiers. */
  replayIds: string[];
  /** Trace context from the latest event, or null when unavailable. */
  trace: { traceId: string; spans: unknown[] } | null;
  /** Pre-formatted span tree lines for human output only. */
  spanTreeLines?: string[];
};

/** Aggregate issue view output for single- and multi-issue invocations. */
export type IssueViewData = {
  /** Successfully loaded issue views in request order. */
  issues: SingleIssueViewData[];
  /** Number of distinct issues requested before partial failures. */
  requestedCount: number;
};

const MAX_REPLAY_IDS_SHOWN = 3;

function formatReplaySection(org: string | null, replayIds: string[]): string {
  if (replayIds.length === 0) {
    return "";
  }

  const visibleReplayIds = replayIds.slice(0, MAX_REPLAY_IDS_SHOWN);
  const lines = ["### Related Replays", ""];

  for (const replayId of visibleReplayIds) {
    if (org) {
      lines.push(
        `- \`${replayId}\` (view: \`sentry replay view ${org}/${replayId}\`)`
      );
    } else {
      lines.push(`- \`${replayId}\``);
    }
  }

  const remainingCount = replayIds.length - visibleReplayIds.length;
  if (remainingCount > 0) {
    lines.push(
      `- ${remainingCount} more related replay${remainingCount === 1 ? "" : "s"}`
    );
  }

  return renderMarkdown(lines.join("\n"));
}

function formatSingleIssueView(data: SingleIssueViewData): string {
  const parts = [formatIssueDetails(data.issue)];
  const eventReplayId = data.event
    ? getReplayIdFromEvent(data.event)
    : undefined;

  if (data.event) {
    parts.push(
      formatEventDetails(data.event, "Latest Event", data.issue.permalink)
    );
  }

  const additionalReplayIds = eventReplayId
    ? data.replayIds.filter((replayId) => replayId !== eventReplayId)
    : data.replayIds;
  const replaySection = formatReplaySection(data.org, additionalReplayIds);
  if (replaySection) {
    parts.push(replaySection);
  }

  if (data.spanTreeLines && data.spanTreeLines.length > 0) {
    parts.push(data.spanTreeLines.join("\n"));
  }

  return parts.join("\n");
}

/**
 * Format one or more issue views for terminal output.
 *
 * @param data - Aggregate issue view output
 * @returns Rendered issue sections separated by horizontal rules
 */
export function formatIssueView(data: IssueViewData): string {
  return data.issues.map(formatSingleIssueView).join("\n\n---\n\n");
}

function flattenIssueView(
  entry: SingleIssueViewData,
  fields?: string[]
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    ...entry.issue,
    event: entry.event,
    org: entry.org,
    replayIds: entry.replayIds,
    trace: entry.trace,
  };
  return fields && fields.length > 0
    ? (filterFields(result, fields) as Record<string, unknown>)
    : result;
}

/**
 * Transform issue views for JSON output.
 *
 * A single requested issue preserves the historical flat-object shape.
 * Multiple requested issues always produce an array, including after partial
 * failures, so the output shape never depends on which request succeeded.
 *
 * @param data - Aggregate issue view output
 * @param fields - Optional issue fields to retain
 * @returns A flat issue object for one request, otherwise an array
 */
export function jsonTransformIssueView(
  data: IssueViewData,
  fields?: string[]
): unknown {
  if (data.requestedCount <= 1) {
    const [first] = data.issues;
    if (first) {
      return flattenIssueView(first, fields);
    }
  }
  return data.issues.map((entry) => flattenIssueView(entry, fields));
}
