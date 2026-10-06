import { afterEach, describe, expect, test } from "vitest";
import {
  buildTranscriptResult,
  extractTurns,
  formatConversationTable,
  formatTranscriptResult,
  type TranscriptResult,
} from "../../../src/lib/formatters/conversation.js";
import type {
  AgentConversationSpan,
  ConversationListItem,
} from "../../../src/types/conversation.js";

function makeListItem(
  overrides: Partial<ConversationListItem> = {}
): ConversationListItem {
  return {
    conversationId: "conv-abc-123",
    startTimestamp: 1_716_500_000,
    totalTokens: 500,
    toolCalls: 3,
    errors: 0,
    firstInput: "Hello world",
    user: { email: "test@example.com" },
    ...overrides,
  };
}

function makeSpan(
  overrides: Partial<AgentConversationSpan> = {}
): AgentConversationSpan {
  return {
    span_id: "aabb112233445566",
    trace: "00112233445566778899aabbccddeeff",
    project: "my-project",
    "span.name": "gen_ai.invoke_agent",
    "span.status": "ok",
    "precise.start_ts": 1_716_500_000,
    "precise.finish_ts": 1_716_500_010,
    "gen_ai.operation.type": "ai_client",
    "gen_ai.input.messages": '{"messages":[{"role":"user","content":"hi"}]}',
    "gen_ai.output.messages":
      '{"messages":[{"role":"assistant","content":"hello"}]}',
    "gen_ai.usage.total_tokens": "100",
    "gen_ai.request.model": "gpt-4",
    "gen_ai.response.model": "gpt-4",
    ...overrides,
  };
}

describe("formatConversationTable", () => {
  const originalColumns = process.stdout.columns;

  afterEach(() => {
    Object.defineProperty(process.stdout, "columns", {
      value: originalColumns,
      configurable: true,
    });
  });

  function setTerminalWidth(width: number | undefined): void {
    Object.defineProperty(process.stdout, "columns", {
      value: width,
      configurable: true,
    });
  }

  test("renders the full column set on wide terminals", () => {
    setTerminalWidth(200);
    const items = [makeListItem({ title: "Refund a duplicate charge" })];
    const result = formatConversationTable(items);
    // The table shrinks columns to terminal width, so long values may be
    // truncated with "…"; assert on surviving prefixes and the token count.
    expect(result).toContain("conv-");
    expect(result).toContain("Refund");
    expect(result).toContain("test@");
    expect(result).toContain("Hello");
    expect(result).toContain("500");
    // Wide mode keeps the Tools/Errs/User columns.
    expect(result).toContain("Tools");
    expect(result).toContain("User");
    expect(result).toContain("Title");
  });

  test("keeps Title column on narrow terminals", () => {
    setTerminalWidth(80);
    const items = [makeListItem({ title: "Refund a duplicate charge" })];
    const result = formatConversationTable(items);
    expect(result).toContain("Title");
    expect(result).toContain("Refund");
    expect(result).toContain("conv-");
    // Tools/Errs/User still dropped on narrow terminals.
    expect(result).not.toContain("Tools");
    expect(result).not.toContain("User");
  });

  test("drops Tools/Errs/User columns on narrow terminals", () => {
    setTerminalWidth(80);
    const items = [makeListItem()];
    const result = formatConversationTable(items);
    // Core columns survive.
    expect(result).toContain("conv-");
    expect(result).toContain("Hello");
    expect(result).toContain("500");
    // Lower-value columns are dropped to avoid aggressive truncation.
    expect(result).not.toContain("Tools");
    expect(result).not.toContain("test@");
  });

  test("handles missing user and input", () => {
    const items = [makeListItem({ user: undefined, firstInput: undefined })];
    const result = formatConversationTable(items);
    expect(result).toContain("—");
  });

  test("links conversation IDs to Sentry", () => {
    const previousPlainOutput = process.env.SENTRY_PLAIN_OUTPUT;
    process.env.SENTRY_PLAIN_OUTPUT = "0";
    try {
      const webUrl =
        "https://sentry.io/organizations/test-org/explore/agents/conversations/conv-abc-123/";
      const result = formatConversationTable([makeListItem({ webUrl })]);
      expect(result).toContain(`]8;;${webUrl}`);
    } finally {
      if (previousPlainOutput === undefined) {
        delete process.env.SENTRY_PLAIN_OUTPUT;
      } else {
        process.env.SENTRY_PLAIN_OUTPUT = previousPlainOutput;
      }
    }
  });

  test("truncates long conversation IDs", () => {
    const longId = "a".repeat(60);
    const items = [makeListItem({ conversationId: longId })];
    const result = formatConversationTable(items);
    expect(result).not.toContain(longId);
    expect(result).toContain("…");
  });

  test("keeps UUID conversation IDs intact on narrow terminals", () => {
    setTerminalWidth(80);
    const conversationId = "123e4567-e89b-12d3-a456-426614174000";
    const result = formatConversationTable([makeListItem({ conversationId })]);
    expect(result).toContain(conversationId);
  });

  test("formats timestamps correctly (not 1970)", () => {
    const items = [makeListItem({ startTimestamp: 1_716_500_000 })];
    const result = formatConversationTable(items);
    expect(result).not.toContain("1970");
  });

  test("shows dash for zero timestamp", () => {
    const items = [makeListItem({ startTimestamp: 0 })];
    const result = formatConversationTable(items);
    expect(result).toContain("—");
  });
});

