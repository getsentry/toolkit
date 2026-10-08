/**
 * Human-readable formatting for modern Sentry User Feedback.
 *
 * Feedback and enriched event strings are untrusted. Sanitize them before
 * passing them to Markdown, table, or shared event renderers.
 */

import type { EventAttachmentDetailsResponse } from "@sentry/api";
import wrapAnsi from "wrap-ansi";
import type {
  FeedbackListResult,
  FeedbackViewResult,
  SentryEvent,
  SentryFeedback,
  SentryIssue,
} from "../../types/index.js";
import { getReplayIdFromEvent } from "../replay-search.js";
import { formatEventDetails } from "./human.js";
import {
  colorTag,
  escapeMarkdownCell,
  escapeMarkdownInline,
  mdKvTable,
  renderMarkdown,
  safeCodeSpan,
} from "./markdown.js";
import { formatBytes } from "./numbers.js";
import { stripAnsi } from "./plain-detect.js";
import { type Column, formatTable } from "./table.js";
import { formatRelativeTime } from "./time-utils.js";

const MAX_REPLAY_IDS_SHOWN = 3;
const MAX_LIST_MESSAGE_LENGTH = 160;
const COMPACT_LIST_BREAKPOINT = 100;
const LINE_BREAK_RE = /\n/g;
const C1_CSI_RE = /\u009b[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g;
const FEEDBACK_UNSAFE_TERMINAL_RE =
  // oxlint-disable-next-line no-control-regex -- terminal sanitization requires matching control characters
  /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Confirm resolution using the updated Feedback's terminal-safe identifier. */
export function formatResolvedFeedback(feedback: SentryIssue): string {
  return renderMarkdown(
    `Resolved feedback ${feedbackCodeSpan(feedback.shortId)}.`,
  );
}

/** Confirm reopening using the updated Feedback's terminal-safe identifier. */
export function formatReopenedFeedback(feedback: SentryIssue): string {
  return renderMarkdown(
    `Reopened feedback ${feedbackCodeSpan(feedback.shortId)}.`,
  );
}

/** Confirm spam using the updated Feedback's terminal-safe identifier. */
export function formatSpamFeedback(feedback: SentryIssue): string {
  return renderMarkdown(
    `Marked feedback ${feedbackCodeSpan(feedback.shortId)} as spam.`,
  );
}

/** Remove terminal controls while preserving intentional message line breaks. */
function sanitizeFeedbackText(value: string): string {
  return stripAnsi(value)
    .replace(C1_CSI_RE, "")
    .replace(/\r\n?/g, "\n")
    .replace(FEEDBACK_UNSAFE_TERMINAL_RE, "");
}

function sanitizeFeedbackInline(value: string): string {
  return sanitizeFeedbackText(value).replace(/\n+/g, " ");
}

function escapeFeedbackInline(value: string): string {
  return escapeMarkdownInline(sanitizeFeedbackInline(value));
}

function escapeFeedbackCell(value: string): string {
  return escapeMarkdownCell(sanitizeFeedbackInline(value));
}

function feedbackCodeSpan(value: string): string {
  return safeCodeSpan(sanitizeFeedbackInline(value));
}

/** Recursively sanitize event strings and keys before human rendering. */
function sanitizeFeedbackEventValue(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeFeedbackText(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeFeedbackEventValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        sanitizeFeedbackInline(key),
        sanitizeFeedbackEventValue(nestedValue),
      ]),
    );
  }
  return value;
}

/** Build a human-only event copy; the raw event used for JSON remains unchanged. */
function sanitizeFeedbackEvent(event: SentryEvent): SentryEvent {
  return sanitizeFeedbackEventValue(event) as SentryEvent;
}

function feedbackSender(feedback: SentryFeedback): string {
  const name = feedback.metadata.name
    ? sanitizeFeedbackInline(feedback.metadata.name).trim()
    : undefined;
  const email = feedback.metadata.contact_email
    ? sanitizeFeedbackInline(feedback.metadata.contact_email).trim()
    : undefined;
  if (name && email && name !== email) {
    return `${name} <${email}>`;
  }
  return name || email || "Anonymous User";
}

function feedbackMessage(feedback: SentryFeedback): string {
  return sanitizeFeedbackText(
    feedback.metadata.message ||
      feedback.metadata.value ||
      feedback.metadata.title ||
      feedback.title,
  );
}

