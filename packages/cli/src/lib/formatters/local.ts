/** Tail formatters for the local dev server. */

import { parseEventTimestamp } from "../../commands/local/timestamp.js";
import {
  formatLocalServerUrl,
  getLocalUiConnectionUrl,
} from "../../commands/local/ui.js";
import { stringifyUnknown } from "../errors.js";
import { logger } from "../logger.js";
import { blue, bold, cyan, green, muted, red, yellow } from "./colors.js";
import { stripAnsi } from "./plain-detect.js";
import type { AttributeSource } from "./semantic-display.js";
import {
  collectSpanAttributes,
  formatSemanticSpanDisplay,
  hasAiAttributes,
  inferSemanticOp,
  mergeTransactionAttributes,
} from "./semantic-display.js";

const log = logger.withTag("local-formatter");

/**
 * Characters unsafe for JSON terminal display: C1 control characters
 * (U+0080–U+009F, e.g. CSI=U+009B) and Unicode bidirectional overrides.
 * `JSON.stringify` only escapes C0 (U+0000–U+001F) per RFC 8259;
 * C1 and BiDi pass through unescaped.
 */
const JSON_UNSAFE_RE = /[\x80-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** BiDi-only regex for the full `sanitize()` function. */
const BIDI_RE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Strip C1 control characters and Unicode BiDi overrides from a string.
 * Used for JSON output where `JSON.stringify` escapes C0 controls but
 * leaves C1 (U+0080–U+009F) and BiDi chars intact — both can cause
 * terminal injection when JSON output is displayed in a terminal.
 */
export function stripBidi(text: string): string {
  return text.replace(JSON_UNSAFE_RE, "");
}

/**
 * Strip ANSI escapes, collapse newlines, and remove C0/C1 control characters
 * so envelope fields can't inject fake log lines or terminal commands.
 */
export function sanitize(text: string): string {
  // Collapse CR, LF, and NEL (U+0085) which terminals treat as line breaks.
  const stripped = stripAnsi(text).replace(/[\r\n\x85]+/g, " ");
  // Strip C0 (0x00-0x1F, 0x7F) and C1 (0x80-0x9F) control characters.
  const noCtrl = stripped.replace(
    // oxlint-disable-next-line no-control-regex -- stripping control chars from untrusted envelope data
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/g,
    "",
  );
  // Strip Unicode bidirectional override/isolate characters that can reorder terminal output.
  return noCtrl.replace(BIDI_RE, "");
}

/** Canonical content type for Sentry envelopes. */
export const SENTRY_CONTENT_TYPE = "application/x-sentry-envelope";

/** Output format options for `--format`. */
export const FORMAT_VALUES = ["human", "json"] as const;
export type FormatValue = (typeof FORMAT_VALUES)[number];

/** Version of the stable, machine-readable local observation record. */
export const LOCAL_EVENT_SCHEMA_VERSION = 1;

/** Envelope item categories that can be filtered via `--filter`. */
export const FILTER_VALUES = ["error", "transaction", "log", "ai"] as const;
export type FilterValue = (typeof FILTER_VALUES)[number];

/** Format a local timestamp as HH:MM:SS from a Sentry timestamp. */
export function formatTime(timestamp?: unknown): string {
  let date: Date;
  if (timestamp) {
    const seconds = parseEventTimestamp(timestamp);
    if (seconds === undefined) {
      return "??:??:??";
    }
    date = new Date(seconds * 1000);
  } else {
    date = new Date();
  }
  return date.toLocaleTimeString("en-US", { hour12: false });
}

/** Whole-millisecond duration between two Sentry timestamps, if both parse. */
function durationMs(start: unknown, end: unknown): number | undefined {
  const startSeconds = parseEventTimestamp(start);
  const endSeconds = parseEventTimestamp(end);
  return startSeconds === undefined || endSeconds === undefined
    ? undefined
    : Math.round((endSeconds - startSeconds) * 1000);
}

/** 32-char lowercase-hex trace ID, as emitted by Sentry SDKs. */
const TRACE_ID_RE = /^[0-9a-f]{32}$/i;

/**
 * Number of leading hex characters shown for a trace ID in human output.
 * Eight characters is enough to visually group spans of the same trace while
 * keeping the tail line compact; the full ID is preserved in JSON output.
 */
const TRACE_ID_SHORT_LEN = 8;

/**
 * Extract the full trace ID from an event item.
 *
 * The trace ID lives in `contexts.trace.trace_id` for errors and transactions.
 * Returns undefined when absent or malformed so callers can omit the token
 * rather than render garbage.
 */
export function extractTraceId(
  event: Record<string, unknown>,
): string | undefined {
  const trace = (event.contexts as Record<string, unknown> | undefined)
    ?.trace as { trace_id?: unknown } | undefined;
  const traceId = trace?.trace_id;
  if (typeof traceId === "string" && TRACE_ID_RE.test(traceId)) {
    return traceId.toLowerCase();
  }
  return;
}

/**
 * Build a muted, bracketed short-trace-ID token for tail output, e.g.
 * ` [trace:1a2b3c4d]`. Returns an empty string when no valid trace ID exists.
 */
export function formatTraceIdHint(event: Record<string, unknown>): string {
  const traceId = extractTraceId(event);
  if (!traceId) {
    return "";
  }
  return ` ${muted(`[trace:${traceId.slice(0, TRACE_ID_SHORT_LEN)}]`)}`;
}

/** Level → color map for tail output. */
const LEVEL_COLORS: Record<string, (s: string) => string> = {
  error: (s) => red(bold(s)),
  fatal: (s) => red(bold(s)),
  warning: yellow,
  warn: yellow,
  info: cyan,
  trace: green,
  debug: muted,
};

/** Longest bracketed type label: `[WARNING]` = 9 chars. */
const TYPE_WIDTH = 9;

/** Longest bracketed source label: `[BROWSER]` = 9 chars. */
const SOURCE_WIDTH = 9;

/** Format a type/level label as `[TYPE]` padded to fixed width. */
export function formatType(level: string): string {
  const tag = `[${sanitize(level).toUpperCase()}]`;
  const colorFn = LEVEL_COLORS[level.toLowerCase()];
  const colored = colorFn ? colorFn(tag) : tag;
  return colored + " ".repeat(Math.max(0, TYPE_WIDTH - tag.length));
}

/** Mobile SDK name substrings. */
const MOBILE_MARKERS = ["cocoa", "android", "react-native", "flutter"];

/**
 * JavaScript SDK name substrings treated as server-side when the item itself
 * doesn't say where it ran (logs, spans, sessions). Meta-framework SDKs send
 * the same name from the browser and the server, so their events are told
 * apart by platform and runtime instead (see {@link inferSourceName}).
 * Envelope headers carry only the SDK name and version, not `sdk.packages`,
 * so server-only SDKs have to be listed here by name.
 */
const SERVER_JS_MARKERS = [
  "node",
  "bun",
  "deno",
  "nextjs",
  "remix",
  "astro",
  "nuxt",
  "sveltekit",
  "solidstart",
  "react-router",
  "tanstackstart",
  "cloudflare",
  "hono",
  "vercel-edge",
  "aws-serverless",
  "google-cloud-serverless",
  "nestjs",
  "elysia",
  "nitro",
];

/** Source → color map for tail output. */
const SOURCE_COLORS: Record<string, (s: string) => string> = {
  browser: yellow,
  mobile: blue,
  server: cyan,
};

/** Where an item was captured, as shown in the source tag. */
type SourceName = "browser" | "mobile" | "server";

/**
 * Infer where an item was captured.
 *
 * Event payloads say it directly: server SDKs set a `runtime` context (Node,
 * Cloudflare Workers, Vercel Edge, Bun, Deno) or a non-JavaScript platform,
 * and browser events have `platform: "javascript"` with no runtime. This is
 * the only way to split meta-framework SDKs such as Next.js, which use one
 * SDK name on both sides. Items without those fields fall back to the SDK
 * name in the envelope header.
 */
function inferSourceName(
  header: Record<string, unknown>,
  payload?: Record<string, unknown>,
): SourceName {
  const sdk = header.sdk as { name?: unknown } | undefined;
  const name = typeof sdk?.name === "string" ? sdk.name : "";
  if (MOBILE_MARKERS.some((m) => name.includes(m))) {
    return "mobile";
  }
  const contexts = payload?.contexts as Record<string, unknown> | undefined;
  if (contexts?.runtime) {
    return "server";
  }
  if (typeof payload?.platform === "string") {
    return payload.platform === "javascript" ? "browser" : "server";
  }
  if (
    name.startsWith("sentry.javascript.") &&
    !SERVER_JS_MARKERS.some((m) => name.includes(m))
  ) {
    return "browser";
  }
  return "server";
}

/**
 * Build the source tag for an item, e.g. `[SERVER] `: colored, bracketed, and
 * padded. Pass the item payload so events can be placed by their platform and
 * runtime; see {@link inferSourceName}.
 */
export function inferSource(
  header: Record<string, unknown>,
  payload?: Record<string, unknown>,
): string {
  const source = inferSourceName(header, payload);
  const tag = `[${source.toUpperCase()}]`;
  const colorFn = SOURCE_COLORS[source] ?? cyan;
  return colorFn(tag) + " ".repeat(Math.max(0, SOURCE_WIDTH - tag.length));
}

/** Shape of a single stack frame in the exception value. */
export type StackFrame = {
  filename?: string;
  lineno?: number;
  colno?: number;
  function?: string;
  in_app?: boolean;
};

/**
 * Pick the frame to show for a stack. Frames are ordered oldest to newest, so
 * the last in-app frame is the app code closest to the throw (e.g. `onClick`,
 * not React's `dispatchDiscreteEvent`). Falls back to the newest frame.
 */
function pickFrame(frames: StackFrame[] | undefined): StackFrame | undefined {
  return frames?.findLast((f) => f.in_app) ?? frames?.at(-1);
}

/** Build the `[file:line:col] [func]` suffix for the best stack frame. */
export function formatFrameHint(frames: StackFrame[]): string {
  const frame = pickFrame(frames);
  if (!frame) {
    return "";
  }
  let hint = "";
  if (frame.filename && frame.lineno) {
    const loc = sanitize(
      frame.colno
        ? `${frame.filename}:${frame.lineno}:${frame.colno}`
        : `${frame.filename}:${frame.lineno}`,
    );
    hint += ` ${muted(`[${loc}]`)}`;
  }
  if (frame.function) {
    hint += ` ${muted(`[${sanitize(frame.function)}]`)}`;
  }
  return hint;
}

/** Shape of one exception value in an event's `exception.values`. */
type ExceptionValue = {
  type?: unknown;
  value?: unknown;
  stacktrace?: { frames?: StackFrame[] };
};

/**
 * What an `event` item reports, read the same way for tail and JSON output.
 *
 * `kind` is `message` for events with no typed exception: `captureMessage`,
 * Python `logging` records, and JavaScript messages that carry only a
 * synthetic stack. It is `error` otherwise, with the exception type in
 * `errorType` (`Error` when the event names none).
 */
type EventSummary = (
  | { kind: "message" }
  | { kind: "error"; errorType: string }
) & {
  /** Event level (`fatal`, `error`, `warning`, `info`, `debug`); `error` when unset. */
  level: string;
  /** Exception value or message text. */
  text: string;
  /** Stack of the newest exception, including a message's synthetic stack. */
  frames?: StackFrame[];
  /** Logger name, e.g. a Python logger such as `shop.payments`. */
  logger?: string;
};

/**
 * Read text from an event `message` or `logentry`. Both may be a plain string
 * or an object whose `formatted` text (with parameters filled in) is
 * preferred over its `message` template.
 */
function readMessageText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value || undefined;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  const { formatted, message } = value as {
    formatted?: unknown;
    message?: unknown;
  };
  if (typeof formatted === "string" && formatted) {
    return formatted;
  }
  if (typeof message === "string" && message) {
    return message;
  }
}

