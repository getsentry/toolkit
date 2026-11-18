/**
 * Decoded one-line summaries of retained envelopes for `local event list`, so
 * agents can pick what to open without one `event view` call per entry.
 */

import { summarizeEvent } from "../../lib/formatters/local.js";
import type { ParsedReceiverEnvelope } from "./envelope.js";
import { parseEventTimestamp } from "./timestamp.js";

/** What an envelope holds, read from its main item. Every field is optional. */
type LocalEventDetails = {
  /**
   * `error` (event with a typed exception), `message` (event without one,
   * such as `captureMessage` or Python `logging`), or the item type:
   * `transaction`, `log`, `span`, `session`, `client_report`, ….
   */
  type?: string;
  /** Event or log level, e.g. `error`, `warning`, `info`. */
  level?: string;
  /** `TypeError: msg` for errors, the text for messages and logs, or the transaction or span name. */
  title?: string;
  /** When the SDK recorded it, as an ISO 8601 string. */
  timestamp?: string;
  /** 32-character trace ID, when the item or envelope header has one. */
  traceId?: string;
  /** Number of logs or spans in a log or span batch; unset for a standalone span. */
  count?: number;
};

type Item = ParsedReceiverEnvelope["envelope"][1][number];

/** Item types that carry one event each, preferred as an envelope's main item. */
const EVENT_ITEM_TYPES = new Set(["event", "transaction"]);

/** Item types that can hold an `items` array of logs or spans. */
const CONTAINER_ITEM_TYPES = new Set(["log", "span"]);

const TRACE_ID_RE = /^[0-9a-f]{32}$/i;

/** Longest title kept in a summary; longer ones end in `…`. */
const MAX_TITLE_LENGTH = 200;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function traceId(value: unknown): string | undefined {
  return typeof value === "string" && TRACE_ID_RE.test(value)
    ? value.toLowerCase()
    : undefined;
}

/**
 * Convert an SDK timestamp to ISO 8601 with the parser the tail and viewer
 * use: epoch seconds, numeric strings, and ISO strings, with a time that has
 * no timezone read as UTC.
 */
function isoTimestamp(value: unknown): string | undefined {
  const seconds = parseEventTimestamp(value);
  if (seconds === undefined) {
    return;
  }
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Summarize an `event` item the way the tail labels it, so `event list` and
 * the tail agree on type, level, and title.
 */
function summarizeEventItem(
  payload: Record<string, unknown>,
): Pick<LocalEventDetails, "type" | "level" | "title"> {
  const summary = summarizeEvent(payload);
  return {
    type: summary.kind,
    level: summary.level,
    title:
      summary.kind === "error"
        ? `${summary.errorType}: ${summary.text}`
        : summary.text,
  };
}

/**
 * Summarize a log batch, or a span item: a v2 batch with an `items` array, or
 * a standalone span whose payload is the span itself.
 */
function summarizeContainer(
  itemType: string,
  payload: Record<string, unknown>,
): LocalEventDetails {
  if (itemType === "span" && !Array.isArray(payload.items)) {
    return {
      type: "span",
      title:
        text(payload.description) ?? text(payload.name) ?? text(payload.op),
      timestamp: isoTimestamp(
        payload.timestamp ?? payload.end_timestamp ?? payload.start_timestamp,
      ),
      traceId: traceId(payload.trace_id),
    };
  }
  const entries = Array.isArray(payload.items) ? payload.items : [];
  const first = record(entries[0]);
  if (itemType === "log") {
    const attributes = record(first.attributes);
    return {
      type: "log",
      level: text(first.level),
      title: text(first.body),
      timestamp: isoTimestamp(first.timestamp),
      traceId:
        traceId(first.trace_id) ??
        traceId(record(attributes["sentry.trace.trace_id"]).value),
      count: entries.length,
    };
  }
  return {
    type: "span",
    title: text(first.name),
    timestamp: isoTimestamp(first.end_timestamp ?? first.start_timestamp),
    traceId: traceId(first.trace_id),
    count: entries.length,
  };
}

/** Cut a long title (a big log body or exception message) to one line's worth. */
function shortTitle(details: LocalEventDetails): LocalEventDetails {
  const { title } = details;
  return title && title.length > MAX_TITLE_LENGTH
    ? { ...details, title: `${title.slice(0, MAX_TITLE_LENGTH - 1)}…` }
    : details;
}

/** Pick the item that best describes the envelope. */
function mainItem(items: Item[]): Item | undefined {
  return (
    items.find(([header]) => EVENT_ITEM_TYPES.has(String(header.type))) ??
    items.find(([header]) => CONTAINER_ITEM_TYPES.has(String(header.type))) ??
    items[0]
  );
}

/**
 * Summarize a decoded envelope from its main item: the first event or
 * transaction, else the first log or span container, else the first item.
 * Falls back to the envelope header's trace context for the trace ID, and
 * cuts titles to {@link MAX_TITLE_LENGTH} characters.
 */
export function summarizeEnvelope(
  parsed: ParsedReceiverEnvelope,
): LocalEventDetails {
  const [header, items] = parsed.envelope;
  const headerTraceId = traceId(record(header.trace).trace_id);
  const item = mainItem(items);
  if (!item) {
    return { traceId: headerTraceId };
  }
  const [itemHeader, payload] = item;
  const itemType = text(itemHeader.type) ?? "unknown";

  if (CONTAINER_ITEM_TYPES.has(itemType)) {
    const details = summarizeContainer(itemType, payload);
    return shortTitle({
      ...details,
      traceId: details.traceId ?? headerTraceId,
    });
  }

  const isEvent = EVENT_ITEM_TYPES.has(itemType);
  return shortTitle({
    type: itemType,
    level: text(payload.level),
    title: text(payload.transaction) ?? text(payload.status),
    ...(itemType === "event" ? summarizeEventItem(payload) : {}),
    timestamp: isoTimestamp(payload.timestamp),
    traceId:
      (isEvent
        ? traceId(record(record(payload.contexts).trace).trace_id)
        : undefined) ?? headerTraceId,
  });
}
