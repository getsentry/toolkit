/**
 * Decoded one-line summaries of retained envelopes for `local event list`, so
 * agents can pick what to open without one `event view` call per entry.
 */

import { summarizeEvent } from "../../lib/formatters/local.js";
import { stripAnsi } from "../../lib/formatters/strip-ansi.js";
import type { ParsedReceiverEnvelope } from "./envelope.js";
import { sessionCountsTitle } from "./session-counts.js";
import { parseEventTimestamp } from "./timestamp.js";

/** What an envelope holds, read from its main item. Every field is optional. */
type LocalEventDetails = {
  /**
   * `error` (event with a typed exception), `message` (event without one,
   * such as `captureMessage` or Python `logging`), or the item type:
   * `transaction`, `log`, `span`, `session`, `client_report`, ….
   */
  type?: string | undefined;
  /** Event or log level, e.g. `error`, `warning`, `info`. */
  level?: string | undefined;
  /** `TypeError: msg` for errors, the text for messages and logs, or the transaction or span name. */
  title?: string | undefined;
  /** When the SDK recorded it, as an ISO 8601 string. */
  timestamp?: string | undefined;
  /** 32-character trace ID, when the item or envelope header has one. */
  traceId?: string | undefined;
  /** Number of logs or spans in a log or span batch; unset for a standalone span. */
  count?: number | undefined;
};

type Item = ParsedReceiverEnvelope["envelope"][1][number];

/** Item types that carry one event each, preferred as an envelope's main item. */
const EVENT_ITEM_TYPES = new Set(["event", "transaction"]);

/** Item types that can hold an `items` array of logs or spans. */
const CONTAINER_ITEM_TYPES = new Set(["log", "span"]);

const TRACE_ID_RE = /^[0-9a-f]{32}$/i;

/** Longest title kept in a summary; longer ones end in `…`. */
const MAX_TITLE_LENGTH = 200;

/** Log levels from least to most severe; logs send `warn`, events `warning`. */
const LOG_LEVEL_ORDER = [
  "trace",
  "debug",
  "info",
  "warn",
  "warning",
  "error",
  "fatal",
];

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

/** A log's trace ID, from the log or its `sentry.trace.trace_id` attribute. */
function logTraceId(log: Record<string, unknown>): string | undefined {
  return (
    traceId(log["trace_id"]) ??
    traceId(record(record(log["attributes"])["sentry.trace.trace_id"])["value"])
  );
}

/** Severity rank of a log level; unknown levels rank lowest. */
function levelRank(level: unknown): number {
  return typeof level === "string"
    ? LOG_LEVEL_ORDER.indexOf(level.toLowerCase())
    : -1;
}

/** The first log with the batch's most severe level. */
function mostSevereLog(
  logs: Record<string, unknown>[],
): Record<string, unknown> {
  return logs.reduce(
    (worst, log) =>
      levelRank(log["level"]) > levelRank(worst["level"]) ? log : worst,
    logs[0] ?? {},
  );
}

/**
 * The span that names a batch: the one the SDK marks `is_segment`, else the
 * first span whose parent is not in the batch, else the first span. SDKs list
 * child spans first, because they end first.
 */
function segmentRoot(
  spans: Record<string, unknown>[],
): Record<string, unknown> {
  const ids = new Set(spans.map((span) => span["span_id"]));
  return (
    spans.find((span) => span["is_segment"] === true) ??
    spans.find(
      (span) =>
        typeof span["parent_span_id"] !== "string" ||
        !ids.has(span["parent_span_id"]),
    ) ??
    spans[0] ??
    {}
  );
}

/**
 * Summarize a log batch, or a span item: a v2 batch with an `items` array, or
 * a standalone span whose payload is the span itself. A log batch takes its
 * level, title, and time from its most severe log; a span batch takes its
 * title and time from its segment root.
 */
function summarizeContainer(
  itemType: string,
  payload: Record<string, unknown>,
): LocalEventDetails {
  if (itemType === "span" && !Array.isArray(payload["items"])) {
    return {
      type: "span",
      title:
        text(payload["description"]) ??
        text(payload["name"]) ??
        text(payload["op"]),
      timestamp: isoTimestamp(
        payload["timestamp"] ??
          payload["end_timestamp"] ??
          payload["start_timestamp"],
      ),
      traceId: traceId(payload["trace_id"]),
    };
  }
  const entries = (Array.isArray(payload["items"]) ? payload["items"] : []).map(
    record,
  );
  if (itemType === "log") {
    const log = mostSevereLog(entries);
    return {
      type: "log",
      level: text(log["level"]),
      title: text(log["body"]),
      timestamp: isoTimestamp(log["timestamp"]),
      traceId: logTraceId(log) ?? entries.map(logTraceId).find(Boolean),
      count: entries.length,
    };
  }
  const root = segmentRoot(entries);
  return {
    type: "span",
    title: text(root["name"]),
    timestamp: isoTimestamp(root["end_timestamp"] ?? root["start_timestamp"]),
    traceId: traceId(root["trace_id"]),
    count: entries.length,
  };
}

/**
 * Drop ANSI colors from a title, which colored log formatters (werkzeug,
 * uvicorn) put in log text, and cut a long one (a big log body or exception
 * message) to one line's worth.
 */
function shortTitle(details: LocalEventDetails): LocalEventDetails {
  if (!details.title) {
    return details;
  }
  const title = stripAnsi(details.title);
  return {
    ...details,
    title:
      title.length > MAX_TITLE_LENGTH
        ? `${title.slice(0, MAX_TITLE_LENGTH - 1)}…`
        : title,
  };
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
  const headerTraceId = traceId(record(header["trace"])["trace_id"]);
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
    level: text(payload["level"]),
    title:
      text(payload["transaction"]) ??
      text(payload["status"]) ??
      (itemType === "sessions" ? sessionCountsTitle(payload) : undefined),
    ...(itemType === "event" ? summarizeEventItem(payload) : {}),
    timestamp: isoTimestamp(payload["timestamp"]),
    traceId:
      (isEvent
        ? traceId(record(record(payload["contexts"])["trace"])["trace_id"])
        : undefined) ?? headerTraceId,
  });
}