/** Summarize an `event` item for its tail line, JSON record, or `event list` entry. */
export function summarizeEvent(event: Record<string, unknown>): EventSummary {
  const exception = event.exception as
    | { values?: ExceptionValue[] }
    | undefined;
  // values is ordered oldest→newest; the last one is what was thrown.
  const last = exception?.values?.at(-1);
  const errorType =
    typeof last?.type === "string" && last.type ? last.type : undefined;
  const exceptionText =
    last?.value === undefined || last.value === ""
      ? undefined
      : stringifyUnknown(last.value);
  const messageText =
    readMessageText(event.logentry) ?? readMessageText(event.message);
  const level =
    typeof event.level === "string" && event.level ? event.level : "error";
  const logger =
    typeof event.logger === "string" && event.logger ? event.logger : undefined;
  const frames = last?.stacktrace?.frames;

  const text = errorType ? exceptionText : (messageText ?? exceptionText);
  if (!errorType && text) {
    return { kind: "message", level, text, frames, logger };
  }
  return {
    kind: "error",
    level,
    errorType: errorType ?? "Error",
    text: text ?? messageText ?? "Unknown error",
    frames,
    logger,
  };
}

/**
 * Format an `event` item into a colored one-liner, labeled with its level.
 *
 * Output:
 * - `HH:MM:SS [ERROR]   [SERVER]  TypeError: x is not a function [file.ts:42:5] [handleRequest]`
 * - `HH:MM:SS [WARNING] [BROWSER] Hello from captureMessage [page.js:24:19] [onClick]`
 */
