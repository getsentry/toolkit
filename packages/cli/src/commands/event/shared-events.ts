/**
 * Shared types, constants, formatters, and flag definitions for event listing.
 *
 * Used by both `sentry issue events` and `sentry event list` which share the
 * same API call (listIssueEvents) and output format but have distinct command
 * identities and pagination hints.
 */

import { validateLimit } from "../../lib/arg-parsing.js";
import { filterFields } from "../../lib/formatters/json.js";
import { colorTag, escapeMarkdownCell } from "../../lib/formatters/markdown.js";
import { type Column, formatTable } from "../../lib/formatters/table.js";
import { formatRelativeTime } from "../../lib/formatters/time-utils.js";
import {
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  LIST_MIN_LIMIT,
  LIST_PERIOD_FLAG,
  PERIOD_ALIASES,
} from "../../lib/list-command.js";
import { sanitizeQuery } from "../../lib/search-query.js";
import { appendPeriodHint, type TimeRange } from "../../lib/time-range.js";
import type { IssueEvent } from "../../types/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Flags shared by event listing commands. */
export type EventsFlags = {
  readonly limit: number;
  readonly query?: string;
  readonly full: boolean;
  readonly period: TimeRange;
  readonly json: boolean;
  readonly cursor?: string;
  readonly fresh: boolean;
  readonly fields?: string[];
};

/**
 * Result data for event listing commands.
 *
 * Contains the events array plus pagination metadata and context
 * needed by both the human formatter and JSON transform.
 */
export type EventsResult = {
  /** The list of events returned by the API */
  events: IssueEvent[];
  /** Whether more pages are available */
  hasMore: boolean;
  /** Whether a previous page exists (for bidirectional hints) */
  hasPrev: boolean;
  /** Opaque cursor for fetching the next page */
  nextCursor?: string | null;
  /** The issue short ID (for display in header) */
  issueShortId: string;
  /** The numeric issue ID (for pagination context) */
  issueId: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default time period for event queries */
export const DEFAULT_PERIOD = "7d";

// ---------------------------------------------------------------------------
// Table columns
// ---------------------------------------------------------------------------

/** Extract a display label for the event's user, falling back through available fields. */
function getUserLabel(event: IssueEvent): string {
  if (!event.user) {
    return colorTag("muted", "—");
  }
  const label =
    event.user.email ??
    event.user.username ??
    event.user.ip_address ??
    event.user.id;
  return label ? escapeMarkdownCell(label) : colorTag("muted", "—");
}

/**
 * Table columns for event listing.
 *
 * The event ID is printed in full. Sentry search cannot match a partial
 * event ID, and agents copy this cell into `sentry event view`. A 12-char
 * prefix (the old display) then fails lookup on any project whose event
 * is not in the newest page.
 */
export const EVENT_COLUMNS: Column<IssueEvent>[] = [
  {
    header: "EVENT ID",
    value: (e) => `\`${e.eventID}\``,
    shrinkable: false,
  },
  {
    header: "TIMESTAMP",
    value: (e) => formatRelativeTime(e.dateCreated),
  },
  {
    header: "TITLE",
    value: (e) => escapeMarkdownCell(e.title),
    truncate: true,
  },
  {
    header: "PLATFORM",
    value: (e) => escapeMarkdownCell(e.platform ?? "—"),
  },
  {
    header: "USER",
    value: getUserLabel,
  },
];

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/**
 * Format event list data for human-readable terminal output.
 *
 * Handles three display states:
 * - Empty list with more pages → "No events on this page."
 * - Empty list, no more pages → "No events found for this issue."
 * - Non-empty → header line + formatted table
 */
export function formatEventsHuman(result: EventsResult): string {
  const { events, hasMore, issueShortId } = result;

  if (events.length === 0) {
    return hasMore
      ? "No events on this page."
      : "No events found for this issue.";
  }

  // Wider than a default 80-column terminal so the 32-char event ID stays
  // on one line and does not force the title into a few characters.
  return `Events for ${issueShortId}:\n\n${formatTable(events, EVENT_COLUMNS, { maxWidth: 160 })}`;
}

/**
 * Transform event list data into the JSON list envelope.
 *
 * Produces the standard `{ data, hasMore, hasPrev, nextCursor? }` envelope.
 * Field filtering is applied per-element inside `data`.
 */
export function jsonTransformEvents(
  result: EventsResult,
  fields?: string[]
): unknown {
  const items =
    fields && fields.length > 0
      ? result.events.map((e) => filterFields(e, fields))
      : result.events;

  const envelope: Record<string, unknown> = {
    data: items,
    hasMore: result.hasMore,
    hasPrev: result.hasPrev,
  };
  if (
    result.nextCursor !== null &&
    result.nextCursor !== undefined &&
    result.nextCursor !== ""
  ) {
    envelope.nextCursor = result.nextCursor;
  }
  return envelope;
}

// ---------------------------------------------------------------------------
// Pagination hints
// ---------------------------------------------------------------------------

/** Append active non-default flags to a base command string. */
export function appendEventsFlags(
  base: string,
  flags: Pick<EventsFlags, "query" | "full" | "period">
): string {
  const parts: string[] = [];
  if (flags.query) {
    parts.push(`-q "${flags.query}"`);
  }
  if (flags.full) {
    parts.push("--full");
  }
  appendPeriodHint(parts, flags.period, DEFAULT_PERIOD);
  return parts.length > 0 ? `${base} ${parts.join(" ")}` : base;
}

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

/** Parse --limit flag, delegating range validation to shared utility. */
export function parseLimit(value: string): number {
  return validateLimit(value, LIST_MIN_LIMIT, LIST_MAX_LIMIT);
}

// ---------------------------------------------------------------------------
// Shared flag and alias definitions
// ---------------------------------------------------------------------------

/** Stricli flag definitions shared by event listing commands. */
export const EVENTS_FLAGS = {
  limit: {
    kind: "parsed",
    parse: parseLimit,
    brief: `Number of events (${LIST_MIN_LIMIT}-${LIST_MAX_LIMIT})`,
    default: String(LIST_DEFAULT_LIMIT),
  },
  query: {
    kind: "parsed",
    parse: sanitizeQuery,
    brief: "Search query (Sentry search syntax)",
    optional: true,
  },
  full: {
    kind: "boolean",
    brief: "Include full event body (stacktraces)",
    default: false,
  },
  period: LIST_PERIOD_FLAG,
} as const;

/** Stricli alias definitions shared by event listing commands. */
export const EVENTS_ALIASES = {
  ...PERIOD_ALIASES,
  n: "limit",
  q: "query",
} as const;