function feedbackMessagePreview(feedback: SentryFeedback): string {
  const message = feedbackMessage(feedback).replace(LINE_BREAK_RE, " ");
  return message.length > MAX_LIST_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_LIST_MESSAGE_LENGTH - 1)}…`
    : message;
}

function feedbackStatus(feedback: SentryFeedback): string {
  switch (feedback.status) {
    case "ignored":
      return colorTag("muted", "Spam");
    case "resolved":
      return colorTag("green", "Resolved");
    case "unresolved":
      return colorTag("yellow", "Unresolved");
    default:
      return escapeFeedbackInline(feedback.status ?? "Unknown");
  }
}

function feedbackReadState(feedback: SentryFeedback): string {
  if (feedback.hasSeen === undefined) {
    return colorTag("muted", "Unknown");
  }
  return feedback.hasSeen
    ? colorTag("muted", "Read")
    : colorTag("blue", "Unread");
}

const FEEDBACK_COLUMNS: Column<SentryFeedback>[] = [
  {
    header: "ID",
    value: (feedback) =>
      feedback.permalink
        ? `[${escapeFeedbackInline(feedback.shortId)}](${feedback.permalink})`
        : feedbackCodeSpan(feedback.shortId),
    minWidth: 8,
    shrinkable: false,
  },
  {
    header: "RECEIVED",
    value: (feedback) => formatRelativeTime(feedback.firstSeen ?? undefined),
    minWidth: 10,
  },
  {
    header: "FROM",
    value: (feedback) => escapeFeedbackCell(feedbackSender(feedback)),
    minWidth: 12,
    truncate: true,
  },
  {
    header: "MESSAGE",
    value: (feedback) => escapeFeedbackCell(feedbackMessage(feedback)),
    minWidth: 16,
    truncate: true,
  },
  {
    header: "STATUS",
    value: feedbackStatus,
    minWidth: 8,
    shrinkable: false,
  },
  {
    header: "READ",
    value: feedbackReadState,
    minWidth: 6,
    shrinkable: false,
  },
  {
    header: "PROJECT",
    value: (feedback) =>
      escapeFeedbackCell(feedback.project?.slug ?? "unknown"),
    minWidth: 7,
  },
];

function formatCompactFeedbackList(
  result: FeedbackListResult,
  scope: string,
  width: number,
): string {
  const sections = result.feedback.map((feedback) => {
    const id = feedback.permalink
      ? `[${escapeFeedbackInline(feedback.shortId)}](${feedback.permalink})`
      : feedbackCodeSpan(feedback.shortId);
    return [
      `### ${id}`,
      "",
      `- **Received:** ${formatRelativeTime(feedback.firstSeen ?? undefined)}`,
      `- **From:** ${escapeFeedbackInline(feedbackSender(feedback))}`,
      `- **Message:** ${escapeFeedbackInline(feedbackMessagePreview(feedback))}`,
      `- **Status:** ${feedbackStatus(feedback)}`,
      `- **Read:** ${feedbackReadState(feedback)}`,
      `- **Project:** ${escapeFeedbackInline(feedback.project?.slug ?? "unknown")}`,
    ].join("\n");
  });
  const markdown = [
    `## Feedback in ${escapeFeedbackInline(scope)}`,
    "",
    ...sections,
  ].join("\n\n");
  return wrapAnsi(renderMarkdown(markdown), width, {
    hard: true,
    trim: false,
    wordWrap: true,
  });
}

/** Format a page of Feedback as a terminal-width-aware table. */
export function formatFeedbackList(result: FeedbackListResult): string {
  if (result.feedback.length === 0) {
    return result.hasMore || result.hasPrev
      ? "No feedback on this page."
      : "No feedback found.";
  }

  const scope = result.project
    ? `${result.org}/${result.project}`
    : `${result.org} (all projects)`;
  const terminalWidth = process.stdout.columns || 80;
  if (terminalWidth < COMPACT_LIST_BREAKPOINT) {
    return formatCompactFeedbackList(result, scope, terminalWidth);
  }
  return `Feedback in ${scope}:\n\n${formatTable(result.feedback, FEEDBACK_COLUMNS, { truncate: true })}`;
}