export function formatErrorItem(
  event: Record<string, unknown>,
  header: Record<string, unknown>,
): string {
  const summary = summarizeEvent(event);
  const text = sanitize(summary.text);
  let msg =
    summary.kind === "error" ? `${sanitize(summary.errorType)}: ${text}` : text;

  if (summary.frames?.length) {
    msg += formatFrameHint(summary.frames);
  }

  if (summary.logger) {
    msg += ` ${muted(`[logger:${sanitize(summary.logger)}]`)}`;
  }

  msg += formatTraceIdHint(event);

  const ts = formatTime(event.timestamp);
  return `${muted(ts)} ${formatType(summary.level)} ${inferSource(header, event)} ${msg}`;
}

/**
 * Format a transaction event item into a colored one-liner.
 *
 * When OTel semantic attributes are present (e.g. `gen_ai.*`, `mcp.*`,
 * `db.*`), the label is derived from those attributes for richer output.
 * Falls back to the raw transaction name + trace.op otherwise.
 *
 * Output examples:
 * - `HH:MM:SS [TRACE]   [BROWSER] [http.client] GET /api/users [245ms] [3 spans]`
 * - `HH:MM:SS [TRACE]   [SERVER]  [gen_ai] chat anthropic/claude-4-sonnet [1.2s] [5 spans]`
 */
export function formatTransactionItem(
  event: Record<string, unknown>,
  header: Record<string, unknown>,
): string {
  const trace = (event.contexts as Record<string, unknown> | undefined)
    ?.trace as
    | { op?: string; status?: string; description?: string }
    | undefined;
  const txnName =
    typeof event.transaction === "string"
      ? event.transaction
      : (trace?.description ?? "Transaction");

  // Try semantic display from OTel attributes first
  const attrs = mergeTransactionAttributes(event);
  const semantic = formatSemanticSpanDisplay(attrs, sanitize(txnName));

  let msg = sanitize(semantic.label);

  // Append semantic metadata (e.g. model name, status code, error type)
  if (semantic.metadata.length > 0) {
    msg += ` ${semantic.metadata.map((m) => muted(`[${sanitize(m)}]`)).join(" ")}`;
  }

  // Show op tag — prefer semantic category if detected
  const semanticOp = inferSemanticOp(attrs);
  const op = semanticOp ?? trace?.op;
  if (op && op !== "default" && op !== "unknown") {
    msg = `[${sanitize(op)}] ${msg}`;
  }

  const duration = durationMs(event.start_timestamp, event.timestamp);
  if (duration !== undefined) {
    msg += ` ${muted(`[${duration}ms]`)}`;
  }

  const status = trace?.status;
  if (status && status !== "ok") {
    msg += ` ${muted(`[${sanitize(status)}]`)}`;
  }

  const spans = event.spans as unknown[] | undefined;
  if (spans?.length) {
    msg += ` ${muted(`[${spans.length} span${spans.length === 1 ? "" : "s"}]`)}`;
  }

  msg += formatTraceIdHint(event);

  const ts = formatTime(event.timestamp);
  return `${muted(ts)} ${formatType("trace")} ${inferSource(header, event)} ${msg}`;
}

