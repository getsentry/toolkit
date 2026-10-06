/**
 * Tests for log formatters
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  buildLogRowCells,
  createLogStreamingTable,
  formatLogDetails,
  formatLogRow,
  formatLogsHeader,
  formatLogTable,
  getLogId,
} from "../../../src/lib/formatters/log.js";
import type {
  DetailedSentryLog,
  SentryLog,
  TraceItemAttribute,
} from "../../../src/types/index.js";

/** Force rendered (TTY) mode for a describe block */
function useRenderedMode() {
  let savedPlain: string | undefined;
  beforeEach(() => {
    savedPlain = process.env.SENTRY_PLAIN_OUTPUT;
    process.env.SENTRY_PLAIN_OUTPUT = "0";
  });
  afterEach(() => {
    if (savedPlain === undefined) {
      delete process.env.SENTRY_PLAIN_OUTPUT;
    } else {
      process.env.SENTRY_PLAIN_OUTPUT = savedPlain;
    }
  });
}

/** Force plain mode for a describe block */
function usePlainMode() {
  let savedPlain: string | undefined;
  beforeEach(() => {
    savedPlain = process.env.SENTRY_PLAIN_OUTPUT;
    process.env.SENTRY_PLAIN_OUTPUT = "1";
  });
  afterEach(() => {
    if (savedPlain === undefined) {
      delete process.env.SENTRY_PLAIN_OUTPUT;
    } else {
      process.env.SENTRY_PLAIN_OUTPUT = savedPlain;
    }
  });
}

function createTestLog(overrides: Partial<SentryLog> = {}): SentryLog {
  return {
    "sentry.item_id": "test-id-123",
    timestamp: "2025-01-30T14:32:15Z",
    timestamp_precise: 1_770_060_419_044_800_300,
    message: "Test log message",
    severity: "info",
    trace: "abc123def456",
    ...overrides,
  };
}

