/**
 * Log-specific formatters
 *
 * Provides formatting utilities for displaying Sentry logs in the CLI.
 */

import type {
  DetailedSentryLog,
  SentryLog,
  TraceItemAttribute,
} from "../../types/index.js";
import { buildTraceUrl } from "../sentry-urls.js";
import {
  colorTag,
  escapeMarkdownCell,
  escapeMarkdownInline,
  mdKvTable,
  mdRow,
  mdTableHeader,
  renderInlineMarkdown,
  renderMarkdown,
} from "./markdown.js";
import {
  renderTextTable,
  StreamingTable,
  type StreamingTableOptions,
} from "./text-table.js";

/** Markdown color tag names for log severity levels */
const SEVERITY_TAGS: Record<string, Parameters<typeof colorTag>[0]> = {
  fatal: "red",
  error: "red",
  warning: "yellow",
  warn: "yellow",
  info: "cyan",
  debug: "muted",
  trace: "muted",
};

/** Column headers for the streaming log table */
const LOG_TABLE_COLS = ["ID", "Timestamp", "Level", "Message"] as const;

/**
 * Minimal log-row shape shared by {@link SentryLog} (Explore/Events) and
 * trace-log entries (`TraceLog` from the trace-logs endpoint).
 * Both types carry these three fields with the same semantics.
 *
 * The index signature allows arbitrary extra fields from `--fields` to
 * flow through (the Zod schemas use `.passthrough()`).
 */
export type LogLike = {
  timestamp: string;
  severity?: string | null;
  message?: string | null;
  /** Present on Explore/Events logs; absent on trace-logs (all rows share one trace). */
  trace?: string | null;
  /** Unique log entry ID from Explore/Events API (`sentry.item_id`). */
  "sentry.item_id"?: string;
  /** Unique log entry ID from trace-logs endpoint. */
  id?: string;
  /** Allow arbitrary extra fields (e.g., custom `--fields` from ourlogs). */
  [key: string]: unknown;
};

/**
 * Extract the canonical log entry ID from either log shape.
 *
 * Explore/Events logs use `sentry.item_id`; trace-logs use `id`.
 * Uses typeof guards because the index signature on {@link LogLike}
 * widens named properties to `unknown`.
 *
 * @param log - Any {@link LogLike} log entry
 * @returns The log entry's unique ID, or empty string if neither field is present
 */
export function getLogId(log: LogLike): string {
  const itemId = log["sentry.item_id"];
  if (typeof itemId === "string") {
    return itemId;
  }
  const id = log.id;
  if (typeof id === "string") {
    return id;
  }
  return "";
}

/**
 * Format severity level with appropriate color tag.
 * Pads to 7 characters for alignment (longest: "warning").
 *
 * @param severity - The log severity level
 * @returns Markdown color-tagged and padded severity string
 */
function formatSeverity(severity: string | null | undefined): string {
  const level = (severity ?? "info").toLowerCase();
  const tag = SEVERITY_TAGS[level];
  const label = level.toUpperCase().padEnd(7);
  return tag ? colorTag(tag, label) : label;
}

/**
 * Format ISO timestamp for display.
 * Converts to local time in "YYYY-MM-DD HH:MM:SS" format.
 *
 * @param timestamp - ISO 8601 timestamp string
 * @returns Formatted local timestamp, or original string if invalid
 */
function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);

  // Handle invalid dates - return original string
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  // Swedish locale naturally uses ISO 8601 format (YYYY-MM-DD HH:MM:SS) in local time
  return date.toLocaleString("sv-SE");
}

/**
 * Extract cell values for a log row (shared by streaming and batch paths).
 *
 * When `includeTrace` is true (the default), a short trace-ID suffix is
 * appended to the message cell — useful in Explore/Events lists where rows
 * may span many traces. Pass `false` when all rows already share the same
 * trace (e.g., `sentry trace logs`) so the redundant suffix is omitted.
 *
 * When `extraFields` is provided, additional cells are appended for each
 * field — used by `--fields` to render custom structured log attributes.
 *
 * @param log - The log entry (any {@link LogLike} shape)
 * @param padSeverity - Whether to pad severity to 7 chars for alignment
 * @param includeTrace - Whether to append a short trace-ID suffix to the message
 * @param extraFields - Additional field names to render as extra columns
 * @returns `[id, timestamp, severity, message, ...extras]` markdown-safe cell strings
 */