/**
 * OTel/Sentry semantic-convention attribute prefixes considered "SDK-default".
 *
 * Attributes under these namespaces are emitted by the SDK or by standard
 * instrumentation (HTTP, DB, GenAI, messaging, …) rather than supplied by the
 * application. Grouping them separately keeps user-custom attributes — the ones
 * a developer is usually debugging — visually distinct and easy to scan.
 */
const SDK_ATTRIBUTE_PREFIXES = [
  "sentry.",
  "gen_ai.",
  "ai.",
  "mcp.",
  "db.",
  "http.",
  "url.",
  "server.",
  "client.",
  "network.",
  "rpc.",
  "messaging.",
  "faas.",
  "cloud.",
  "cloudevents.",
  "aws.s3.",
  "graphql.",
  "feature_flag.",
  "process.",
  "otel.",
  "thread.",
  "code.",
  "exception.",
  "error.",
  "user_agent.",
];

/** Two-space indent prefix for nested attribute-table lines. */
const ATTR_INDENT = "  ";

/**
 * Whether an attribute key belongs to the SDK-default group rather than being
 * a user-custom attribute. Matching is case-insensitive against the known
 * semantic-convention prefixes in {@link SDK_ATTRIBUTE_PREFIXES}.
 */
function isSdkAttribute(key: string): boolean {
  const lower = key.toLowerCase();
  return SDK_ATTRIBUTE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Render a primitive attribute value for the table. Objects and arrays are
 * JSON-encoded; everything else is stringified. The result is sanitized so
 * untrusted envelope data can't inject terminal escapes.
 */
function formatAttrValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  return sanitize(stringifyUnknown(value));
}

/**
 * Merge transaction-root attributes with all child-span attributes into a
 * single flat map. Root attributes take precedence on key collision because
 * they describe the transaction as a whole; span-level duplicates are
 * lower-signal for a top-level scan.
 */
function collectAllAttributes(
  event: Record<string, unknown>,
): Map<string, unknown> {
  const merged = new Map<string, unknown>();
  const sources: AttributeSource[] = [
    ...collectSpanAttributes(event),
    mergeTransactionAttributes(event),
  ];
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined) {
        merged.set(key, value);
      }
    }
  }
  return merged;
}

/**
 * Build an aligned `key  value` table for a group of attributes, sorted
 * alphabetically by key. Keys are padded to a common width so values line up
 * column-for-column. Returns an empty array when the group has no entries.
 */
function formatAttrGroup(
  title: string,
  entries: [string, unknown][],
): string[] {
  if (entries.length === 0) {
    return [];
  }
  const sorted = [...entries].sort(([a], [b]) => a.localeCompare(b));
  const keyWidth = Math.max(...sorted.map(([k]) => sanitize(k).length));
  const lines = [`${ATTR_INDENT}${muted(title)}`];
  for (const [key, value] of sorted) {
    const safeKey = sanitize(key);
    const padded = safeKey.padEnd(keyWidth);
    lines.push(
      `${ATTR_INDENT}${ATTR_INDENT}${cyan(padded)}  ${formatAttrValue(value)}`,
    );
  }
  return lines;
}

/**
 * Render a transaction's span/trace attributes as an indented, scannable
 * table grouped into SDK-default vs user-custom sections. Within each group
 * keys are sorted alphabetically and aligned. Returns an empty array when the
 * transaction carries no attributes.
 *
 * Surfaced under `local serve --attributes`; correlate the rows with the
 * one-liner above them via its `[trace:…]` token.
 */
export function formatAttributeTable(event: Record<string, unknown>): string[] {
  const merged = collectAllAttributes(event);
  if (merged.size === 0) {
    return [];
  }
  const sdk: [string, unknown][] = [];
  const user: [string, unknown][] = [];
  for (const entry of merged) {
    (isSdkAttribute(entry[0]) ? sdk : user).push(entry);
  }
  return [
    ...formatAttrGroup("user attributes", user),
    ...formatAttrGroup("sdk attributes", sdk),
  ];
}

/** Shape of a single log entry inside a log envelope item. */
export type LogEntry = {
  level?: string;
  body?: string;
  timestamp?: number | string;
  attributes?: Record<string, { value?: unknown }>;
};

/**
 * Whether a log attribute key is an SDK-default (`sentry.*`) attribute rather
 * than a user-supplied one. JSON log records leave out `sentry.*` attributes;
 * their content (e.g. trace ID) is surfaced separately.
 */
function isUserLogAttribute(key: string): boolean {
  return !key.startsWith("sentry.");
}

/** Log attributes that have a value, as `[key, value]` pairs. */
function logAttributeEntries(logEntry: LogEntry): [string, unknown][] {
  return Object.entries(logEntry.attributes ?? {})
    .filter(([, v]) => v?.value !== null && v?.value !== undefined)
    .map(([k, v]) => [k, v.value]);
}

/**
 * Extract the trace ID from a log entry's attributes.
 *
 * Logs carry no `contexts.trace`; the trace ID lives in the SDK-default
 * `sentry.trace.trace_id` attribute. Returns undefined when absent or
 * malformed.
 */
function extractLogTraceId(logEntry: LogEntry): string | undefined {
  const traceId = logEntry.attributes?.["sentry.trace.trace_id"]?.value;
  if (typeof traceId === "string" && TRACE_ID_RE.test(traceId)) {
    return traceId.toLowerCase();
  }
  return;
}

/**
 * Format one log entry into a colored tail line.
 *
 * User-supplied attributes are rendered alphabetically by key so repeated log
 * lines align column-for-column and are easy to scan. SDK-default attributes
 * (`sentry.*`, `code.*`, `thread.*`, `server.*`, … see
 * {@link SDK_ATTRIBUTE_PREFIXES}) are omitted from the inline list; the trace
 * ID is surfaced as a compact `[trace:…]` token instead.
 */