function isFeedbackContext(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function feedbackContext(
  event: SentryEvent | null,
): Record<string, unknown> | undefined {
  const context = event?.contexts?.feedback;
  return isFeedbackContext(context) ? context : undefined;
}

function feedbackUrl(event: SentryEvent | null): string | undefined {
  const contextUrl = feedbackContext(event)?.url;
  if (typeof contextUrl === "string" && contextUrl) {
    return contextUrl;
  }
  return event?.tags?.find((tag) => tag.key === "url")?.value;
}

function linkedEventId(data: FeedbackViewResult): string | undefined {
  const contextId = feedbackContext(data.event)?.associated_event_id;
  if (typeof contextId === "string" && contextId) {
    return contextId;
  }
  const metadataId = data.feedback.metadata.associated_event_id;
  return typeof metadataId === "string" && metadataId ? metadataId : undefined;
}

function formatFeedbackOverview(data: FeedbackViewResult): string {
  const { feedback } = data;
  const rows: [string, string][] = [
    ["Status", feedbackStatus(feedback)],
    ["Read", feedbackReadState(feedback)],
    ["From", escapeFeedbackInline(feedbackSender(feedback))],
    ["Received", formatRelativeTime(feedback.firstSeen ?? undefined)],
  ];

  if (feedback.project) {
    rows.push([
      "Project",
      `${escapeFeedbackInline(feedback.project.name ?? feedback.project.slug)} (${feedbackCodeSpan(feedback.project.slug)})`,
    ]);
  }
  if (feedback.assignedTo?.name) {
    rows.push(["Assignee", escapeFeedbackInline(feedback.assignedTo.name)]);
  }
  if (feedback.metadata.source) {
    rows.push(["Source", feedbackCodeSpan(feedback.metadata.source)]);
  }
  if (feedback.metadata.sdk?.name) {
    rows.push([
      "SDK",
      feedbackCodeSpan(
        feedback.metadata.sdk.name_normalized ?? feedback.metadata.sdk.name,
      ),
    ]);
  }

  const url = feedbackUrl(data.event);
  if (url) {
    rows.push(["URL", feedbackCodeSpan(url)]);
  }

  const associatedEventId = linkedEventId(data);
  if (associatedEventId) {
    const project = feedback.project?.slug;
    const command =
      data.org && project
        ? `sentry event view ${data.org}/${project}/${associatedEventId}`
        : `sentry event view ${associatedEventId}`;
    rows.push(["Linked error", feedbackCodeSpan(command)]);
  }

  if (feedback.permalink) {
    rows.push(["Sentry", `[Open feedback](${feedback.permalink})`]);
  }

  const lines = [
    `## ${escapeFeedbackInline(feedback.shortId)}: User Feedback`,
    "",
    mdKvTable(rows),
    "",
    "### Message",
    "",
    ...feedbackMessage(feedback)
      .split(LINE_BREAK_RE)
      .map((line) => `> ${escapeFeedbackInline(line)}`),
  ];

  if (feedback.metadata.summary) {
    lines.push(
      "",
      "### Summary",
      "",
      escapeFeedbackInline(feedback.metadata.summary),
    );
  }

  return renderMarkdown(lines.join("\n"));
}

function formatRelatedReplays(data: FeedbackViewResult): string {
  const eventReplayId = data.event
    ? getReplayIdFromEvent(data.event)
    : undefined;
  const additionalIds = eventReplayId
    ? data.replayIds.filter((replayId) => replayId !== eventReplayId)
    : data.replayIds;
  if (additionalIds.length === 0) {
    return "";
  }

  const lines = ["### Additional Replays", ""];
  for (const replayId of additionalIds.slice(0, MAX_REPLAY_IDS_SHOWN)) {
    const command = data.org
      ? `sentry replay view ${data.org}/${replayId}`
      : `sentry replay view ${replayId}`;
    lines.push(
      `- ${feedbackCodeSpan(replayId)} (${feedbackCodeSpan(command)})`,
    );
  }
  const remaining = additionalIds.length - MAX_REPLAY_IDS_SHOWN;
  if (remaining > 0) {
    lines.push(`- ${remaining} more`);
  }
  return renderMarkdown(lines.join("\n"));
}

function formatAttachment(attachment: EventAttachmentDetailsResponse): string {
  const details = [attachment.mimetype, formatBytes(attachment.size)]
    .filter(Boolean)
    .join(", ");
  return `- ${escapeFeedbackInline(attachment.name)}${details ? ` (${escapeFeedbackInline(details)})` : ""} — ${feedbackCodeSpan(attachment.id)}`;
}

function formatAttachments(
  attachments: EventAttachmentDetailsResponse[],
): string {
  if (attachments.length === 0) {
    return "";
  }
  return renderMarkdown(
    ["### Attachments", "", ...attachments.map(formatAttachment)].join("\n"),
  );
}

/** Format a Feedback item plus its best-effort event enrichments. */
export function formatFeedbackView(data: FeedbackViewResult): string {
  const sections = [formatFeedbackOverview(data)];
  if (data.event) {
    sections.push(
      formatEventDetails(
        sanitizeFeedbackEvent(data.event),
        "Latest Feedback Event",
        data.feedback.permalink,
      ),
    );
  }
  const replays = formatRelatedReplays(data);
  if (replays) {
    sections.push(replays);
  }
  const attachments = formatAttachments(data.attachments);
  if (attachments) {
    sections.push(attachments);
  }
  return sections.join("\n\n");
}