export function buildLogRowCells(
  log: LogLike,
  padSeverity = true,
  includeTrace = true,
  extraFields?: string[]
): string[] {
  const logId = getLogId(log);
  const shortId = logId ? colorTag("muted", logId.slice(0, 8)) : "";
  const timestamp = formatTimestamp(log.timestamp);
  const level = padSeverity
    ? formatSeverity(log.severity)
    : formatSeverityLabel(log.severity);
  const message = escapeMarkdownCell(log.message ?? "");
  const trace =
    includeTrace && log.trace ? ` \`[${log.trace.slice(0, 8)}]\`` : "";
  const cells: string[] = [shortId, timestamp, level, `${message}${trace}`];
  if (extraFields) {
    for (const field of extraFields) {
      const val = log[field];
      cells.push(
        escapeMarkdownCell(val !== null && val !== undefined ? String(val) : "")
      );
    }
  }
  return cells;
}

/**
 * Format a single log entry as a plain markdown table row.
 * Used for non-TTY / piped output where StreamingTable isn't appropriate.
 *
 * @param log - The log entry (any {@link LogLike} shape)
 * @param includeTrace - Whether to append a short trace-ID suffix (default: true)
 * @param extraFields - Additional field names to render as extra columns
 * @returns Formatted log line with newline
 */
export function formatLogRow(
  log: LogLike,
  includeTrace = true,
  extraFields?: string[]
): string {
  return mdRow(buildLogRowCells(log, true, includeTrace, extraFields));
}

/** Hint rows for column width estimation in streaming mode. */
const LOG_HINT_ROWS: string[][] = [
  [
    "ace106b2",
    "2026-01-15 23:59:59",
    "WARNING",
    "A typical log message with some detail",
  ],
];

/**
 * Create a StreamingTable configured for log output.
 *
 * When `extraColumns` is provided, additional shrinkable columns are
 * appended after the Message column — used by `--fields` to render
 * custom structured log attributes.
 *
 * @param options - Override default table options
 * @param extraColumns - Additional column headers to append
 * @returns A StreamingTable with log-specific column configuration
 */
export function createLogStreamingTable(
  options: Partial<StreamingTableOptions> = {},
  extraColumns?: string[]
): StreamingTable {
  const cols = [...LOG_TABLE_COLS, ...(extraColumns ?? [])];
  // ID, Timestamp, Level are fixed-width; Message + extra columns are shrinkable
  const shrinkable = [
    false,
    false,
    false,
    true,
    ...(extraColumns ?? []).map(() => true),
  ];
  // Extend hint rows with placeholder values for extra columns so the
  // StreamingTable width estimator allocates reasonable space for them.
  const hintRows = extraColumns?.length
    ? LOG_HINT_ROWS.map((row) => [
        ...row,
        ...extraColumns.map(() => "example_value_123"),
      ])
    : LOG_HINT_ROWS;

  return new StreamingTable(cols, {
    hintRows,
    shrinkable,
    truncate: false,
    ...options,
  });
}

/**
 * Format column header for logs list in plain (non-TTY) mode.
 *
 * Emits a proper markdown table header + separator row so that
 * the streamed rows compose into a valid CommonMark document when redirected.
 * In TTY mode, use {@link createLogStreamingTable} instead.
 *
 * @param extraColumns - Additional column headers to append (from `--fields`)
 * @returns Header string (includes trailing newline)
 */
export function formatLogsHeader(extraColumns?: string[]): string {
  const cols = [...LOG_TABLE_COLS, ...(extraColumns ?? [])];
  return `${mdTableHeader(cols)}\n`;
}