export function formatSingleLog(logEntry: LogEntry, source: string): string {
  const level = logEntry.level ?? "log";
  let msg = sanitize(logEntry.body ?? "");

  const attrs = logAttributeEntries(logEntry)
    .filter(([k]) => !isSdkAttribute(k))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => muted(`[${sanitize(k)}=${sanitize(String(v))}]`));
  if (attrs.length > 0) {
    msg += ` ${attrs.join(" ")}`;
  }

  const traceId = extractLogTraceId(logEntry);
  if (traceId) {
    msg += ` ${muted(`[trace:${traceId.slice(0, TRACE_ID_SHORT_LEN)}]`)}`;
  }

  const ts = formatTime(logEntry.timestamp);
  return `${muted(ts)} ${formatType(level)} ${source} ${msg}`;
}

/**
 * Format a log event item. A log envelope item contains an `items` array
 * of individual log entries; each gets its own line.
 *
 * When `showAttributes` is true, each line is followed by a table of the
 * SDK-default attributes that the line leaves out.
 *
 * Output: `HH:MM:SS [INFO]    [SERVER]  User logged in [user_id=1234]`
 */
export function formatLogItem(
  event: Record<string, unknown>,
  header: Record<string, unknown>,
  showAttributes = false,
): string[] {
  const items = event.items as LogEntry[] | undefined;
  if (!items?.length) {
    return [];
  }

  const source = inferSource(header);
  return items.flatMap((logEntry) => {
    const line = formatSingleLog(logEntry, source);
    if (!showAttributes) {
      return [line];
    }
    const sdk = logAttributeEntries(logEntry).filter(([k]) =>
      isSdkAttribute(k),
    );
    return [line, ...formatAttrGroup("sdk attributes", sdk)];
  });
}

/** Shape of a single span in a standalone span envelope item (v2 span streaming). */
export type StreamedSpan = {
  trace_id?: string;
  span_id?: string;
  name?: string;
  start_timestamp?: number | string;
  end_timestamp?: number | string;
  status?: string;
  attributes?: Record<string, { type?: string; value?: unknown }>;
};

/**
 * Flatten typed span attributes (`{ key: { type, value } }`) into a plain
 * `Record<string, unknown>` compatible with the semantic display pipeline.
 */
function flattenSpanAttributes(
  attrs: Record<string, { type?: string; value?: unknown }> | undefined,
): Record<string, unknown> {
  if (!attrs) {
    return {};
  }
  const flat: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(attrs)) {
    if (entry?.value !== undefined) {
      flat[key] = entry.value;
    }
  }
  return flat;
}

/**
 * Format a single standalone span into a colored one-liner, using the same
 * semantic rendering as transactions.
 */
export function formatSingleSpan(
  span: StreamedSpan,
  header: Record<string, unknown>,
): string {
  const spanName = sanitize(span.name ?? "unnamed span");
  const flat = flattenSpanAttributes(span.attributes);
  const semantic = formatSemanticSpanDisplay(flat, spanName);

  let msg = sanitize(semantic.label);
  if (semantic.metadata.length > 0) {
    msg += ` ${semantic.metadata.map((m) => muted(`[${sanitize(m)}]`)).join(" ")}`;
  }

  const semanticOp = inferSemanticOp(flat);
  const op =
    semanticOp ??
    (typeof flat["sentry.op"] === "string" ? flat["sentry.op"] : undefined);
  if (op && op !== "default" && op !== "unknown") {
    msg = `[${sanitize(op)}] ${msg}`;
  }

  const duration = durationMs(span.start_timestamp, span.end_timestamp);
  if (duration !== undefined) {
    msg += ` ${muted(`[${duration}ms]`)}`;
  }

  if (span.status && span.status !== "ok") {
    msg += ` ${muted(`[${sanitize(span.status)}]`)}`;
  }

  if (span.trace_id && TRACE_ID_RE.test(span.trace_id)) {
    msg += ` ${muted(`[trace:${span.trace_id.toLowerCase().slice(0, TRACE_ID_SHORT_LEN)}]`)}`;
  }

  const ts = formatTime(span.end_timestamp);
  return `${muted(ts)} ${formatType("trace")} ${inferSource(header)} ${msg}`;
}

/**
 * Format a standalone span envelope item. A span item contains an `items`
 * array of individual spans (v2 span streaming format); each gets its own line.
 */
export function formatSpanItem(
  event: Record<string, unknown>,
  header: Record<string, unknown>,
  showAttributes = false,
): string[] {
  const items = event.items as StreamedSpan[] | undefined;
  if (!items?.length) {
    return [];
  }
  const lines: string[] = [];
  for (const span of items) {
    lines.push(formatSingleSpan(span, header));
    if (showAttributes) {
      const flat = flattenSpanAttributes(span.attributes);
      const table = formatAttributeTable({
        contexts: { trace: { data: flat } },
      });
      lines.push(...table);
    }
  }
  return lines;
}

/**
 * Whether a standalone span item carries AI (GenAI/MCP) activity.
 * Checks all spans in the container for AI-prefixed attributes.
 */
function spanItemHasAiActivity(payload: Record<string, unknown>): boolean {
  const items = payload.items as StreamedSpan[] | undefined;
  if (!items?.length) {
    return false;
  }
  for (const span of items) {
    if (hasAiAttributes(flattenSpanAttributes(span.attributes))) {
      return true;
    }
  }
  return false;
}