describe("extractTurns", () => {
  test("extracts turns from ai_client spans", () => {
    const spans = [makeSpan()];
    const turns = extractTurns(spans);
    expect(turns).toHaveLength(1);
    expect(turns[0].turn).toBe(1);
    expect(turns[0].userContent).toBe("hi");
    expect(turns[0].assistantContent).toBe("hello");
    expect(turns[0].model).toBe("gpt-4");
  });

  test("associates tool calls with the correct turn", () => {
    const aiSpan = makeSpan({
      "precise.start_ts": 100,
      "precise.finish_ts": 110,
    });
    const toolSpan = makeSpan({
      span_id: "tool111122223333",
      "gen_ai.operation.type": "tool",
      "span.name": "gen_ai.execute_tool",
      "gen_ai.tool.name": "search",
      "precise.start_ts": 105,
      "precise.finish_ts": 106,
    });
    const turns = extractTurns([aiSpan, toolSpan]);
    expect(turns).toHaveLength(1);
    expect(turns[0].toolCalls).toHaveLength(1);
    expect(turns[0].toolCalls[0].name).toBe("search");
  });

  test("returns empty array for no spans", () => {
    expect(extractTurns([])).toEqual([]);
  });

  test("sorts spans by start timestamp", () => {
    const span1 = makeSpan({
      span_id: "aaaa111122223333",
      "precise.start_ts": 200,
      "precise.finish_ts": 210,
    });
    const span2 = makeSpan({
      span_id: "bbbb111122223333",
      "precise.start_ts": 100,
      "precise.finish_ts": 110,
    });
    const turns = extractTurns([span1, span2]);
    expect(turns[0].started).toBe(100);
    expect(turns[1].started).toBe(200);
  });

  test("handles filtered content", () => {
    const span = makeSpan({
      "gen_ai.input.messages": "[Filtered]",
      "gen_ai.output.messages": "[Filtered]",
    });
    const turns = extractTurns([span]);
    expect(turns[0].userContent).toBe("[Filtered]");
    expect(turns[0].assistantContent).toBe("[Filtered]");
  });

  test("handles null content messages gracefully", () => {
    const span = makeSpan({
      "gen_ai.input.messages": JSON.stringify({
        messages: [{ role: "assistant", content: null }],
      }),
    });
    const turns = extractTurns([span]);
    expect(turns[0].userContent).toBeNull();
  });
});

describe("buildTranscriptResult", () => {
  test("builds result with span data", () => {
    const spans = [makeSpan()];
    const result = buildTranscriptResult("conv-123", "my-org", spans);
    expect(result.conversationId).toBe("conv-123");
    expect(result.org).toBe("my-org");
    expect(result.spanCount).toBe(1);
    expect(result.totalTokens).toBe(100);
    expect(result.projects).toEqual(["my-project"]);
    expect(result.startTimestamp).toBe(1_716_500_000);
    expect(result.endTimestamp).toBe(1_716_500_010);
  });

  test("includes title when provided", () => {
    const result = buildTranscriptResult(
      "conv-123",
      "my-org",
      [makeSpan()],
      "Refund a duplicate charge"
    );
    expect(result.title).toBe("Refund a duplicate charge");
  });

  test("returns zero timestamps for empty spans", () => {
    const result = buildTranscriptResult("conv-123", "my-org", []);
    expect(result.startTimestamp).toBe(0);
    expect(result.endTimestamp).toBe(0);
    expect(result.spanCount).toBe(0);
  });

  test("deduplicates and sorts projects", () => {
    const spans = [
      makeSpan({ project: "b-project" }),
      makeSpan({ span_id: "cc11223344556677", project: "a-project" }),
      makeSpan({ span_id: "dd11223344556677", project: "b-project" }),
    ];
    const result = buildTranscriptResult("conv-123", "my-org", spans);
    expect(result.projects).toEqual(["a-project", "b-project"]);
  });
});