// Strip ANSI color codes for easier testing
function stripAnsi(str: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI stripping
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("formatLogRow (rendered mode)", () => {
  useRenderedMode();

  test("formats basic log entry", () => {
    const log = createTestLog();
    const result = formatLogRow(log);

    // Should contain timestamp, severity, message, and trace
    expect(result).toContain("Test log message");
    expect(result).toContain("[abc123de]"); // First 8 chars of trace
    expect(result).toEndWith("\n");
  });

  test("handles missing message", () => {
    const log = createTestLog({ message: null });
    const result = formatLogRow(log);

    // Should not throw, just show empty message area
    expect(result).toContain("INFO");
    expect(result).toEndWith("\n");
  });

  test("handles missing severity", () => {
    const log = createTestLog({ severity: null });
    const result = stripAnsi(formatLogRow(log));

    // Should default to INFO
    expect(result).toContain("INFO");
  });

  test("handles missing trace", () => {
    const log = createTestLog({ trace: null });
    const result = stripAnsi(formatLogRow(log));

    // Should not include trace bracket
    expect(result).not.toContain("[");
    expect(result).toContain("Test log message");
  });

  test("formats different severity levels", () => {
    const levels = [
      "fatal",
      "error",
      "warning",
      "warn",
      "info",
      "debug",
      "trace",
    ];

    for (const level of levels) {
      const log = createTestLog({ severity: level });
      const result = stripAnsi(formatLogRow(log));
      expect(result).toContain(level.toUpperCase().slice(0, 7)); // Max 7 chars
    }
  });

  test("pads severity to consistent width", () => {
    const shortLevel = createTestLog({ severity: "info" });
    const longLevel = createTestLog({ severity: "warning" });

    const shortResult = stripAnsi(formatLogRow(shortLevel));
    const longResult = stripAnsi(formatLogRow(longLevel));

    // Both should have severity at same position
    const shortPos = shortResult.indexOf("INFO");
    const longPos = longResult.indexOf("WARNING");

    // The position after timestamp should be consistent
    expect(shortPos).toBe(longPos);
  });

  test("formats timestamp in local format", () => {
    const log = createTestLog({ timestamp: "2025-01-30T14:32:15Z" });
    const result = formatLogRow(log);

    // Should have date and time format (actual values depend on timezone)
    expect(result).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  });

  test("handles invalid timestamp gracefully", () => {
    const log = createTestLog({ timestamp: "invalid-date" });
    const result = formatLogRow(log);

    // Should return original string instead of NaN
    expect(result).toContain("invalid-date");
    expect(result).not.toContain("NaN");
  });
});

describe("createLogStreamingTable", () => {
  test("header() contains column titles and box-drawing borders", () => {
    const table = createLogStreamingTable({ maxWidth: 120 });
    const result = table.header();

    expect(result).toContain("ID");
    expect(result).toContain("Timestamp");
    expect(result).toContain("Level");
    expect(result).toContain("Message");
    // Box-drawing border characters
    expect(result).toContain("─");
    expect(result).toContain("╭");
  });

  test("row() renders cells with side borders", () => {
    const table = createLogStreamingTable({ maxWidth: 120 });
    const result = table.row([
      "ace106b2",
      "2026-01-15 10:00:00",
      "ERROR",
      "something",
    ]);

    expect(result).toContain("ace106b2");
    expect(result).toContain("2026-01-15 10:00:00");
    expect(result).toContain("ERROR");
    expect(result).toContain("something");
    // Side borders
    expect(result).toContain("│");
  });

  test("footer() renders bottom border", () => {
    const table = createLogStreamingTable({ maxWidth: 120 });
    const result = table.footer();

    expect(result).toContain("─");
    expect(result).toContain("╯");
  });

  test("ends with newline", () => {
    const table = createLogStreamingTable({ maxWidth: 120 });
    expect(table.header()).toEndWith("\n");
    expect(table.row(["a", "b", "c", "d"])).toEndWith("\n");
    expect(table.footer()).toEndWith("\n");
  });

  test("accepts extra columns", () => {
    const table = createLogStreamingTable({ maxWidth: 160 }, [
      "email",
      "user_id",
    ]);
    const result = table.header();

    expect(result).toContain("email");
    expect(result).toContain("user_id");
  });
});

describe("formatLogRow (plain mode)", () => {
  usePlainMode();

  test("emits a markdown table row with 4 columns", () => {
    const log = createTestLog();
    const result = formatLogRow(log);
    // 4 columns: ID | Timestamp | Level | Message
    expect(result).toMatch(/^\|.+\|.+\|.+\|.+\|\n$/);
  });

  test("contains log ID prefix, timestamp, severity, message", () => {
    const log = createTestLog({
      severity: "error",
      message: "connection failed",
    });
    const result = formatLogRow(log);
    expect(result).toContain("test-id-"); // first 8 chars of "test-id-123"
    expect(result).toContain("connection failed");
    expect(result).toContain("ERROR");
    expect(result).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  test("contains trace ID as inline code", () => {
    const log = createTestLog({ trace: "abc123def456" });
    const result = formatLogRow(log);
    expect(result).toContain("[abc123de]");
  });

  test("omits trace cell when trace is null", () => {
    const log = createTestLog({ trace: null });
    const result = formatLogRow(log);
    expect(result).not.toContain("[");
  });

  test("escapes pipe characters in message", () => {
    const log = createTestLog({ message: "a|b" });
    const result = formatLogRow(log);
    // Pipe in message replaced with box-drawing │ so it doesn't break the table
    expect(result).toContain("a\u2502b");
  });

  test("ends with newline", () => {
    const result = formatLogRow(createTestLog());
    expect(result).toEndWith("\n");
  });

  test("renders extra fields as additional columns", () => {
    const log = { ...createTestLog(), email: "user@example.com" };
    const result = formatLogRow(log, true, ["email"]);
    expect(result).toContain("user@example.com");
  });
});

describe("formatLogsHeader (plain mode)", () => {
  usePlainMode();

  test("emits markdown table header and separator with ID column", () => {
    const result = formatLogsHeader();
    // Plain mode produces mdTableHeader output (no bold markup), followed by separator
    expect(result).toContain("| ID | Timestamp | Level | Message |");
    expect(result).toContain("| --- | --- | --- | --- |");
  });

  test("ends with newline", () => {
    expect(formatLogsHeader()).toEndWith("\n");
  });

  test("includes extra columns when provided", () => {
    const result = formatLogsHeader(["email", "user_id"]);
    expect(result).toContain(
      "| ID | Timestamp | Level | Message | email | user_id |"
    );
  });
});

function createDetailedTestLog(
  overrides: Partial<DetailedSentryLog> = {}
): DetailedSentryLog {
  return {
    "sentry.item_id": "test-log-id-123456789012345678901234",
    timestamp: "2025-01-30T14:32:15Z",
    timestamp_precise: 1_770_060_419_044_800_300,
    message: "Test log message",
    severity: "info",
    trace: "abc123def456abc123def456abc12345",
    project: "test-project",
    environment: "production",
    release: "1.0.0",
    "sdk.name": "sentry.javascript.node",
    "sdk.version": "8.0.0",
    span_id: null,
    "code.function": null,
    "code.file.path": null,
    "code.line.number": null,
    "sentry.otel.kind": null,
    "sentry.otel.status_code": null,
    "sentry.otel.instrumentation_scope.name": null,
    ...overrides,
  };
}

describe("formatLogDetails", () => {
  test("formats basic log entry with header", () => {
    const log = createDetailedTestLog();
    const result = stripAnsi(formatLogDetails(log, "test-org"));

    // Header contains log ID prefix
    expect(result).toContain("Log");
    expect(result).toContain("test-log-id");
  });

  test("includes ID, timestamp, and severity", () => {
    const log = createDetailedTestLog();
    const result = stripAnsi(formatLogDetails(log, "test-org"));

    expect(result).toContain("ID");
    expect(result).toContain("test-log-id-123456789012345678901234");
    expect(result).toContain("Timestamp");
    expect(result).toContain("Severity");
    expect(result).toContain("INFO");
  });

  test("includes message when present", () => {
    const log = createDetailedTestLog({ message: "Custom error message" });
    const result = formatLogDetails(log, "test-org");

    expect(result).toContain("Message");
    expect(result).toContain("Custom error message");
  });

  test("shows Context section when project/environment/release present", () => {
    const log = createDetailedTestLog({
      project: "my-project",
      environment: "staging",
      release: "2.0.0",
    });
    const result = stripAnsi(formatLogDetails(log, "test-org"));

    expect(result).toContain("Context");
    expect(result).toContain("Project");
    expect(result).toContain("my-project");
    expect(result).toContain("Environment");
    expect(result).toContain("staging");
    expect(result).toContain("Release");
    expect(result).toContain("2.0.0");
  });

  test("shows SDK section when sdk.name present", () => {
    const log = createDetailedTestLog({
      "sdk.name": "sentry.python",
      "sdk.version": "2.0.0",
    });
    const result = stripAnsi(formatLogDetails(log, "test-org"));

    expect(result).toContain("SDK");
    expect(result).toContain("sentry.python");
    expect(result).toContain("2.0.0");
  });

  test("shows Trace section with URL when trace ID present", () => {
    const log = createDetailedTestLog({
      trace: "trace123abc456def789",
      span_id: "span-abc-123",
    });
    const result = stripAnsi(formatLogDetails(log, "my-org"));

    expect(result).toContain("Trace");
    expect(result).toContain("Trace ID");
    expect(result).toContain("trace123abc456def789");
    expect(result).toContain("Span ID");
    expect(result).toContain("span-abc-123");
    expect(result).toContain("Link");
    expect(result).toContain("my-org.sentry.io/explore/traces/trace/");
  });

  test("shows Source Location when code.function present", () => {
    const log = createDetailedTestLog({
      "code.function": "handleRequest",
      "code.file.path": "src/api/handler.ts",
      "code.line.number": "42",
    });
    const result = stripAnsi(formatLogDetails(log, "test-org"));

    expect(result).toContain("Source Location");
    expect(result).toContain("Function");
    expect(result).toContain("handleRequest");
    expect(result).toContain("File");
    expect(result).toContain("src/api/handler.ts:42");
  });

  test("shows OpenTelemetry section when otel fields present", () => {
    const log = createDetailedTestLog({
      "sentry.otel.kind": "server",
      "sentry.otel.status_code": "OK",
      "sentry.otel.instrumentation_scope.name": "express",
    });
    const result = stripAnsi(formatLogDetails(log, "test-org"));

    expect(result).toContain("OpenTelemetry");
    expect(result).toContain("Kind");
    expect(result).toContain("server");
    expect(result).toContain("Status");
    expect(result).toContain("OK");
    expect(result).toContain("Scope");
    expect(result).toContain("express");
  });

  test("handles missing optional fields gracefully", () => {
    const log = createDetailedTestLog({
      message: null,
      trace: null,
      project: null,
      environment: null,
      release: null,
      "sdk.name": null,
      "sdk.version": null,
    });
    const result = stripAnsi(formatLogDetails(log, "test-org"));

    // Should still have basic info
    expect(result).toContain("ID");
    expect(result).toContain("Timestamp");
    expect(result).toContain("Severity");

    // Should not have optional sections
    expect(result).not.toContain("Context");
    expect(result).not.toContain("SDK");
    expect(result).not.toContain("Trace");
  });

  describe("Custom Attributes section", () => {
    const customAttrs: TraceItemAttribute[] = [
      { name: "user.id", type: "str", value: "u_42" },
      { name: "order.total", type: "float", value: 99.9 },
      { name: "retry.count", type: "int", value: 3 },
      { name: "is_premium", type: "bool", value: true },
    ];

    test("renders custom attributes when allAttributes provided", () => {
      const log = createDetailedTestLog();
      const result = stripAnsi(formatLogDetails(log, "test-org", customAttrs));

      expect(result).toContain("Custom Attributes");
      expect(result).toContain("user.id");
      expect(result).toContain("u_42");
      expect(result).toContain("order.total");
      expect(result).toContain("99.9");
      expect(result).toContain("retry.count");
      expect(result).toContain("3");
      expect(result).toContain("is_premium");
      expect(result).toContain("true");
    });

    test("filters out REDUNDANT_LOG_DETAIL_ATTRS from custom attributes", () => {
      const attrsWithRedundant: TraceItemAttribute[] = [
        { name: "user.id", type: "str", value: "u_42" },
        // these are in REDUNDANT_LOG_DETAIL_ATTRS and should be suppressed
        { name: "severity_number", type: "int", value: 9 },
        { name: "project.id", type: "str", value: "123" },
      ];
      const log = createDetailedTestLog();
      const result = stripAnsi(
        formatLogDetails(log, "test-org", attrsWithRedundant)
      );

      expect(result).toContain("user.id");
      expect(result).not.toContain("severity_number");
      expect(result).not.toContain("project.id");
    });

    test("extraFields limits which custom attributes are shown", () => {
      const log = createDetailedTestLog();
      const result = stripAnsi(
        formatLogDetails(log, "test-org", customAttrs, ["user.id"])
      );

      expect(result).toContain("Custom Attributes");
      expect(result).toContain("user.id");
      expect(result).not.toContain("order.total");
      expect(result).not.toContain("retry.count");
    });

    test("shows no Custom Attributes section when all are filtered by extraFields", () => {
      const log = createDetailedTestLog();
      const result = stripAnsi(
        formatLogDetails(log, "test-org", customAttrs, ["nonexistent.field"])
      );

      expect(result).not.toContain("Custom Attributes");
    });

    test("fallback: shows extraFields from log when allAttributes absent", () => {
      const log = createDetailedTestLog({
        "user.id": "u_99",
      } as DetailedSentryLog);
      const result = stripAnsi(
        formatLogDetails(log, "test-org", undefined, ["user.id"])
      );

      expect(result).toContain("Custom Attributes");
      expect(result).toContain("user.id");
      expect(result).toContain("u_99");
    });

    test("renders array attributes with JSON.stringify instead of [object Object]", () => {
      const attrsWithArray: TraceItemAttribute[] = [
        { name: "tags", type: "array", value: ["prod", "web"] },
        { name: "ids", type: "array", value: [1, 2, 3] },
      ];
      const log = createDetailedTestLog();
      const result = stripAnsi(
        formatLogDetails(log, "test-org", attrsWithArray)
      );

      expect(result).toContain('["prod","web"]');
      expect(result).toContain("[1,2,3]");
      expect(result).not.toContain("[object Object]");
    });

    test("no Custom Attributes section when allAttributes is empty array", () => {
      const log = createDetailedTestLog();
      const result = stripAnsi(formatLogDetails(log, "test-org", []));

      expect(result).not.toContain("Custom Attributes");
    });
  });
});

describe("getLogId", () => {
  test("returns sentry.item_id when present", () => {
    expect(getLogId({ "sentry.item_id": "abc123", timestamp: "" })).toBe(
      "abc123"
    );
  });

  test("falls back to id when sentry.item_id is absent", () => {
    expect(getLogId({ id: "trace-log-id", timestamp: "" })).toBe(
      "trace-log-id"
    );
  });

  test("returns empty string when neither is present", () => {
    expect(getLogId({ timestamp: "" })).toBe("");
  });
});

describe("buildLogRowCells", () => {
  test("returns 4 base cells (ID, Timestamp, Level, Message)", () => {
    const log = createTestLog();
    const cells = buildLogRowCells(log);
    expect(cells.length).toBe(4);
  });

  test("first cell contains short log ID", () => {
    const log = createTestLog();
    const cells = buildLogRowCells(log);
    // First 8 chars of "test-id-123"
    expect(stripAnsi(cells[0])).toContain("test-id-");
  });

  test("appends extra field cells when provided", () => {
    const log = { ...createTestLog(), email: "user@example.com" };
    const cells = buildLogRowCells(log, true, true, ["email"]);
    expect(cells.length).toBe(5);
    expect(cells[4]).toContain("user@example.com");
  });

  test("extra field shows empty for null values", () => {
    const log = createTestLog();
    const cells = buildLogRowCells(log, true, true, ["nonexistent"]);
    expect(cells.length).toBe(5);
    expect(cells[4]).toBe("");
  });
});

describe("formatLogTable", () => {
  test("returns a string", () => {
    const result = formatLogTable([createTestLog()]);
    expect(typeof result).toBe("string");
  });

  test("includes log ID in output", () => {
    const result = stripAnsi(formatLogTable([createTestLog()]));
    // First 8 chars of "test-id-123"
    expect(result).toContain("test-id-");
  });

  test("includes all log messages", () => {
    const logs = [
      createTestLog({ message: "First log" }),
      createTestLog({ message: "Second log" }),
    ];
    const result = stripAnsi(formatLogTable(logs));
    expect(result).toContain("First log");
    expect(result).toContain("Second log");
  });

  test("includes severity levels", () => {
    const result = stripAnsi(
      formatLogTable([createTestLog({ severity: "error" })])
    );
    expect(result).toContain("ERROR");
  });

  test("includes trace IDs when present", () => {
    const result = stripAnsi(
      formatLogTable([createTestLog({ trace: "abcdef1234567890" })])
    );
    expect(result).toContain("abcdef12");
  });

  test("handles empty messages", () => {
    const result = formatLogTable([createTestLog({ message: "" })]);
    expect(typeof result).toBe("string");
  });

  test("includes extra field columns when provided", () => {
    const log = { ...createTestLog(), email: "hi@ex.co" };
    const result = stripAnsi(formatLogTable([log], true, ["email"]));
    expect(result).toContain("email");
    expect(result).toContain("hi@ex.co");
  });
});