/** Item types that map to the error formatter. */
export const ERROR_TYPES = new Set(["event", "error"]);

/**
 * Map envelope item `type` to the corresponding `FilterValue`.
 * Standalone `span` items map to `"transaction"` since they represent
 * trace data (the same category transactions occupy).
 * Returns undefined for item types that don't map to a filter category.
 */
export function itemTypeToFilterCategory(
  itemType: string | undefined,
): FilterValue | undefined {
  if (!itemType) {
    return;
  }
  if (ERROR_TYPES.has(itemType)) {
    return "error";
  }
  if (itemType === "transaction" || itemType === "span" || itemType === "log") {
    return itemType === "span" ? "transaction" : itemType;
  }
}

/** Produce a fallback one-liner for unparseable or unsupported items. */
export function formatFallbackLine(label: string): string {
  return `${muted(formatTime())} ${cyan("•")} ${bold(sanitize(label))}`;
}

/** Resolve a human label for a completely unparseable envelope. */
export function resolveUnparseableLabel(container: {
  getContentType: () => string;
  getEventTypes: () => string[] | null;
}): string {
  const types = container.getEventTypes();
  if (types && types.length > 0) {
    return types.join("+");
  }
  const ct = container.getContentType();
  return ct === "application/x-sentry-envelope" ? "envelope" : ct;
}

/** Strip BiDi from a string value, returning undefined for non-strings. */
function jsonSafe(value: unknown): string | undefined {
  return typeof value === "string" ? stripBidi(value) : undefined;
}

/** Normalize an SDK identity that may be represented by a UUID object. */
function jsonSafeIdentifier(value: unknown): string | undefined {
  if (typeof value === "string") {
    return stripBidi(value);
  }
  if (value === null || typeof value !== "object") {
    return;
  }

  try {
    // UUID objects override toString(); the base Object result is rejected below.
    // oxlint-disable-next-line typescript/no-base-to-string
    const identifier = value.toString();
    if (identifier === "[object Object]") {
      return;
    }
    return stripBidi(identifier);
  } catch {
    log.debug("Could not serialize local envelope identity");
  }
}

/**
 * Remove terminal-affecting characters from every string in an observation.
 *
 * Envelope payloads are untrusted, and `JSON.stringify()` does not escape C1
 * controls or BiDi overrides. Normalizing the final record in one place keeps
 * new JSON fields from accidentally bypassing the terminal-safety contract.
 */
function sanitizeJsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    return stripBidi(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeJsonValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        stripBidi(key),
        sanitizeJsonValue(nestedValue),
      ]),
    );
  }
  return value;
}

/** Serialize one versioned local observation as an NDJSON record. */
function formatJsonObservation(
  observation: Record<string, unknown>,
  payload: Record<string, unknown>,
  header: Record<string, unknown>,
): string {
  return JSON.stringify(
    sanitizeJsonValue({
      schema_version: LOCAL_EVENT_SCHEMA_VERSION,
      envelope_id: jsonSafeIdentifier(header.__spotlight_envelope_id),
      event_id: jsonSafe(payload.event_id) ?? jsonSafe(header.event_id),
      ...observation,
    }),
  );
}

/**
 * Format an `event` item as a JSON object, including the best stack frame.
 * Exceptions get `type: "error"` and an `error_type`; messages get
 * `type: "message"` and no `error_type`.
 */
function formatErrorJson(
  payload: Record<string, unknown>,
  header: Record<string, unknown>,
): string {
  const summary = summarizeEvent(payload);
  const frame = pickFrame(summary.frames);
  return formatJsonObservation(
    {
      type: summary.kind,
      timestamp: parseEventTimestamp(payload.timestamp),
      trace_id: extractTraceId(payload),
      level: summary.level,
      error_type: summary.kind === "error" ? summary.errorType : undefined,
      message: summary.text,
      logger: summary.logger,
      filename: jsonSafe(frame?.filename),
      lineno: frame?.lineno,
      colno: frame?.colno,
      function: jsonSafe(frame?.function),
      source: inferSourceName(header, payload),
    },
    payload,
    header,
  );
}

/**
 * Build the `{ user, sdk }` attribute split for JSON output. Each side is a
 * sorted object of stringified values, omitted (undefined) when empty so the
 * envelope stays compact when `--attributes` isn't requested.
 */
function buildJsonAttributes(payload: Record<string, unknown>): {
  user?: Record<string, string>;
  sdk?: Record<string, string>;
} {
  const merged = collectAllAttributes(payload);
  const user: Record<string, string> = {};
  const sdk: Record<string, string> = {};
  for (const [key, value] of [...merged].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const target = isSdkAttribute(key) ? sdk : user;
    target[stripBidi(key)] = stripBidi(formatAttrValue(value));
  }
  return {
    user: Object.keys(user).length > 0 ? user : undefined,
    sdk: Object.keys(sdk).length > 0 ? sdk : undefined,
  };
}

/**
 * Format a transaction item as a JSON object.
 *
 * When `includeAttributes` is true, a grouped `attributes` object (`user` /
 * `sdk`) is added so automation can inspect the full span attribute bag.
 */