/**
 * Build a markdown table for a list of log entries.
 *
 * Accepts any {@link LogLike} shape — both {@link SentryLog} (Explore/Events)
 * and trace-log entries. Pass `includeTrace: false` when all rows already share
 * the same trace (e.g., `sentry trace logs`) to omit the redundant trace suffix.
 *
 * Pre-rendered ANSI codes in cell values (e.g. colored severity) are preserved.
 *
 * @param logs - Log entries to display
 * @param includeTrace - Whether to append a short trace-ID suffix (default: true)
 * @param extraFields - Additional field names to render as extra columns
 * @returns Rendered terminal string with Unicode-bordered table
 */
export function formatLogTable(
  logs: LogLike[],
  includeTrace = true,
  extraFields?: string[]
): string {
  const headers = [...LOG_TABLE_COLS, ...(extraFields ?? [])];
  const rows = logs.map((log) =>
    buildLogRowCells(log, false, includeTrace, extraFields).map((c) =>
      renderInlineMarkdown(c)
    )
  );
  return renderTextTable(headers, rows);
}

/**
 * Format severity level with color tag for detailed view (not padded).
 *
 * @param severity - The log severity level
 * @returns Markdown color-tagged severity string
 */
function formatSeverityLabel(severity: string | null | undefined): string {
  const level = (severity ?? "info").toLowerCase();
  const tag = SEVERITY_TAGS[level];
  const label = level.toUpperCase();
  return tag ? colorTag(tag, label) : label;
}

/**
 * Attribute names to exclude from the Custom Attributes section in formatLogDetails.
 * Mirrors REDUNDANT_DETAIL_ATTRS in traces.ts (the span equivalent).
 * Covers attributes already shown in the fixed sections above, plus internal/noisy
 * fields that mirror Sentry UI's HiddenLogDetailFields.
 */
const REDUNDANT_LOG_DETAIL_ATTRS = new Set([
  // Core section
  "sentry.item_id",
  "id",
  "timestamp",
  "timestamp_precise",
  "message",
  "severity",
  // Context section
  "trace",
  "project",
  "environment",
  "release",
  // SDK section
  "sdk.name",
  "sdk.version",
  // Trace section
  "span_id",
  // Source location section
  "code.function",
  "code.file.path",
  "code.line.number",
  // OTel section
  "sentry.otel.kind",
  "sentry.otel.status_code",
  "sentry.otel.instrumentation_scope.name",
  // Internal / always-hidden noise (mirrors Sentry UI HiddenLogDetailFields)
  "severity_number",
  "item_type",
  "organization_id",
  "project.id",
  "project_id",
  "sentry.timestamp_nanos",
  "sentry.observed_timestamp_nanos",
  "tags[sentry.trace_flags,number]",
]);

