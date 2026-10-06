/**
 * Unit tests for local dev server formatters.
 *
 * Note: Core invariants (never-throw, sanitization round-trips, filter
 * emptiness) are tested via property-based tests in local.property.test.ts.
 * These tests focus on specific output formatting and edge cases.
 */

import { describe, expect, test } from "vitest";
import type { FilterValue } from "../../../src/lib/formatters/local.js";
import {
  extractTraceId,
  formatAttributeTable,
  formatErrorItem,
  formatItem,
  formatItemJson,
  formatSingleLog,
  formatSingleSpan,
  formatSpanItem,
  formatTime,
  formatTransactionItem,
  inferSource,
  isItemIncluded,
  itemTypeToFilterCategory,
} from "../../../src/lib/formatters/local.js";
import { stripAnsi } from "../../../src/lib/formatters/plain-detect.js";

describe("formatTime", () => {
  test("formats epoch seconds", () => {
    const result = formatTime(1_700_000_000);
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  test("formats ISO string", () => {
    const result = formatTime("2024-01-15T12:30:45Z");
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  test("returns current time for NaN (NaN is falsy)", () => {
    // NaN is falsy, so !timestamp is true → uses new Date()
    const result = formatTime(Number.NaN);
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  test("returns ??:??:?? for unparseable string", () => {
    expect(formatTime("not-a-date")).toBe("??:??:??");
  });

  test("returns current time when missing", () => {
    const result = formatTime();
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  test("returns current time for undefined", () => {
    const result = formatTime(undefined);
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});

describe("formatErrorItem", () => {
  const serverHeader = { sdk: { name: "sentry.node" } };

  test("formats error with exception values", () => {
    const event = {
      timestamp: 1_700_000_000,
      exception: {
        values: [{ type: "TypeError", value: "x is not a function" }],
      },
    };
    const result = stripAnsi(formatErrorItem(event, serverHeader));
    expect(result).toContain("[ERROR]");
    expect(result).toContain("TypeError: x is not a function");
  });

  test("falls back to message when no exception", () => {
    const event = {
      timestamp: 1_700_000_000,
      message: "Something went wrong",
    };
    const result = stripAnsi(formatErrorItem(event, serverHeader));
    expect(result).toContain("Error: Something went wrong");
  });

  test("falls back to Unknown error when no exception or message", () => {
    const event = { timestamp: 1_700_000_000 };
    const result = stripAnsi(formatErrorItem(event, serverHeader));
    expect(result).toContain("Error: Unknown error");
  });

  test("includes stack frame hint for in_app frame", () => {
    const event = {
      timestamp: 1_700_000_000,
      exception: {
        values: [
          {
            type: "Error",
            value: "boom",
            stacktrace: {
              frames: [
                { filename: "node_modules/lib.js", lineno: 10, in_app: false },
                {
                  filename: "src/handler.ts",
                  lineno: 42,
                  colno: 5,
                  function: "handleRequest",
                  in_app: true,
                },
              ],
            },
          },
        ],
      },
    };
    const result = stripAnsi(formatErrorItem(event, serverHeader));
    expect(result).toContain("[src/handler.ts:42:5]");
    expect(result).toContain("[handleRequest]");
  });

  test("prefers in_app frame over last frame", () => {
    const event = {
      timestamp: 1_700_000_000,
      exception: {
        values: [
          {
            type: "Error",
            value: "boom",
            stacktrace: {
              frames: [
                { filename: "src/app.ts", lineno: 10, in_app: true },
                { filename: "node_modules/lib.js", lineno: 99, in_app: false },
              ],
            },
          },
        ],
      },
    };
    const result = stripAnsi(formatErrorItem(event, serverHeader));
    expect(result).toContain("[src/app.ts:10]");
  });

  test("surfaces a short trace ID when present", () => {
    const event = {
      timestamp: 1_700_000_000,
      message: "boom",
      contexts: { trace: { trace_id: "1a2b3c4d5e6f70819a2b3c4d5e6f7081" } },
    };
    const result = stripAnsi(formatErrorItem(event, serverHeader));
    expect(result).toContain("[trace:1a2b3c4d]");
  });

  test("omits the trace token when no trace ID", () => {
    const event = { timestamp: 1_700_000_000, message: "boom" };
    const result = stripAnsi(formatErrorItem(event, serverHeader));
    expect(result).not.toContain("[trace:");
  });
});

describe("formatTransactionItem", () => {
  const browserHeader = { sdk: { name: "sentry.javascript.browser" } };

  test("formats transaction with op", () => {
    const event = {
      timestamp: 1_700_000_001,
      start_timestamp: 1_700_000_000,
      transaction: "GET /api/users",
      contexts: { trace: { op: "http.client", status: "ok" } },
    };
    const result = stripAnsi(formatTransactionItem(event, browserHeader));
    expect(result).toContain("[TRACE]");
    expect(result).toContain("[http.client]");
    expect(result).toContain("GET /api/users");
    expect(result).toContain("[1000ms]");
  });

  test("omits op when default", () => {
    const event = {
      timestamp: 1_700_000_001,
      start_timestamp: 1_700_000_000,
      transaction: "my-txn",
      contexts: { trace: { op: "default" } },
    };
    const result = stripAnsi(formatTransactionItem(event, browserHeader));
    expect(result).not.toContain("[default]");
    expect(result).toContain("my-txn");
  });

  test("shows non-ok status", () => {
    const event = {
      timestamp: 1_700_000_001,
      start_timestamp: 1_700_000_000,
      transaction: "POST /api",
      contexts: { trace: { op: "http.server", status: "internal_error" } },
    };
    const result = stripAnsi(formatTransactionItem(event, browserHeader));
    expect(result).toContain("[internal_error]");
  });

  test("shows span count", () => {
    const event = {
      timestamp: 1_700_000_001,
      start_timestamp: 1_700_000_000,
      transaction: "my-txn",
      contexts: { trace: { op: "http.server" } },
      spans: [{}, {}, {}],
    };
    const result = stripAnsi(formatTransactionItem(event, browserHeader));
    expect(result).toContain("[3 spans]");
  });

  test("uses singular span for count of 1", () => {
    const event = {
      timestamp: 1_700_000_001,
      start_timestamp: 1_700_000_000,
      transaction: "my-txn",
      contexts: { trace: { op: "http.server" } },
      spans: [{}],
    };
    const result = stripAnsi(formatTransactionItem(event, browserHeader));
    expect(result).toContain("[1 span]");
  });

  test("falls back to Transaction when no transaction name", () => {
    const event = {
      timestamp: 1_700_000_001,
      start_timestamp: 1_700_000_000,
      contexts: { trace: {} },
    };
    const result = stripAnsi(formatTransactionItem(event, browserHeader));
    expect(result).toContain("Transaction");
  });

  test("surfaces a short trace ID when present", () => {
    const event = {
      timestamp: 1_700_000_001,
      start_timestamp: 1_700_000_000,
      transaction: "GET /",
      contexts: {
        trace: {
          op: "http.server",
          trace_id: "deadbeefcafebabe0123456789abcdef",
        },
      },
    };
    const result = stripAnsi(formatTransactionItem(event, browserHeader));
    expect(result).toContain("[trace:deadbeef]");
  });

  describe("semantic display from OTel attributes", () => {
    const serverHeader = { sdk: { name: "sentry.python" } };

    test("renders GenAI operation with model from trace data", () => {
      const event = {
        timestamp: 1_700_000_002,
        start_timestamp: 1_700_000_000,
        transaction: "process_user_request",
        contexts: {
          trace: {
            op: "ai.pipeline",
            data: {
              "gen_ai.operation.name": "chat",
              "gen_ai.request.model": "claude-4-sonnet",
              "gen_ai.provider.name": "anthropic",
            },
          },
        },
        spans: [{}, {}, {}, {}, {}],
      };
      const result = stripAnsi(formatTransactionItem(event, serverHeader));
      expect(result).toContain("[gen_ai]");
      expect(result).toContain("chat anthropic/claude-4-sonnet");
      expect(result).toContain("[2000ms]");
      expect(result).toContain("[5 spans]");
    });

    test("renders MCP tool call from trace data", () => {
      const event = {
        timestamp: 1_700_000_001,
        start_timestamp: 1_700_000_000,
        transaction: "mcp-request",
        contexts: {
          trace: {
            op: "http.client",
            data: {
              "mcp.method.name": "tools/call",
              "gen_ai.tool.name": "search_files",
            },
          },
        },
      };
      const result = stripAnsi(formatTransactionItem(event, serverHeader));
      expect(result).toContain("[mcp]");
      expect(result).toContain("tools/call search_files");
    });

    test("renders HTTP with server address from OTel attributes", () => {
      const event = {
        timestamp: 1_700_000_002,
        start_timestamp: 1_700_000_000,
        transaction: "POST",
        contexts: {
          trace: {
            op: "http.client",
            data: {
              "http.request.method": "POST",
              "server.address": "api.anthropic.com",
              "http.response.status_code": "200",
            },
          },
        },
      };
      const result = stripAnsi(formatTransactionItem(event, serverHeader));
      expect(result).toContain("[http.client]");
      expect(result).toContain("POST api.anthropic.com");
      expect(result).toContain("[200]");
    });

    test("renders database query from OTel attributes", () => {
      const event = {
        timestamp: 1_700_000_001,
        start_timestamp: 1_700_000_000,
        transaction: "db-query",
        contexts: {
          trace: {
            op: "db",
            data: {
              "db.system.name": "postgresql",
              "db.query.summary": "SELECT users",
            },
          },
        },
      };
      const result = stripAnsi(formatTransactionItem(event, serverHeader));
      expect(result).toContain("[db]");
      expect(result).toContain("SELECT users");
      expect(result).toContain("[postgresql]");
    });

    test("falls back to transaction name when no semantic attributes", () => {
      const event = {
        timestamp: 1_700_000_001,
        start_timestamp: 1_700_000_000,
        transaction: "GET /api/users",
        contexts: {
          trace: {
            op: "http.server",
            data: {},
          },
        },
      };
      const result = stripAnsi(formatTransactionItem(event, serverHeader));
      expect(result).toContain("[http.server]");
      expect(result).toContain("GET /api/users");
    });

    test("renders GenAI error with error type metadata", () => {
      const event = {
        timestamp: 1_700_000_001,
        start_timestamp: 1_700_000_000,
        transaction: "ai-chat",
        contexts: {
          trace: {
            op: "ai.pipeline",
            data: {
              "gen_ai.operation.name": "chat",
              "gen_ai.request.model": "gpt-4o",
              "error.type": "RateLimitError",
            },
          },
        },
      };
      const result = stripAnsi(formatTransactionItem(event, serverHeader));
      expect(result).toContain("[gen_ai]");
      expect(result).toContain("chat gpt-4o");
      expect(result).toContain("[RateLimitError]");
    });
  });
});

describe("formatSingleLog", () => {
  test("formats log with body", () => {
    const result = stripAnsi(
      formatSingleLog(
        { level: "info", body: "User logged in", timestamp: 1_700_000_000 },
        "[SERVER]  "
      )
    );
    expect(result).toContain("[INFO]");
    expect(result).toContain("User logged in");
  });

  test("filters sentry.* attributes", () => {
    const result = stripAnsi(
      formatSingleLog(
        {
          level: "info",
          body: "hello",
          attributes: {
            "sentry.sdk.name": { value: "node" },
            user_id: { value: 42 },
          },
        },
        "[SERVER]  "
      )
    );
    expect(result).toContain("[user_id=42]");
    expect(result).not.toContain("sentry.sdk.name");
  });

  test("formats without body", () => {
    const result = stripAnsi(formatSingleLog({ level: "debug" }, "[SERVER]  "));
    expect(result).toContain("[DEBUG]");
  });

  test("defaults level to log when missing", () => {
    const result = stripAnsi(formatSingleLog({}, "[SERVER]  "));
    expect(result).toContain("[LOG]");
  });

  test("renders user attributes in alphabetical order", () => {
    const result = stripAnsi(
      formatSingleLog(
        {
          level: "info",
          body: "hello",
          attributes: {
            zeta: { value: 1 },
            alpha: { value: 2 },
            mid: { value: 3 },
          },
        },
        "[SERVER]  "
      )
    );
    const alphaIdx = result.indexOf("[alpha=2]");
    const midIdx = result.indexOf("[mid=3]");
    const zetaIdx = result.indexOf("[zeta=1]");
    expect(alphaIdx).toBeGreaterThan(-1);
    expect(alphaIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(zetaIdx);
  });

  test("surfaces trace ID from sentry.trace.trace_id attribute", () => {
    const result = stripAnsi(
      formatSingleLog(
        {
          level: "info",
          body: "hello",
          attributes: {
            "sentry.trace.trace_id": {
              value: "abcdef0123456789abcdef0123456789",
            },
          },
        },
        "[SERVER]  "
      )
    );
    expect(result).toContain("[trace:abcdef01]");
    expect(result).not.toContain("sentry.trace.trace_id");
  });
});

describe("formatItem", () => {
  const header = { sdk: { name: "sentry.node" } };

  test("dispatches error type to error formatter", () => {
    const event = { timestamp: 1_700_000_000, message: "boom" };
    const lines = formatItem("error", event, header, "fallback");
    expect(lines).toHaveLength(1);
    expect(stripAnsi(lines[0])).toContain("[ERROR]");
  });

  test("dispatches event type to error formatter", () => {
    const event = { timestamp: 1_700_000_000, message: "boom" };
    const lines = formatItem("event", event, header, "fallback");
    expect(lines).toHaveLength(1);
    expect(stripAnsi(lines[0])).toContain("[ERROR]");
  });

  test("dispatches transaction type to transaction formatter", () => {
    const event = {
      timestamp: 1_700_000_001,
      start_timestamp: 1_700_000_000,
      transaction: "GET /",
      contexts: { trace: { op: "http.server" } },
    };
    const lines = formatItem("transaction", event, header, "fallback");
    expect(lines).toHaveLength(1);
    expect(stripAnsi(lines[0])).toContain("[TRACE]");
  });

  test("dispatches log type to log formatter", () => {
    const event = {
      items: [{ level: "info", body: "hello" }],
    };
    const lines = formatItem("log", event, header, "fallback");
    expect(lines).toHaveLength(1);
    expect(stripAnsi(lines[0])).toContain("[INFO]");
  });

  test("falls back for unknown types", () => {
    const lines = formatItem("attachment", {}, header, "attachment");
    expect(lines).toHaveLength(1);
    expect(stripAnsi(lines[0])).toContain("attachment");
  });

  test("falls back for undefined type", () => {
    const lines = formatItem(undefined, {}, header, "unknown");
    expect(lines).toHaveLength(1);
    expect(stripAnsi(lines[0])).toContain("unknown");
  });
});

describe("isItemIncluded", () => {
  test("empty filters includes everything", () => {
    const empty = new Set<FilterValue>();
    expect(isItemIncluded("error", empty)).toBe(true);
    expect(isItemIncluded("transaction", empty)).toBe(true);
    expect(isItemIncluded("log", empty)).toBe(true);
    expect(isItemIncluded("attachment", empty)).toBe(true);
    expect(isItemIncluded(undefined, empty)).toBe(true);
  });

  test("error filter matches error and event types", () => {
    const filters = new Set<FilterValue>(["error"]);
    expect(isItemIncluded("error", filters)).toBe(true);
    expect(isItemIncluded("event", filters)).toBe(true);
    expect(isItemIncluded("transaction", filters)).toBe(false);
    expect(isItemIncluded("log", filters)).toBe(false);
  });

  test("transaction filter matches only transaction", () => {
    const filters = new Set<FilterValue>(["transaction"]);
    expect(isItemIncluded("transaction", filters)).toBe(true);
    expect(isItemIncluded("error", filters)).toBe(false);
  });

  test("log filter matches only log", () => {
    const filters = new Set<FilterValue>(["log"]);
    expect(isItemIncluded("log", filters)).toBe(true);
    expect(isItemIncluded("error", filters)).toBe(false);
  });

  test("non-matching item type excluded with active filters", () => {
    const filters = new Set<FilterValue>(["error"]);
    expect(isItemIncluded("attachment", filters)).toBe(false);
    expect(isItemIncluded(undefined, filters)).toBe(false);
  });

  describe("ai filter", () => {
    const ai = new Set<FilterValue>(["ai"]);

    test("matches transaction with gen_ai attributes on the trace root", () => {
      const payload = {
        contexts: {
          trace: {
            op: "gen_ai.chat",
            data: { "gen_ai.operation.name": "chat" },
          },
        },
      };
      expect(isItemIncluded("transaction", ai, payload)).toBe(true);
    });

    test("matches Vercel AI transaction with gen_ai on a child span", () => {
      // The /api/ai/chat HTTP handler is the transaction root; the GenAI
      // generation lives on a child span, where gen_ai.* attributes are set.
      const payload = {
        transaction: "POST /api/ai/chat",
        contexts: { trace: { op: "http.server" } },
        spans: [
          { op: "http.server", data: { "http.request.method": "POST" } },
          {
            op: "gen_ai.generate_text",
            data: {
              "gen_ai.operation.name": "chat",
              "gen_ai.request.model": "gpt-4o",
            },
          },
        ],
      };
      expect(isItemIncluded("transaction", ai, payload)).toBe(true);
    });

    test("matches transaction with mcp attributes on a child span", () => {
      const payload = {
        contexts: { trace: { op: "http.server" } },
        spans: [{ data: { "mcp.method.name": "tools/call" } }],
      };
      expect(isItemIncluded("transaction", ai, payload)).toBe(true);
    });

    test("matches a child span carrying only gen_ai.request.model", () => {
      // No gen_ai.operation.name/tool/agent key, so inferSemanticOp would not
      // return "gen_ai" — prefix-based detection is required to catch this.
      const payload = {
        contexts: { trace: { op: "http.server" } },
        spans: [{ data: { "gen_ai.request.model": "gpt-4o" } }],
      };
      expect(isItemIncluded("transaction", ai, payload)).toBe(true);
    });

    test("matches a child span carrying only gen_ai.usage.input_tokens", () => {
      const payload = {
        contexts: { trace: { op: "http.server" } },
        spans: [{ data: { "gen_ai.usage.input_tokens": 1234 } }],
      };
      expect(isItemIncluded("transaction", ai, payload)).toBe(true);
    });

    test("matches a trace root carrying only gen_ai.provider.name", () => {
      const payload = {
        contexts: {
          trace: {
            op: "http.server",
            data: { "gen_ai.provider.name": "anthropic" },
          },
        },
      };
      expect(isItemIncluded("transaction", ai, payload)).toBe(true);
    });

    test("excludes a plain HTTP transaction with no AI spans", () => {
      const payload = {
        contexts: { trace: { op: "http.server" } },
        spans: [{ data: { "http.request.method": "GET" } }],
      };
      expect(isItemIncluded("transaction", ai, payload)).toBe(false);
    });

    test("excludes errors and logs", () => {
      expect(isItemIncluded("error", ai, {})).toBe(false);
      expect(isItemIncluded("log", ai, {})).toBe(false);
    });
  });
});

describe("extractTraceId", () => {
  test("returns the lowercase trace ID from contexts.trace", () => {
    const event = {
      contexts: { trace: { trace_id: "ABCDEF0123456789ABCDEF0123456789" } },
    };
    expect(extractTraceId(event)).toBe("abcdef0123456789abcdef0123456789");
  });

  test("returns undefined for a malformed trace ID", () => {
    expect(
      extractTraceId({ contexts: { trace: { trace_id: "nope" } } })
    ).toBeUndefined();
  });

  test("returns undefined when absent", () => {
    expect(extractTraceId({})).toBeUndefined();
    expect(extractTraceId({ contexts: {} })).toBeUndefined();
  });
});

describe("itemTypeToFilterCategory", () => {
  test("maps error types to error", () => {
    expect(itemTypeToFilterCategory("error")).toBe("error");
    expect(itemTypeToFilterCategory("event")).toBe("error");
  });

  test("maps transaction to transaction", () => {
    expect(itemTypeToFilterCategory("transaction")).toBe("transaction");
  });

  test("maps log to log", () => {
    expect(itemTypeToFilterCategory("log")).toBe("log");
  });

  test("returns undefined for unknown types", () => {
    expect(itemTypeToFilterCategory("attachment")).toBeUndefined();
    expect(itemTypeToFilterCategory("session")).toBeUndefined();
    expect(itemTypeToFilterCategory(undefined)).toBeUndefined();
  });
});

describe("inferSource", () => {
  test("detects mobile SDK (cocoa)", () => {
    const result = stripAnsi(inferSource({ sdk: { name: "sentry.cocoa" } }));
    expect(result).toContain("[MOBILE]");
  });

  test("detects mobile SDK (android)", () => {
    const result = stripAnsi(inferSource({ sdk: { name: "sentry.android" } }));
    expect(result).toContain("[MOBILE]");
  });

  test("detects mobile SDK (react-native)", () => {
    const result = stripAnsi(
      inferSource({ sdk: { name: "sentry.javascript.react-native" } })
    );
    expect(result).toContain("[MOBILE]");
  });

  test("detects mobile SDK (flutter)", () => {
    const result = stripAnsi(
      inferSource({ sdk: { name: "sentry.dart.flutter" } })
    );
    expect(result).toContain("[MOBILE]");
  });

  test("detects browser SDK", () => {
    const result = stripAnsi(
      inferSource({ sdk: { name: "sentry.javascript.browser" } })
    );
    expect(result).toContain("[BROWSER]");
  });

  test("detects server JS SDK (node)", () => {
    const result = stripAnsi(
      inferSource({ sdk: { name: "sentry.javascript.node" } })
    );
    expect(result).toContain("[SERVER]");
  });

  test("detects server JS SDK (nextjs)", () => {
    const result = stripAnsi(
      inferSource({ sdk: { name: "sentry.javascript.nextjs" } })
    );
    expect(result).toContain("[SERVER]");
  });

  test("defaults to server for unknown SDK", () => {
    const result = stripAnsi(inferSource({ sdk: { name: "sentry.python" } }));
    expect(result).toContain("[SERVER]");
  });

  test("defaults to server when no SDK", () => {
    const result = stripAnsi(inferSource({}));
    expect(result).toContain("[SERVER]");
  });
});

describe("formatItemJson", () => {
  const serverHeader = { sdk: { name: "sentry.node" } };
  const browserHeader = { sdk: { name: "sentry.javascript.browser" } };

  test("formats error with exception and stack frame", () => {
    const event = {
      timestamp: 1_700_000_000,
      exception: {
        values: [
          {
            type: "TypeError",
            value: "x is not a function",
            stacktrace: {
              frames: [
                {
                  filename: "src/handler.ts",
                  lineno: 42,
                  colno: 5,
                  function: "handleRequest",
                  in_app: true,
                },
              ],
            },
          },
        ],
      },
    };
    const lines = formatItemJson("error", event, serverHeader);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe("error");
    expect(parsed.error_type).toBe("TypeError");
    expect(parsed.message).toBe("x is not a function");
    expect(parsed.filename).toBe("src/handler.ts");
    expect(parsed.lineno).toBe(42);
    expect(parsed.colno).toBe(5);
    expect(parsed.function).toBe("handleRequest");
    expect(parsed.source).toBe("server");
  });

  test("adds the versioned observation schema to JSON records", () => {
    const lines = formatItemJson(
      "error",
      { timestamp: 1_700_000_000, message: "boom" },
      serverHeader
    );

    expect(JSON.parse(lines[0]).schema_version).toBe(1);
  });

  test("preserves event and envelope identities for agent correlation", () => {
    const lines = formatItemJson(
      "error",
      {
        event_id: "event-123",
        timestamp: 1_700_000_000,
        message: "boom",
      },
      {
        ...serverHeader,
        // Spotlight stores its internal envelope identity as a UUID object.
        __spotlight_envelope_id: { toString: () => "envelope-123" },
      }
    );

    expect(JSON.parse(lines[0])).toMatchObject({
      event_id: "event-123",
      envelope_id: "envelope-123",
    });
  });

  test("formats error without stack frame", () => {
    const event = {
      timestamp: 1_700_000_000,
      message: "Something went wrong",
    };
    const lines = formatItemJson("error", event, serverHeader);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.error_type).toBe("Error");
    expect(parsed.message).toBe("Something went wrong");
    expect(parsed.filename).toBeUndefined();
  });

  test("formats event type as error", () => {
    const event = { timestamp: 1_700_000_000, message: "boom" };
    const lines = formatItemJson("event", event, serverHeader);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe("error");
  });

  test("includes trace_id for errors and transactions", () => {
    const traceId = "1a2b3c4d5e6f70819a2b3c4d5e6f7081";
    const errorLines = formatItemJson(
      "error",
      {
        timestamp: 1_700_000_000,
        message: "boom",
        contexts: { trace: { trace_id: traceId } },
      },
      serverHeader
    );
    expect(JSON.parse(errorLines[0]).trace_id).toBe(traceId);

    const txnLines = formatItemJson(
      "transaction",
      {
        timestamp: 1_700_000_001,
        start_timestamp: 1_700_000_000,
        transaction: "GET /",
        contexts: { trace: { op: "http.server", trace_id: traceId } },
      },
      serverHeader
    );
    expect(JSON.parse(txnLines[0]).trace_id).toBe(traceId);
  });

  test("includes trace_id for logs from sentry.trace.trace_id attribute", () => {
    const traceId = "abcdef0123456789abcdef0123456789";
    const lines = formatItemJson(
      "log",
      {
        items: [
          {
            level: "info",
            body: "hello",
            attributes: {
              "sentry.trace.trace_id": { value: traceId },
            },
          },
        ],
      },
      serverHeader
    );
    expect(JSON.parse(lines[0]).trace_id).toBe(traceId);
  });

  test("formats transaction with semantic attributes", () => {
    const event = {
      timestamp: 1_700_000_002,
      start_timestamp: 1_700_000_000,
      transaction: "process_request",
      contexts: {
        trace: {
          op: "ai.pipeline",
          data: {
            "gen_ai.operation.name": "chat",
            "gen_ai.request.model": "gpt-4o",
          },
        },
      },
      spans: [{}, {}, {}],
    };
    const lines = formatItemJson("transaction", event, serverHeader);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe("transaction");
    expect(parsed.op).toBe("gen_ai");
    expect(parsed.label).toBe("chat gpt-4o");
    expect(parsed.duration_ms).toBe(2000);
    expect(parsed.span_count).toBe(3);
    expect(parsed.source).toBe("server");
  });

  test("formats transaction without semantic attributes", () => {
    const event = {
      timestamp: 1_700_000_001,
      start_timestamp: 1_700_000_000,
      transaction: "GET /api/users",
      contexts: { trace: { op: "http.server" } },
    };
    const lines = formatItemJson("transaction", event, serverHeader);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.label).toBe("GET /api/users");
    expect(parsed.op).toBe("http.server");
  });

  test("formats log entries", () => {
    const event = {
      items: [
        {
          level: "info",
          body: "User logged in",
          timestamp: 1_700_000_000,
          attributes: {
            "sentry.sdk.name": { value: "node" },
            user_id: { value: 42 },
          },
        },
        { level: "debug", body: "Cache hit" },
      ],
    };
    const lines = formatItemJson("log", event, serverHeader);
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]);
    expect(first.type).toBe("log");
    expect(first.level).toBe("info");
    expect(first.message).toBe("User logged in");
    expect(first.attributes).toEqual({ user_id: 42 });
    expect(first.attributes["sentry.sdk.name"]).toBeUndefined();

    const second = JSON.parse(lines[1]);
    expect(second.level).toBe("debug");
    expect(second.message).toBe("Cache hit");
  });

  test("returns empty for log with no items", () => {
    const lines = formatItemJson("log", { items: [] }, serverHeader);
    expect(lines).toHaveLength(0);
  });

  test("formats unknown item types", () => {
    const event = { timestamp: 1_700_000_000 };
    const lines = formatItemJson("attachment", event, serverHeader);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe("attachment");
  });

  test("strips terminal controls from every JSON observation field", () => {
    const lines = formatItemJson(
      "attachment\u202e",
      { timestamp: "2026-09-08\u009b", event_id: "event\u202e-123" },
      serverHeader
    );
    const parsed = JSON.parse(lines[0]);

    expect(parsed).toMatchObject({
      type: "attachment",
      timestamp: "2026-09-08",
      event_id: "event-123",
    });

    const logLines = formatItemJson(
      "log",
      {
        items: [
          {
            body: "safe",
            attributes: {
              nested: { value: { child: "unsafe\u202evalue" } },
            },
          },
        ],
      },
      serverHeader
    );
    expect(JSON.parse(logLines[0]).attributes).toEqual({
      nested: { child: "unsafevalue" },
    });
  });

  test("detects browser source in JSON", () => {
    const event = { timestamp: 1_700_000_000, message: "error" };
    const lines = formatItemJson("error", event, browserHeader);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.source).toBe("browser");
  });

  test("includes grouped attributes only when requested", () => {
    const event = {
      timestamp: 1_700_000_000,
      contexts: { trace: { op: "http.server", data: { "user.id": "42" } } },
    };
    const without = JSON.parse(
      formatItemJson("transaction", event, serverHeader)[0]
    );
    expect(without.attributes).toBeUndefined();
    const withAttrs = JSON.parse(
      formatItemJson("transaction", event, serverHeader, true)[0]
    );
    expect(withAttrs.attributes.user).toEqual({ "user.id": "42" });
  });
});

describe("formatAttributeTable", () => {
  test("returns no lines when the transaction has no attributes", () => {
    expect(formatAttributeTable({ timestamp: 1 })).toEqual([]);
  });

  test("splits SDK-default attributes from user-custom ones", () => {
    const event = {
      contexts: {
        trace: {
          data: {
            "gen_ai.request.model": "gpt-4",
            "http.method": "POST",
            order_id: "abc",
          },
        },
      },
    };
    const out = formatAttributeTable(event).map(stripAnsi).join("\n");
    expect(out).toContain("user attributes");
    expect(out).toContain("order_id");
    expect(out).toContain("sdk attributes");
    expect(out).toContain("gen_ai.request.model");
    expect(out).toContain("http.method");
    // user group is rendered before the sdk group
    expect(out.indexOf("user attributes")).toBeLessThan(
      out.indexOf("sdk attributes")
    );
  });

  test("merges child-span attributes with the trace root", () => {
    const event = {
      contexts: { trace: { data: { "service.name": "api" } } },
      spans: [{ data: { "gen_ai.usage.input_tokens": 10, prompt: "hi" } }],
    };
    const out = formatAttributeTable(event).map(stripAnsi).join("\n");
    expect(out).toContain("gen_ai.usage.input_tokens");
    expect(out).toContain("prompt");
  });

  test("sorts keys alphabetically within a group", () => {
    const event = {
      contexts: { trace: { data: { zeta: 1, alpha: 2, mid: 3 } } },
    };
    const out = formatAttributeTable(event).map(stripAnsi).join("\n");
    expect(out.indexOf("alpha")).toBeLessThan(out.indexOf("mid"));
    expect(out.indexOf("mid")).toBeLessThan(out.indexOf("zeta"));
  });

  test("JSON-encodes object-valued attributes", () => {
    const event = {
      contexts: { trace: { data: { meta: { nested: true } } } },
    };
    const out = formatAttributeTable(event).map(stripAnsi).join("\n");
    expect(out).toContain('{"nested":true}');
  });
});

describe("formatItem with attributes", () => {
  const serverHeader = { sdk: { name: "sentry.node" } };

  test("appends the attribute table for transactions when enabled", () => {
    const event = {
      timestamp: 1_700_000_000,
      transaction: "POST /api/ai/chat",
      contexts: { trace: { op: "http.server", data: { tenant: "acme" } } },
    };
    const withoutAttrs = formatItem("transaction", event, serverHeader, "t");
    expect(withoutAttrs).toHaveLength(1);
    const withAttrs = formatItem("transaction", event, serverHeader, "t", true);
    expect(withAttrs.length).toBeGreaterThan(1);
    expect(withAttrs.map(stripAnsi).join("\n")).toContain("tenant");
  });

  test("does not append a table for errors even when enabled", () => {
    const event = { timestamp: 1_700_000_000, message: "boom" };
    const lines = formatItem("error", event, serverHeader, "e", true);
    expect(lines).toHaveLength(1);
  });
});

describe("standalone span support", () => {
  const cfHeader = { sdk: { name: "sentry.javascript.cloudflare" } };

  const aiSpan = {
    trace_id: "a".repeat(32),
    span_id: "b".repeat(16),
    name: "chat anthropic/claude-4-sonnet",
    start_timestamp: 1_700_000_000,
    end_timestamp: 1_700_000_001.2,
    status: "ok",
    attributes: {
      "gen_ai.system": { type: "string", value: "anthropic" },
      "gen_ai.request.model": { type: "string", value: "claude-4-sonnet" },
      "gen_ai.usage.input_tokens": { type: "integer", value: 512 },
      "gen_ai.usage.output_tokens": { type: "integer", value: 128 },
      "sentry.op": { type: "string", value: "gen_ai.chat" },
    },
  };

  const mcpSpan = {
    trace_id: "c".repeat(32),
    span_id: "d".repeat(16),
    name: "tools/call list_files",
    start_timestamp: 1_700_000_000,
    end_timestamp: 1_700_000_000.4,
    status: "ok",
    attributes: {
      "mcp.method.name": { type: "string", value: "tools/call" },
      "mcp.tool.name": { type: "string", value: "list_files" },
      "sentry.op": { type: "string", value: "mcp.server" },
    },
  };

  describe("formatSingleSpan", () => {
    test("formats a gen_ai span with semantic labels", () => {
      const line = stripAnsi(formatSingleSpan(aiSpan, cfHeader));
      expect(line).toContain("[gen_ai");
      expect(line).toContain("claude-4-sonnet");
      expect(line).toContain("[1200ms]");
      expect(line).toContain("[trace:aaaaaaaa]");
      expect(line).toContain("[SERVER]");
    });

    test("formats an MCP span", () => {
      const line = stripAnsi(formatSingleSpan(mcpSpan, cfHeader));
      expect(line).toContain("mcp");
      expect(line).toContain("tools/call");
      expect(line).toContain("[400ms]");
    });

    test("handles missing name gracefully", () => {
      const span = {
        trace_id: "a".repeat(32),
        start_timestamp: 1_700_000_000,
        end_timestamp: 1_700_000_000.5,
        status: "ok",
        attributes: {
          "http.method": { type: "string", value: "GET" },
        },
      };
      const line = stripAnsi(formatSingleSpan(span, cfHeader));
      expect(line).toContain("[TRACE]");
      expect(line).toContain("[SERVER]");
      expect(line).toContain("[500ms]");
    });
  });

  describe("formatSpanItem", () => {
    test("formats each span in the container", () => {
      const payload = { items: [aiSpan, mcpSpan] };
      const lines = formatSpanItem(payload, cfHeader);
      expect(lines).toHaveLength(2);
      expect(stripAnsi(lines[0]!)).toContain("gen_ai");
      expect(stripAnsi(lines[1]!)).toContain("mcp");
    });

    test("returns empty for missing items", () => {
      expect(formatSpanItem({}, cfHeader)).toHaveLength(0);
      expect(formatSpanItem({ items: [] }, cfHeader)).toHaveLength(0);
    });
  });

  describe("formatItem routes span type", () => {
    test("routes span items to span formatter", () => {
      const payload = { items: [aiSpan] };
      const lines = formatItem("span", payload, cfHeader, "span");
      expect(lines.length).toBeGreaterThanOrEqual(1);
      expect(stripAnsi(lines[0]!)).toContain("gen_ai");
    });
  });

  describe("formatItemJson routes span type", () => {
    test("produces structured JSON for standalone spans", () => {
      const payload = { items: [aiSpan] };
      const lines = formatItemJson("span", payload, cfHeader);
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]!);
      expect(parsed.type).toBe("span");
      expect(parsed.trace_id).toBe("a".repeat(32));
      expect(parsed.span_id).toBe("b".repeat(16));
      expect(parsed.op).toBe("gen_ai.chat");
      expect(parsed.duration_ms).toBe(1200);
      expect(parsed.source).toBe("server");
    });
  });

  describe("itemTypeToFilterCategory maps span to transaction", () => {
    test("maps span to transaction category", () => {
      expect(itemTypeToFilterCategory("span")).toBe("transaction");
    });
  });

  describe("isItemIncluded handles standalone spans", () => {
    test("ai filter matches span items with gen_ai attributes", () => {
      const filters = new Set<FilterValue>(["ai"]);
      const payload = { items: [aiSpan] };
      expect(isItemIncluded("span", filters, payload)).toBe(true);
    });

    test("ai filter matches span items with mcp attributes", () => {
      const filters = new Set<FilterValue>(["ai"]);
      const payload = { items: [mcpSpan] };
      expect(isItemIncluded("span", filters, payload)).toBe(true);
    });

    test("ai filter does not match span items without ai attributes", () => {
      const filters = new Set<FilterValue>(["ai"]);
      const plainSpan = {
        ...aiSpan,
        attributes: {
          "http.method": { type: "string", value: "GET" },
        },
      };
      const payload = { items: [plainSpan] };
      expect(isItemIncluded("span", filters, payload)).toBe(false);
    });

    test("transaction filter matches standalone spans", () => {
      const filters = new Set<FilterValue>(["transaction"]);
      const payload = { items: [aiSpan] };
      expect(isItemIncluded("span", filters, payload)).toBe(true);
    });
  });
});

describe("inferSource cloudflare SDK", () => {
  test("detects Cloudflare Workers SDK as server", () => {
    const result = stripAnsi(
      inferSource({ sdk: { name: "sentry.javascript.cloudflare" } })
    );
    expect(result).toContain("[SERVER]");
  });
});

describe("warn level coloring", () => {
  test("warn level gets formatted with brackets", () => {
    const log = {
      level: "warn",
      body: "Rate limit approaching",
      timestamp: 1_700_000_000,
    };
    const result = formatSingleLog(log, "[SERVER]  ");
    expect(stripAnsi(result)).toContain("[WARN]");
  });
});