function formatTransactionJson(
  payload: Record<string, unknown>,
  header: Record<string, unknown>,
  includeAttributes = false,
): string {
  const trace = (payload.contexts as Record<string, unknown> | undefined)
    ?.trace as Record<string, unknown> | undefined;
  const attrs = mergeTransactionAttributes(payload);
  const semantic = formatSemanticSpanDisplay(
    attrs,
    stringifyUnknown(
      payload.transaction ?? trace?.description ?? "Transaction",
    ),
  );
  return formatJsonObservation(
    {
      type: "transaction",
      timestamp: parseEventTimestamp(payload.timestamp),
      trace_id: extractTraceId(payload),
      op: inferSemanticOp(attrs) ?? trace?.op,
      label: stripBidi(semantic.label),
      metadata:
        semantic.metadata.length > 0
          ? semantic.metadata.map(stripBidi)
          : undefined,
      duration_ms: durationMs(payload.start_timestamp, payload.timestamp),
      status: trace?.status,
      span_count: (payload.spans as unknown[] | undefined)?.length,
      attributes: includeAttributes ? buildJsonAttributes(payload) : undefined,
      source: inferSourceName(header, payload),
    },
    payload,
    header,
  );
}

/** Format a log item as JSON objects (one per entry). */
function formatLogJson(
  payload: Record<string, unknown>,
  header: Record<string, unknown>,
): string[] {
  const items = payload.items as LogEntry[] | undefined;
  if (!items?.length) {
    return [];
  }
  const source = inferSourceName(header);
  return items.map((entry) =>
    formatJsonObservation(
      {
        type: "log",
        timestamp: parseEventTimestamp(entry.timestamp),
        trace_id: extractLogTraceId(entry),
        level: entry.level ?? "log",
        message: stripBidi(entry.body ?? ""),
        attributes: entry.attributes
          ? Object.fromEntries(
              Object.entries(entry.attributes)
                .filter(
                  ([k, v]) =>
                    isUserLogAttribute(k) &&
                    v?.value !== null &&
                    v?.value !== undefined,
                )
                .map(([k, v]) => [
                  stripBidi(k),
                  typeof v.value === "string" ? stripBidi(v.value) : v.value,
                ]),
            )
          : undefined,
        source,
      },
      payload,
      header,
    ),
  );
}

/** Format a standalone span item as JSON objects (one per span). */
function formatSpanJson(
  payload: Record<string, unknown>,
  header: Record<string, unknown>,
  includeAttributes = false,
): string[] {
  const items = payload.items as StreamedSpan[] | undefined;
  if (!items?.length) {
    return [];
  }
  const source = inferSourceName(header);
  return items.map((span) => {
    const flat = flattenSpanAttributes(span.attributes);
    const semantic = formatSemanticSpanDisplay(
      flat,
      span.name ?? "unnamed span",
    );
    return formatJsonObservation(
      {
        type: "span",
        timestamp: parseEventTimestamp(span.end_timestamp),
        trace_id: span.trace_id,
        span_id: span.span_id,
        op: inferSemanticOp(flat) ?? flat["sentry.op"],
        label: stripBidi(semantic.label),
        metadata:
          semantic.metadata.length > 0
            ? semantic.metadata.map(stripBidi)
            : undefined,
        duration_ms: durationMs(span.start_timestamp, span.end_timestamp),
        status: span.status,
        attributes: includeAttributes
          ? buildJsonAttributes({ contexts: { trace: { data: flat } } })
          : undefined,
        source,
      },
      payload,
      header,
    );
  });
}

/**
 * Format a single envelope item as a JSON line (NDJSON).
 *
 * Produces a compact JSON object per item with `type`, `timestamp`,
 * and item-specific fields. Designed for machine consumption by AI
 * coding agents and automation tools.
 *
 * Unlike the human formatters, JSON output uses `stripBidi()` instead of
 * the full `sanitize()`. `JSON.stringify()` escapes C0 control characters
 * (U+0000–U+001F) but leaves C1 controls (U+0080–U+009F) and BiDi overrides
 * intact. `stripBidi()` strips both, preventing terminal injection when
 * JSON output is viewed in a terminal, while preserving the original data
 * structure for downstream consumers.
 */
export function formatItemJson(
  itemType: string | undefined,
  payload: Record<string, unknown>,
  header: Record<string, unknown>,
  showAttributes = false,
): string[] {
  if (itemType && ERROR_TYPES.has(itemType)) {
    return [formatErrorJson(payload, header)];
  }
  if (itemType === "transaction") {
    return [formatTransactionJson(payload, header, showAttributes)];
  }
  if (itemType === "span") {
    return formatSpanJson(payload, header, showAttributes);
  }
  if (itemType === "log") {
    return formatLogJson(payload, header);
  }
  return [
    formatJsonObservation(
      {
        type: itemType ?? "unknown",
        timestamp: parseEventTimestamp(payload.timestamp),
      },
      payload,
      header,
    ),
  ];
}

/**
 * Format a single envelope item into one or more output lines.
 *
 * When `showAttributes` is true, transaction items are followed by an indented
 * attribute table (see {@link formatAttributeTable}).
 */
export function formatItem(
  itemType: string | undefined,
  payload: Record<string, unknown>,
  header: Record<string, unknown>,
  fallbackLabel: string,
  showAttributes = false,
): string[] {
  if (itemType && ERROR_TYPES.has(itemType)) {
    return [formatErrorItem(payload, header)];
  }
  if (itemType === "transaction") {
    const lines = [formatTransactionItem(payload, header)];
    if (showAttributes) {
      lines.push(...formatAttributeTable(payload));
    }
    return lines;
  }
  if (itemType === "span") {
    return formatSpanItem(payload, header, showAttributes);
  }
  if (itemType === "log") {
    return formatLogItem(payload, header, showAttributes);
  }
  // Active replays send a recording segment every few seconds; its
  // replay_event already gets a line.
  if (itemType === "replay_recording") {
    return [];
  }
  return [formatFallbackLine(fallbackLabel)];
}