/**
 * Format detailed log entry for display as rendered markdown.
 * Shows all available fields in a structured format.
 *
 * @param log - The detailed log entry to format
 * @param orgSlug - Organization slug for building trace URLs
 * @param allAttributes - All attributes from the trace-items detail endpoint (shows custom attrs)
 * @param extraFields - Optional --fields filter: limits which custom attributes are shown
 * @returns Rendered terminal string
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: log detail formatting requires multiple conditional sections
export function formatLogDetails(
  log: DetailedSentryLog,
  orgSlug: string,
  allAttributes?: TraceItemAttribute[],
  extraFields?: string[]
): string {
  const logId = log["sentry.item_id"];
  const lines: string[] = [];

  lines.push(`## Log \`${logId.slice(0, 6)}...${logId.slice(-6)}\``);
  lines.push("");

  // Core fields table
  lines.push(
    mdKvTable([
      ["ID", `\`${logId}\``],
      ["Timestamp", formatTimestamp(log.timestamp)],
      ["Severity", formatSeverityLabel(log.severity)],
    ])
  );

  if (log.message) {
    lines.push("");
    lines.push("**Message:**");
    lines.push("");
    lines.push(`> ${escapeMarkdownInline(log.message).replace(/\n/g, "\n> ")}`);
  }

  // Context section
  if (log.project || log.environment || log.release) {
    const ctxRows: [string, string][] = [];
    if (log.project) {
      ctxRows.push(["Project", log.project]);
    }
    if (log.environment) {
      ctxRows.push(["Environment", log.environment]);
    }
    if (log.release) {
      ctxRows.push(["Release", log.release]);
    }
    lines.push("");
    lines.push(mdKvTable(ctxRows, "Context"));
  }

  // SDK section
  const sdkName = log["sdk.name"];
  const sdkVersion = log["sdk.version"];
  if (sdkName || sdkVersion) {
    // Wrap in backticks to prevent markdown from interpreting underscores/dashes
    const sdkInfo =
      sdkName && sdkVersion
        ? `\`${sdkName} ${sdkVersion}\``
        : `\`${sdkName ?? sdkVersion}\``;
    lines.push("");
    lines.push(mdKvTable([["SDK", sdkInfo]], "SDK"));
  }

  // Trace section
  if (log.trace) {
    const traceRows: [string, string][] = [["Trace ID", `\`${log.trace}\``]];
    if (log.span_id) {
      traceRows.push(["Span ID", `\`${log.span_id}\``]);
    }
    traceRows.push(["Link", buildTraceUrl(orgSlug, log.trace)]);
    lines.push("");
    lines.push(mdKvTable(traceRows, "Trace"));
  }

  // Source location section (OTel code attributes)
  const codeFunction = log["code.function"];
  const codeFilePath = log["code.file.path"];
  const codeLineNumber = log["code.line.number"];
  if (codeFunction || codeFilePath) {
    const srcRows: [string, string][] = [];
    if (codeFunction) {
      srcRows.push(["Function", `\`${codeFunction}\``]);
    }
    if (codeFilePath) {
      const location = codeLineNumber
        ? `${codeFilePath}:${codeLineNumber}`
        : codeFilePath;
      srcRows.push(["File", `\`${location}\``]);
    }
    lines.push("");
    lines.push(mdKvTable(srcRows, "Source Location"));
  }

  // OpenTelemetry section
  const otelKind = log["sentry.otel.kind"];
  const otelStatus = log["sentry.otel.status_code"];
  const otelScope = log["sentry.otel.instrumentation_scope.name"];
  if (otelKind || otelStatus || otelScope) {
    const otelRows: [string, string][] = [];
    if (otelKind) {
      otelRows.push(["Kind", otelKind]);
    }
    if (otelStatus) {
      otelRows.push(["Status", otelStatus]);
    }
    if (otelScope) {
      otelRows.push(["Scope", otelScope]);
    }
    lines.push("");
    lines.push(mdKvTable(otelRows, "OpenTelemetry"));
  }

  // Custom Attributes — from trace-items detail endpoint (all non-standard attributes)
  if (allAttributes?.length) {
    let customAttrs = allAttributes.filter(
      (a) => !REDUNDANT_LOG_DETAIL_ATTRS.has(a.name)
    );
    if (extraFields?.length) {
      const wanted = new Set(extraFields);
      customAttrs = customAttrs.filter((a) => wanted.has(a.name));
    }
    if (customAttrs.length > 0) {
      lines.push("");
      lines.push(
        mdKvTable(
          customAttrs.map((a) => [
            a.name,
            a.type === "array" ? JSON.stringify(a.value) : String(a.value),
          ]),
          "Custom Attributes"
        )
      );
    }
  } else if (extraFields?.length) {
    // Fallback: no trace-items detail available, show only explicitly requested fields
    const customRows: [string, string][] = extraFields
      .filter((f) => log[f] !== null && log[f] !== undefined)
      .map((f) => [f, String(log[f])]);
    if (customRows.length > 0) {
      lines.push("");
      lines.push(mdKvTable(customRows, "Custom Attributes"));
    }
  }

  return renderMarkdown(lines.join("\n"));
}
