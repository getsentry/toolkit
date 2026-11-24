/**
 * Human output for `local session list`, `local event list`, and
 * `local envelope list`. `--json` prints the control plane's answer as is.
 */

import { tableCell } from "@sentry/toolkit-core/markdown";
import { uniqueEventIdPrefixes } from "../../commands/local/event-lookup.js";
import type { LocalSession } from "../../commands/local/session-store.js";
import { sanitize } from "./local.js";
import { colorTag } from "./markdown.js";
import { type Column, formatTable } from "./table.js";
import { formatLocalTime, formatRelativeTime } from "./time-utils.js";

/** One `local event list` entry, as the control plane describes it. */
type LocalEventListEntry = {
  readonly eventId: string;
  readonly type?: string;
  readonly level?: string;
  readonly title?: string;
  /** When the SDK recorded it, ISO 8601. */
  readonly timestamp?: string;
  /** When the receiver accepted the envelope, ISO 8601. */
  readonly receivedAt?: string;
  /** Logs in a log batch, or the spans of a span batch the tail counts. */
  readonly count?: number;
};

/** One `local envelope list` entry. */
type LocalEnvelopeListEntry = {
  readonly id: string;
  readonly itemTypes: readonly string[];
};

const MISSING = colorTag("muted", "—");

/** Untrusted SDK or user text, made safe for one table cell. */
function cell(value: string | undefined): string {
  return value ? tableCell(sanitize(value)) : MISSING;
}

/** The array at `data[key]`, or none when the daemon sent something else. */
function listOf<T>(data: Record<string, unknown>, key: string): T[] {
  const value = data[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

const SESSION_COLUMNS: Column<LocalSession>[] = [
  { header: "ID", value: (session) => session.id, shrinkable: false },
  { header: "NAME", value: (session) => cell(session.label) },
  {
    header: "STATE",
    value: (session) => (session.state === "open" ? "open" : "closed"),
  },
  {
    header: "ACTIVE",
    value: (session) =>
      Number.isFinite(session.lastActivityAt)
        ? formatRelativeTime(new Date(session.lastActivityAt).toISOString())
        : MISSING,
  },
  {
    header: "DIRECTORY",
    value: (session) => cell(session.cwd),
    minWidth: "DIRECTORY".length,
  },
];

/** Format `local session list` output as a table of sessions. */
export function formatLocalSessionList(data: Record<string, unknown>): string {
  const sessions = listOf<LocalSession>(data, "sessions");
  if (sessions.length === 0) {
    return "No Local sessions found.";
  }
  return formatTable(sessions, SESSION_COLUMNS, { truncate: true });
}

/**
 * Format `local event list` output as a table. Each event shows the shortest
 * ID prefix (8 or more characters) that `local event view` opens.
 */
export function formatLocalEventList(data: Record<string, unknown>): string {
  const events = listOf<LocalEventListEntry>(data, "events");
  if (events.length === 0) {
    return "No events found.";
  }
  const prefixes = uniqueEventIdPrefixes(events.map(({ eventId }) => eventId));
  const columns: Column<LocalEventListEntry>[] = [
    {
      header: "ID",
      value: ({ eventId }) => cell(prefixes.get(eventId) ?? eventId),
      shrinkable: false,
    },
    {
      header: "TYPE",
      // Like the tail, which prints no `[0 spans]`.
      value: ({ type, count }) =>
        count ? `${cell(type)} (${count})` : cell(type),
    },
    { header: "LEVEL", value: ({ level }) => cell(level) },
    { header: "TITLE", value: ({ title }) => cell(title) },
    {
      header: "TIME",
      value: ({ timestamp, receivedAt }) =>
        formatLocalTime(timestamp ?? receivedAt),
      shrinkable: false,
    },
  ];
  return formatTable(events, columns, { truncate: true });
}

const ENVELOPE_COLUMNS: Column<LocalEnvelopeListEntry>[] = [
  { header: "ID", value: ({ id }) => cell(id), shrinkable: false },
  {
    header: "ITEMS",
    value: ({ itemTypes }) => cell(itemTypes.join(", ")),
  },
];

/** Format `local envelope list` output as a table of envelope IDs and item types. */
export function formatLocalEnvelopeList(data: Record<string, unknown>): string {
  const envelopes = listOf<LocalEnvelopeListEntry>(data, "envelopes");
  if (envelopes.length === 0) {
    return "No envelopes found.";
  }
  return formatTable(envelopes, ENVELOPE_COLUMNS, { truncate: true });
}
