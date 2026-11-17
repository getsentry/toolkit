/**
 * Issue view output types and formatters.
 */

import type { InferOutput } from "valibot";
import type { SentryIssue } from "../../types/index.js";
import { sentry } from "../app-identity.js";
import { getReplayIdFromEvent } from "../replay-search.js";
import { formatEventDetails, formatIssueDetails } from "./human.js";
import { filterFieldsIfSet } from "./json.js";
import { renderMarkdown } from "./markdown.js";
import type { IssueViewOutputFields } from "../../output-schemas/issue.js";

/**
 * Data rendered for one issue: the issue, and the fields JSON output adds to
 * it ({@link IssueViewOutputFields}: the resolved org, or null when
 * resolution was unscoped; the latest event, or null when it could not be
 * loaded; related replays; the trace, or null when unavailable).
 */
export type SingleIssueViewData = InferOutput<typeof IssueViewOutputFields> & {
  /** Full issue details. */
  issue: SentryIssue;
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
        `- \`${replayId}\` (view: \`${sentry`replay view ${org}/${replayId}`}\`)`,
      );
    } else {
      lines.push(`- \`${replayId}\``);
    }
  }

  const remainingCount = replayIds.length - visibleReplayIds.length;
  if (remainingCount > 0) {
    lines.push(
      `- ${remainingCount} more related replay${remainingCount === 1 ? "" : "s"}`,
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
      formatEventDetails(data.event, "Latest Event", data.issue.permalink),
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

function flattenIssueView(entry: SingleIssueViewData, fields?: string[]) {
  return filterFieldsIfSet(
    {
      ...entry.issue,
      event: entry.event,
      org: entry.org,
      replayIds: entry.replayIds,
      trace: entry.trace,
    },
    fields,
  );
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
export function jsonTransformIssueView(data: IssueViewData, fields?: string[]) {
  if (data.requestedCount <= 1) {
    const [first] = data.issues;
    if (first) {
      return flattenIssueView(first, fields);
    }
  }
  return data.issues.map((entry) => flattenIssueView(entry, fields));
}