/**
 * Check whether an item should be shown given active filters.
 *
 * When `payload` is provided and the `ai` filter is active, transactions
 * are checked for GenAI/MCP OTel attributes.
 */
export function isItemIncluded(
  itemType: string | undefined,
  activeFilters: ReadonlySet<FilterValue>,
  payload?: Record<string, unknown>,
): boolean {
  if (activeFilters.size === 0) {
    return true;
  }
  const category = itemTypeToFilterCategory(itemType);
  if (category !== undefined && activeFilters.has(category)) {
    return true;
  }
  // The "ai" filter matches transactions and standalone spans with GenAI or MCP attributes.
  if (activeFilters.has("ai") && payload) {
    if (itemType === "transaction") {
      return transactionHasAiActivity(payload);
    }
    if (itemType === "span") {
      return spanItemHasAiActivity(payload);
    }
  }
  return false;
}

/**
 * Whether a transaction carries GenAI or MCP activity.
 *
 * Checks the trace-root attributes first, then falls back to scanning child
 * span attributes. The Vercel AI SDK and similar instrumentations attach
 * `gen_ai.*` attributes to child spans of an HTTP handler transaction (e.g.
 * `POST /api/ai/chat`), so root-only detection misses them.
 *
 * Detection matches the full `gen_ai.*`/`mcp.*` namespace by key prefix rather
 * than only the op-defining keys ({@link inferSemanticOp}) — a span carrying
 * just `gen_ai.request.model` or `gen_ai.usage.input_tokens` is still AI
 * activity the filter must surface.
 */
function transactionHasAiActivity(payload: Record<string, unknown>): boolean {
  if (hasAiAttributes(mergeTransactionAttributes(payload))) {
    return true;
  }
  for (const spanAttrs of collectSpanAttributes(payload)) {
    if (hasAiAttributes(spanAttrs)) {
      return true;
    }
  }
  return false;
}

/**
 * Format a freshly received envelope as NDJSON lines.
 *
 * Each item produces one JSON line. Filtering works identically to
 * the human formatter.
 */
export function formatEnvelopeLinesJson(
  container: {
    getParsedEnvelope: () => {
      envelope: [Record<string, unknown>, [{ type?: string }, unknown][]];
    } | null;
    getContentType: () => string;
    getEventTypes: () => string[] | null;
  },
  activeFilters: ReadonlySet<FilterValue>,
  showAttributes = false,
): string[] {
  const parsed = container.getParsedEnvelope();
  if (!parsed) {
    return [];
  }

  const [header, items] = parsed.envelope;
  const lines: string[] = [];
  for (const [itemHeader, itemPayload] of items) {
    const payload = itemPayload as Record<string, unknown>;
    if (!isItemIncluded(itemHeader.type, activeFilters, payload)) {
      continue;
    }
    lines.push(
      ...formatItemJson(itemHeader.type, payload, header, showAttributes),
    );
  }
  return lines;
}

/**
 * Format a freshly received envelope for terminal output.
 *
 * When `activeFilters` is non-empty, only items whose category matches
 * one of the filter values are rendered; non-matching items are silently
 * dropped. When empty, all items are shown.
 */
export function formatEnvelopeLines(
  container: {
    getParsedEnvelope: () => {
      envelope: [Record<string, unknown>, [{ type?: string }, unknown][]];
    } | null;
    getContentType: () => string;
    getEventTypes: () => string[] | null;
  },
  activeFilters: ReadonlySet<FilterValue>,
  showAttributes = false,
): string[] {
  const parsed = container.getParsedEnvelope();
  if (!parsed) {
    if (activeFilters.size > 0) {
      return [];
    }
    return [formatFallbackLine(resolveUnparseableLabel(container))];
  }

  const [header, items] = parsed.envelope;
  const lines: string[] = [];
  for (const [itemHeader, itemPayload] of items) {
    const payload = itemPayload as Record<string, unknown>;
    if (!isItemIncluded(itemHeader.type, activeFilters, payload)) {
      continue;
    }
    lines.push(
      ...formatItem(
        itemHeader.type,
        payload,
        header,
        itemHeader.type ?? container.getContentType(),
        showAttributes,
      ),
    );
  }

  if (lines.length > 0) {
    return lines;
  }
  if (activeFilters.size > 0) {
    return [];
  }
  return [formatFallbackLine(resolveUnparseableLabel(container))];
}

/** Human control-plane summaries add a viewer link without altering JSON data. */
export function formatLocalControlResult(
  data: Record<string, unknown>,
): string {
  const daemon =
    data.daemon &&
    typeof data.daemon === "object" &&
    !Array.isArray(data.daemon)
      ? (data.daemon as Record<string, unknown>)
      : data;
  const receiverUrl =
    typeof data.streamUrl === "string"
      ? data.streamUrl
      : typeof daemon.host === "string" && typeof daemon.port === "number"
        ? formatLocalServerUrl(daemon.host, daemon.port)
        : undefined;
  const hint = receiverUrl ? formatLocalViewerHint(receiverUrl) : undefined;
  return JSON.stringify(data, null, 2) + (hint ? `\n\n${hint}` : "");
}

/** Point human Local command output to a credential-free receiver connection. */
export function formatLocalViewerHint(receiverUrl: string): string | undefined {
  const url = getLocalUiConnectionUrl(receiverUrl);
  return url ? `View events at ${url}` : undefined;
}

/** Streaming commands cannot defer their hint until the generator returns. */
export function printLocalViewerHint(
  receiverUrl: string,
  useJson: boolean,
): void {
  if (useJson) return;
  const hint = formatLocalViewerHint(receiverUrl);
  if (hint) logger.info(hint);
}