describe("formatTranscriptResult", () => {
  test("shows empty message when no spans found", () => {
    const result: TranscriptResult = {
      conversationId: "conv-123",
      org: "my-org",
      title: null,
      turns: [],
      totalTokens: 0,
      spanCount: 0,
      projects: [],
      startTimestamp: 0,
      endTimestamp: 0,
    };
    const output = formatTranscriptResult(result);
    expect(output).toContain("No spans found");
    expect(output).toContain("conv-123");
  });

  test("includes title in empty-span message when present", () => {
    const result: TranscriptResult = {
      conversationId: "conv-123",
      org: "my-org",
      title: "Refund a duplicate charge",
      turns: [],
      totalTokens: 0,
      spanCount: 0,
      projects: [],
      startTimestamp: 0,
      endTimestamp: 0,
    };
    const output = formatTranscriptResult(result);
    expect(output).toContain("conv-123");
    expect(output).toContain("Refund a duplicate charge");
  });

  test("renders transcript header and turns", () => {
    const spans = [makeSpan()];
    const transcript = buildTranscriptResult("conv-123", "my-org", spans);
    const output = formatTranscriptResult(transcript);
    expect(output).toContain("Agent Conversation: conv-123");
    expect(output).toContain("my-org");
    expect(output).toContain("my-project");
    expect(output).toContain("user");
    expect(output).toContain("assistant");
    expect(output).toContain("Turn 1");
  });

  test("keeps conversation ID in heading and shows title in table", () => {
    const transcript = buildTranscriptResult(
      "conv-123",
      "my-org",
      [makeSpan()],
      "Refund a duplicate charge"
    );
    const output = formatTranscriptResult(transcript);
    expect(output).toContain("Agent Conversation: conv-123");
    expect(output).toContain("Refund a duplicate charge");
  });

  test("shows truncation warning", () => {
    const result: TranscriptResult = {
      conversationId: "conv-123",
      org: "my-org",
      title: null,
      turns: [],
      totalTokens: 0,
      spanCount: 1,
      projects: [],
      startTimestamp: 100,
      endTimestamp: 200,
      truncated: true,
    };
    const output = formatTranscriptResult(result);
    expect(output).toContain("truncated");
  });

  test("preserves newlines in multi-line content", () => {
    const span = makeSpan({
      "gen_ai.output.messages": JSON.stringify({
        messages: [
          { role: "assistant", content: "line one\nline two\nline three" },
        ],
      }),
    });
    const transcript = buildTranscriptResult("conv-123", "my-org", [span]);
    const output = formatTranscriptResult(transcript);
    expect(output).toContain("line one");
    expect(output).toContain("line two");
    expect(output).toContain("line three");
  });

  test("renders tool calls in turns", () => {
    const aiSpan = makeSpan({
      "precise.start_ts": 100,
      "precise.finish_ts": 110,
    });
    const toolSpan = makeSpan({
      span_id: "tool111122223333",
      "gen_ai.operation.type": "tool",
      "span.name": "gen_ai.execute_tool",
      "gen_ai.tool.name": "web_search",
      "precise.start_ts": 105,
      "precise.finish_ts": 106,
      "span.status": "ok",
    });
    const transcript = buildTranscriptResult("conv-123", "my-org", [
      aiSpan,
      toolSpan,
    ]);
    const output = formatTranscriptResult(transcript);
    expect(output).toContain("tools");
    expect(output).toContain("web_search");
  });

  test("renders tool call with non-ok status", () => {
    const aiSpan = makeSpan({
      "precise.start_ts": 100,
      "precise.finish_ts": 110,
    });
    const toolSpan = makeSpan({
      span_id: "tool111122223333",
      "gen_ai.operation.type": "tool",
      "span.name": "gen_ai.execute_tool",
      "gen_ai.tool.name": "db_query",
      "precise.start_ts": 105,
      "precise.finish_ts": 106,
      "span.status": "internal_error",
    });
    const transcript = buildTranscriptResult("conv-123", "my-org", [
      aiSpan,
      toolSpan,
    ]);
    const output = formatTranscriptResult(transcript);
    expect(output).toContain("(internal_error)");
  });

  test("renders model and agent name in turn metadata", () => {
    const span = makeSpan({
      "gen_ai.response.model": "claude-3",
      "gen_ai.agent.name": "my-agent",
    });
    const transcript = buildTranscriptResult("conv-123", "my-org", [span]);
    const output = formatTranscriptResult(transcript);
    expect(output).toContain("claude-3");
    expect(output).toContain("my-agent");
  });

  test("renders token count in metadata", () => {
    const span = makeSpan({ "gen_ai.usage.total_tokens": "1500" });
    const transcript = buildTranscriptResult("conv-123", "my-org", [span]);
    const output = formatTranscriptResult(transcript);
    expect(output).toContain("1500 tokens");
  });
});

describe("extractTurns: content extraction edge cases", () => {
  test("extracts from gen_ai.response.text fallback", () => {
    const span = makeSpan({
      "gen_ai.output.messages": undefined,
      "gen_ai.response.text": "fallback text",
    });
    const turns = extractTurns([span]);
    expect(turns[0].assistantContent).toBe("fallback text");
  });

  test("extracts from gen_ai.response.object fallback", () => {
    const span = makeSpan({
      "gen_ai.output.messages": undefined,
      "gen_ai.response.text": undefined,
      "gen_ai.response.object": '{"result": true}',
    });
    const turns = extractTurns([span]);
    expect(turns[0].assistantContent).toBe('{"result": true}');
  });

  test("handles plain string input messages", () => {
    const span = makeSpan({
      "gen_ai.input.messages": "plain string input",
    });
    const turns = extractTurns([span]);
    expect(turns[0].userContent).toBe("plain string input");
  });

  test("handles array of string messages", () => {
    const span = makeSpan({
      "gen_ai.input.messages": JSON.stringify(["msg1", "msg2"]),
    });
    const turns = extractTurns([span]);
    expect(turns[0].userContent).toBe("msg2");
  });

  test("handles message with text field instead of content", () => {
    const span = makeSpan({
      "gen_ai.input.messages": JSON.stringify({
        messages: [{ role: "user", text: "from text field" }],
      }),
    });
    const turns = extractTurns([span]);
    expect(turns[0].userContent).toBe("from text field");
  });

  test("handles array content parts with text", () => {
    const span = makeSpan({
      "gen_ai.output.messages": JSON.stringify({
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "part one" }, { text: "part two" }],
          },
        ],
      }),
    });
    const turns = extractTurns([span]);
    expect(turns[0].assistantContent).toContain("part one");
    expect(turns[0].assistantContent).toContain("part two");
  });

  test("handles no input or output messages", () => {
    const span = makeSpan({
      "gen_ai.input.messages": undefined,
      "gen_ai.request.messages": undefined,
      "gen_ai.output.messages": undefined,
      "gen_ai.response.text": undefined,
      "gen_ai.response.object": undefined,
    });
    const turns = extractTurns([span]);
    expect(turns[0].userContent).toBeNull();
    expect(turns[0].assistantContent).toBeNull();
  });

  test("extracts from gen_ai.request.messages fallback", () => {
    const span = makeSpan({
      "gen_ai.input.messages": undefined,
      "gen_ai.request.messages": JSON.stringify({
        messages: [{ role: "user", content: "from request" }],
      }),
    });
    const turns = extractTurns([span]);
    expect(turns[0].userContent).toBe("from request");
  });

  test("handles numeric token values", () => {
    const span = makeSpan({
      "gen_ai.usage.total_tokens": 42,
    });
    const turns = extractTurns([span]);
    expect(turns[0].totalTokens).toBe(42);
  });

  test("handles missing token values", () => {
    const span = makeSpan({
      "gen_ai.usage.total_tokens": undefined,
    });
    const turns = extractTurns([span]);
    expect(turns[0].totalTokens).toBe(0);
  });

  test("detects operation type from span name when explicit type missing", () => {
    const span = makeSpan({
      "gen_ai.operation.type": undefined,
      "span.name": "gen_ai.execute_tool",
    });
    const turns = extractTurns([span]);
    expect(turns).toHaveLength(0);
  });

  test("detects agent operation type from span name", () => {
    const span = makeSpan({
      "gen_ai.operation.type": undefined,
      "span.name": "gen_ai.invoke_agent",
    });
    const turns = extractTurns([span]);
    expect(turns).toHaveLength(0);
  });

  test("ignores non-gen_ai span names", () => {
    const span = makeSpan({
      "gen_ai.operation.type": undefined,
      "span.name": "http.client",
    });
    const turns = extractTurns([span]);
    expect(turns).toHaveLength(0);
  });

  test("detects handoff operation type", () => {
    const span = makeSpan({
      "gen_ai.operation.type": undefined,
      "span.name": "gen_ai.handoff",
    });
    const turns = extractTurns([span]);
    expect(turns).toHaveLength(0);
  });

  test("falls back to ai_client for unknown gen_ai span names", () => {
    const span = makeSpan({
      "gen_ai.operation.type": undefined,
      "span.name": "gen_ai.something_new",
    });
    const turns = extractTurns([span]);
    expect(turns).toHaveLength(1);
  });
});
