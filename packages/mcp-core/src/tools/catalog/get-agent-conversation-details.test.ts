import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { mswServer } from "@sentry/mcp-server-mocks";
import getAIConversationDetails from "./get-agent-conversation-details";
import getSentryResource from "./get-sentry-resource";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content";

const baseContext = {
  constraints: {},
  accessToken: "access-token",
  userId: "1",
};

type ConversationDetailsForTest = {
  timeline: Array<{
    type: string;
    spanId: string;
    traceId: string;
    genAi?: Record<string, unknown>;
  }>;
  spanSummaries: Array<{
    spanId: string;
    traceId: string;
    spanOp?: string;
    spanDescription?: string;
    transaction?: string;
    genAi?: Record<string, unknown>;
  }>;
} & Record<string, unknown>;

const conversationSpans: Array<Record<string, unknown>> = [
  {
    "gen_ai.conversation.id": "conv-123",
    parent_span: null,
    "precise.finish_ts": 1713805401.5,
    "precise.start_ts": 1713805400,
    project: "mcp-server",
    "project.id": 4509109107622913,
    "span.name": "gen_ai.chat",
    "span.op": "gen_ai.chat",
    "span.description": "chat completion",
    "span.status": "ok",
    span_id: "1111111111111111",
    trace: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    transaction: "POST /api/internal/agent/continue",
    "gen_ai.operation.type": "ai_client",
    "gen_ai.input.messages": JSON.stringify([
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "What failed in production?" },
    ]),
    "gen_ai.output.messages": JSON.stringify([
      { role: "assistant", content: "The checkout worker is timing out." },
    ]),
    "gen_ai.system_instructions": "Respond with concise diagnostics.",
    "gen_ai.cost.total_tokens": 42,
    "gen_ai.request.model": "gpt-5-mini",
    "gen_ai.response.model": "gpt-5-mini-2026-05-01",
    "gen_ai.usage.total_tokens": 42,
    "gen_ai.agent.name": "triage-agent",
    "user.email": "dev@example.com",
  },
  {
    "gen_ai.conversation.id": "conv-123",
    parent_span: "1111111111111111",
    "precise.finish_ts": 1713805402,
    "precise.start_ts": 1713805401.7,
    project: "mcp-server",
    "project.id": 4509109107622913,
    "span.name": "gen_ai.execute_tool",
    "span.op": "gen_ai.execute_tool",
    "span.description": "search_events",
    "span.status": "ok",
    span_id: "2222222222222222",
    trace: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    transaction: "POST /api/internal/agent/continue",
    "gen_ai.operation.type": "tool",
    "gen_ai.tool.name": "search_events",
    "gen_ai.tool.call.arguments": JSON.stringify({
      query: "level:error",
    }),
    "gen_ai.tool.input": JSON.stringify({ organizationSlug: "test-org" }),
  },
  {
    "gen_ai.conversation.id": "conv-123",
    parent_span: null,
    "precise.finish_ts": 1713805405,
    "precise.start_ts": 1713805404,
    project: "mcp-server",
    "project.id": 4509109107622913,
    "span.name": "gen_ai.chat",
    "span.op": "gen_ai.chat",
    "span.description": "chat completion",
    "span.status": "ok",
    span_id: "3333333333333333",
    trace: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "gen_ai.operation.type": "ai_client",
    "gen_ai.input.messages": JSON.stringify([
      { role: "user", content: "Can you inspect the failing event?" },
    ]),
    "gen_ai.response.text": "I found the timeout stack trace.",
    "gen_ai.usage.total_tokens": 58,
  },
];

function mockConversationEndpoint(
  org = "test-org",
  conversationId = "conv-123",
  spans = conversationSpans,
  title: string | null = null,
) {
  mswServer.use(
    http.get(
      `https://sentry.io/api/0/organizations/${org}/agents/conversations/${conversationId}/`,
      ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("statsPeriod")).toBe("30d");
        expect(url.searchParams.get("per_page")).toBe("1000");
        expect(url.searchParams.get("project")).toBe("-1");
        return HttpResponse.json({ conversationId, title, spans });
      },
    ),
  );
}

describe("get_agent_conversation_details", () => {
  it("returns structured conversation details", async () => {
    mockConversationEndpoint(
      "test-org",
      "conv-123",
      conversationSpans,
      "Checkout worker timeouts",
    );

    const result = await getAIConversationDetails.handler(
      {
        organizationSlug: "test-org",
        conversationId: "conv-123",
      },
      baseContext,
    );

    assertStructuredOnlyResult(result);
    const structuredContent =
      getStructuredContent<ConversationDetailsForTest>(result);
    expect(structuredContent).not.toHaveProperty("focusedSpanId");
    expect(structuredContent).not.toHaveProperty("focusedSpanPresent");
    expect(structuredContent).not.toHaveProperty("messages");
    expect(structuredContent).not.toHaveProperty("spanIds");
    expect(structuredContent["title"]).toBe("Checkout worker timeouts");
    expect(structuredContent.timeline[0]?.genAi).toMatchObject({
      operationType: "ai_client",
      requestModel: "gpt-5-mini",
      responseModel: "gpt-5-mini-2026-05-01",
      usageTotalTokens: 42,
      costTotalTokens: 42,
      agentName: "triage-agent",
    });
    expect(structuredContent.timeline[2]?.genAi).toMatchObject({
      operationType: "tool",
    });
    expect(structuredContent.timeline[2]?.genAi).not.toHaveProperty("toolName");
    expect(structuredContent.timeline[2]?.genAi).not.toHaveProperty(
      "toolCallArguments",
    );
    expect(structuredContent.timeline[2]?.genAi).not.toHaveProperty(
      "toolInput",
    );
    expect(structuredContent.spanSummaries[0]).toMatchObject({
      spanId: "1111111111111111",
      spanOp: "gen_ai.chat",
      spanDescription: "chat completion",
      transaction: "POST /api/internal/agent/continue",
      genAi: expect.objectContaining({
        operationType: "ai_client",
        inputMessages: JSON.stringify([
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: "What failed in production?" },
        ]),
        outputMessages: JSON.stringify([
          {
            role: "assistant",
            content: "The checkout worker is timing out.",
          },
        ]),
      }),
    });
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "aiCallCount": 2,
        "conversationId": "conv-123",
        "endTimestamp": 1713805405000,
        "lookupWindow": {
          "statsPeriod": "30d",
        },
        "messageCount": 4,
        "organizationSlug": "test-org",
        "projects": [
          "mcp-server",
        ],
        "spanCount": 3,
        "spanSummaries": [
          {
            "durationMs": 1500,
            "genAi": {
              "agentName": "triage-agent",
              "costTotalTokens": 42,
              "inputMessages": "[{"role":"system","content":"You are a helpful assistant."},{"role":"user","content":"What failed in production?"}]",
              "operationType": "ai_client",
              "outputMessages": "[{"role":"assistant","content":"The checkout worker is timing out."}]",
              "requestModel": "gpt-5-mini",
              "responseModel": "gpt-5-mini-2026-05-01",
              "systemInstructions": "Respond with concise diagnostics.",
              "usageTotalTokens": 42,
            },
            "parentSpanId": null,
            "project": "mcp-server",
            "projectId": 4509109107622913,
            "spanDescription": "chat completion",
            "spanId": "1111111111111111",
            "spanName": "gen_ai.chat",
            "spanOp": "gen_ai.chat",
            "spanStatus": "ok",
            "timestamp": 1713805400000,
            "traceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "transaction": "POST /api/internal/agent/continue",
          },
          {
            "durationMs": 300,
            "genAi": {
              "operationType": "tool",
              "toolCallArguments": "{"query":"level:error"}",
              "toolInput": "{"organizationSlug":"test-org"}",
              "toolName": "search_events",
            },
            "parentSpanId": "1111111111111111",
            "project": "mcp-server",
            "projectId": 4509109107622913,
            "spanDescription": "search_events",
            "spanId": "2222222222222222",
            "spanName": "gen_ai.execute_tool",
            "spanOp": "gen_ai.execute_tool",
            "spanStatus": "ok",
            "timestamp": 1713805401700,
            "traceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "transaction": "POST /api/internal/agent/continue",
          },
          {
            "durationMs": 1000,
            "genAi": {
              "inputMessages": "[{"role":"user","content":"Can you inspect the failing event?"}]",
              "operationType": "ai_client",
              "responseText": "I found the timeout stack trace.",
              "usageTotalTokens": 58,
            },
            "parentSpanId": null,
            "project": "mcp-server",
            "projectId": 4509109107622913,
            "spanDescription": "chat completion",
            "spanId": "3333333333333333",
            "spanName": "gen_ai.chat",
            "spanOp": "gen_ai.chat",
            "spanStatus": "ok",
            "timestamp": 1713805404000,
            "traceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
        ],
        "startTimestamp": 1713805400000,
        "timeline": [
          {
            "content": "What failed in production?",
            "genAi": {
              "agentName": "triage-agent",
              "costTotalTokens": 42,
              "inputMessages": "[{"role":"system","content":"You are a helpful assistant."},{"role":"user","content":"What failed in production?"}]",
              "operationType": "ai_client",
              "outputMessages": "[{"role":"assistant","content":"The checkout worker is timing out."}]",
              "requestModel": "gpt-5-mini",
              "responseModel": "gpt-5-mini-2026-05-01",
              "systemInstructions": "Respond with concise diagnostics.",
              "usageTotalTokens": 42,
            },
            "role": "user",
            "spanId": "1111111111111111",
            "timestamp": 1713805400000,
            "traceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "type": "message",
            "userEmail": "dev@example.com",
          },
          {
            "content": "The checkout worker is timing out.",
            "genAi": {
              "agentName": "triage-agent",
              "costTotalTokens": 42,
              "inputMessages": "[{"role":"system","content":"You are a helpful assistant."},{"role":"user","content":"What failed in production?"}]",
              "operationType": "ai_client",
              "outputMessages": "[{"role":"assistant","content":"The checkout worker is timing out."}]",
              "requestModel": "gpt-5-mini",
              "responseModel": "gpt-5-mini-2026-05-01",
              "systemInstructions": "Respond with concise diagnostics.",
              "usageTotalTokens": 42,
            },
            "metadata": {
              "agentName": "triage-agent",
              "durationMs": 1500,
              "model": "gpt-5-mini-2026-05-01",
              "status": "ok",
              "totalTokens": 42,
            },
            "role": "assistant",
            "spanId": "1111111111111111",
            "timestamp": 1713805401500,
            "traceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "type": "message",
          },
          {
            "arguments": "{"query":"level:error"}",
            "durationMs": 300,
            "genAi": {
              "operationType": "tool",
            },
            "input": "{"organizationSlug":"test-org"}",
            "name": "search_events",
            "spanId": "2222222222222222",
            "status": "ok",
            "timestamp": 1713805401700,
            "traceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "type": "tool_call",
          },
          {
            "content": "Can you inspect the failing event?",
            "genAi": {
              "inputMessages": "[{"role":"user","content":"Can you inspect the failing event?"}]",
              "operationType": "ai_client",
              "responseText": "I found the timeout stack trace.",
              "usageTotalTokens": 58,
            },
            "role": "user",
            "spanId": "3333333333333333",
            "timestamp": 1713805404000,
            "traceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "type": "message",
          },
          {
            "content": "I found the timeout stack trace.",
            "genAi": {
              "inputMessages": "[{"role":"user","content":"Can you inspect the failing event?"}]",
              "operationType": "ai_client",
              "responseText": "I found the timeout stack trace.",
              "usageTotalTokens": 58,
            },
            "metadata": {
              "durationMs": 1000,
              "status": "ok",
              "totalTokens": 58,
            },
            "role": "assistant",
            "spanId": "3333333333333333",
            "timestamp": 1713805405000,
            "traceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "type": "message",
          },
        ],
        "title": "Checkout worker timeouts",
        "toolCallCount": 1,
        "totalTokens": 100,
        "traceIds": [
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ],
        "url": "https://test-org.sentry.io/explore/conversations/conv-123/",
      }
    `);
  });

  it("omits userEmail from user messages when span has no user.email or null user.email", async () => {
    const spansWithoutEmail = conversationSpans.map((span) => {
      const { "user.email": _userEmail, ...rest } = span;
      if ("user.email" in span) {
        return { ...rest, "user.email": null };
      }
      return rest;
    });
    mockConversationEndpoint("test-org", "conv-123", spansWithoutEmail);

    const result = await getAIConversationDetails.handler(
      {
        organizationSlug: "test-org",
        conversationId: "conv-123",
      },
      baseContext,
    );

    assertStructuredOnlyResult(result);
    const structuredContent = getStructuredContent<{
      timeline: Array<{ type: string; role?: string; userEmail?: string }>;
    }>(result);
    const userMessages = structuredContent.timeline.filter(
      (event) => event.type === "message" && event.role === "user",
    );
    expect(userMessages).toHaveLength(2);
    for (const message of userMessages) {
      expect(message).not.toHaveProperty("userEmail");
    }
  });

  it("truncates large GenAI message and tool payload attributes while preserving span IDs", async () => {
    const longValue = "x".repeat(4100);
    mockConversationEndpoint("test-org", "conv-large-attrs", [
      {
        ...conversationSpans[0],
        "gen_ai.conversation.id": "conv-large-attrs",
        span_id: "large-ai-1",
        "gen_ai.input.messages": longValue,
      },
      {
        ...conversationSpans[1],
        "gen_ai.conversation.id": "conv-large-attrs",
        span_id: "large-tool-1",
        "gen_ai.tool.call.arguments": longValue,
        "gen_ai.tool.input": longValue,
      },
    ]);

    const result = await getAIConversationDetails.handler(
      {
        organizationSlug: "test-org",
        conversationId: "conv-large-attrs",
      },
      baseContext,
    );

    const structuredContent =
      getStructuredContent<ConversationDetailsForTest>(result);
    expect(structuredContent.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "message",
          spanId: "large-ai-1",
          traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          genAi: expect.objectContaining({
            inputMessages: expect.stringMatching(/\.\.\. \[truncated\]$/),
            truncatedFields: ["inputMessages"],
          }),
        }),
        expect.objectContaining({
          type: "tool_call",
          spanId: "large-tool-1",
          traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          arguments: expect.stringMatching(/\.\.\. \[truncated\]$/),
          input: expect.stringMatching(/\.\.\. \[truncated\]$/),
          genAi: expect.objectContaining({
            operationType: "tool",
          }),
        }),
      ]),
    );
    expect(structuredContent.spanSummaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          spanId: "large-ai-1",
          traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          genAi: expect.objectContaining({
            inputMessages: expect.stringMatching(/\.\.\. \[truncated\]$/),
            truncatedFields: ["inputMessages"],
          }),
        }),
        expect.objectContaining({
          spanId: "large-tool-1",
          traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          genAi: expect.objectContaining({
            toolCallArguments: expect.stringMatching(/\.\.\. \[truncated\]$/),
            toolInput: expect.stringMatching(/\.\.\. \[truncated\]$/),
            truncatedFields: ["toolCallArguments", "toolInput"],
          }),
        }),
      ]),
    );
  });

  it("omits empty GenAI projections from span summaries", async () => {
    mockConversationEndpoint("test-org", "conv-no-gen-ai-attrs", [
      {
        "gen_ai.conversation.id": "conv-no-gen-ai-attrs",
        parent_span: null,
        "precise.finish_ts": 1713805401,
        "precise.start_ts": 1713805400,
        project: "mcp-server",
        "project.id": 4509109107622913,
        span_id: "no-gen-ai-attrs-1",
        trace: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    ]);

    const result = await getAIConversationDetails.handler(
      {
        organizationSlug: "test-org",
        conversationId: "conv-no-gen-ai-attrs",
      },
      baseContext,
    );

    const structuredContent =
      getStructuredContent<ConversationDetailsForTest>(result);
    expect(structuredContent.timeline).toEqual([]);
    expect(structuredContent.spanSummaries[0]).toMatchObject({
      spanId: "no-gen-ai-attrs-1",
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(structuredContent.spanSummaries[0]).not.toHaveProperty("genAi");
  });

  it("resolves an Explore conversation URL through get_sentry_resource", async () => {
    mockConversationEndpoint("sentry-mcp-evals");

    const result = await getSentryResource.handler(
      {
        url: "https://sentry-mcp-evals.sentry.io/explore/conversations/conv-123/",
      },
      baseContext,
    );

    assertStructuredOnlyResult(result);
    const structuredContent = getStructuredContent(result);
    expect(structuredContent["conversationId"]).toBe("conv-123");
    expect(structuredContent["timeline"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "message",
          role: "assistant",
          content: "The checkout worker is timing out.",
        }),
      ]),
    );
  });

  it("preserves scoped query parameters from conversation URLs", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/agents/conversations/conv-123/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("statsPeriod")).toBeNull();
          expect(url.searchParams.get("start")).toBe(
            "2026-05-23T00:23:27.667Z",
          );
          expect(url.searchParams.get("end")).toBe("2026-05-23T02:34:56.137Z");
          expect(url.searchParams.get("project")).toBe("4510944073809921");
          return HttpResponse.json({
            conversationId: "conv-123",
            title: null,
            spans: conversationSpans,
          });
        },
      ),
    );

    const result = await getSentryResource.handler(
      {
        url: "https://sentry-mcp-evals.sentry.io/explore/conversations/conv-123/?start=2026-05-23T00:23:27.667Z&end=2026-05-23T02:34:56.137Z&project=4510944073809921&spanId=1111111111111111",
      },
      baseContext,
    );

    const structuredContent = getStructuredContent(result);
    expect(structuredContent).toMatchObject({
      conversationId: "conv-123",
      aiCallCount: 2,
      traceIds: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    });
  });

  it("describes explicit lookup windows when no spans are found", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/agents/conversations/conv-empty/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("statsPeriod")).toBeNull();
          expect(url.searchParams.get("start")).toBe(
            "2026-05-23T00:23:27.667Z",
          );
          expect(url.searchParams.get("end")).toBe("2026-05-23T02:34:56.137Z");
          return HttpResponse.json({
            conversationId: "conv-empty",
            title: null,
            spans: [],
          });
        },
      ),
    );

    const result = await getAIConversationDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        conversationId: "conv-empty",
        start: "2026-05-23T00:23:27.667Z",
        end: "2026-05-23T02:34:56.137Z",
      },
      baseContext,
    );

    assertStructuredOnlyResult(result);
    expect(getStructuredContent(result)).toMatchObject({
      conversationId: "conv-empty",
      title: null,
      lookupWindow: {
        start: "2026-05-23T00:23:27.667Z",
        end: "2026-05-23T02:34:56.137Z",
      },
      startTimestamp: null,
      endTimestamp: null,
      spanCount: 0,
      aiCallCount: 0,
      messageCount: 0,
      toolCallCount: 0,
      timeline: [],
    });
  });

  it("rejects partial absolute time ranges", async () => {
    await expect(
      getAIConversationDetails.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          conversationId: "conv-123",
          start: "2026-05-23T00:23:27.667Z",
        },
        baseContext,
      ),
    ).rejects.toThrow("`start` and `end` must be provided together.");
  });

  it("preserves repeated messages and their distinct tool calls", async () => {
    mockConversationEndpoint("test-org", "conv-repeat", [
      {
        ...conversationSpans[0],
        "gen_ai.conversation.id": "conv-repeat",
        "precise.start_ts": 1713805400,
        "precise.finish_ts": 1713805401,
        span_id: "repeat-ai-1",
        "gen_ai.input.messages": JSON.stringify([
          { role: "user", content: "try again" },
        ]),
        "gen_ai.output.messages": JSON.stringify([
          { role: "assistant", content: "I will retry that." },
        ]),
      },
      {
        ...conversationSpans[1],
        "gen_ai.conversation.id": "conv-repeat",
        "precise.start_ts": 1713805402,
        "precise.finish_ts": 1713805403,
        span_id: "repeat-tool-1",
        "gen_ai.tool.name": "search_events",
      },
      {
        ...conversationSpans[0],
        "gen_ai.conversation.id": "conv-repeat",
        "precise.start_ts": 1713805404,
        "precise.finish_ts": 1713805405,
        span_id: "repeat-ai-2",
        "gen_ai.input.messages": JSON.stringify([
          { role: "user", content: "try again" },
        ]),
        "gen_ai.output.messages": JSON.stringify([
          { role: "assistant", content: "I will retry that." },
        ]),
      },
    ]);

    const result = await getAIConversationDetails.handler(
      {
        organizationSlug: "test-org",
        conversationId: "conv-repeat",
      },
      baseContext,
    );

    const structuredContent = getStructuredContent(result);
    expect(structuredContent["messageCount"]).toBe(4);
    expect(structuredContent["timeline"]).toMatchObject([
      { type: "message", role: "user", spanId: "repeat-ai-1" },
      { type: "message", role: "assistant", spanId: "repeat-ai-1" },
      { type: "tool_call", name: "search_events", spanId: "repeat-tool-1" },
      { type: "message", role: "user", spanId: "repeat-ai-2" },
      { type: "message", role: "assistant", spanId: "repeat-ai-2" },
    ]);
  });

  it("orders messages and tool calls by span timestamp", async () => {
    mockConversationEndpoint("test-org", "conv-out-of-order", [
      {
        ...conversationSpans[1],
        "gen_ai.conversation.id": "conv-out-of-order",
        "precise.start_ts": 1713805402,
        "precise.finish_ts": 1713805402.1,
        span_id: "tool-second",
        "gen_ai.tool.name": "get_issue_details",
      },
      {
        ...conversationSpans[0],
        "gen_ai.conversation.id": "conv-out-of-order",
        "precise.start_ts": 1713805404,
        "precise.finish_ts": 1713805405,
        span_id: "ai-second",
        "gen_ai.input.messages": JSON.stringify([
          { role: "user", content: "summarize the event" },
        ]),
      },
      {
        ...conversationSpans[1],
        "gen_ai.conversation.id": "conv-out-of-order",
        "precise.start_ts": 1713805401,
        "precise.finish_ts": 1713805401.1,
        span_id: "tool-first",
        "gen_ai.tool.name": "search_events",
      },
      {
        ...conversationSpans[0],
        "gen_ai.conversation.id": "conv-out-of-order",
        "precise.start_ts": 1713805400,
        "precise.finish_ts": 1713805400.5,
        span_id: "ai-first",
        "gen_ai.input.messages": JSON.stringify([
          { role: "user", content: "find the failing event" },
        ]),
      },
    ]);

    const result = await getAIConversationDetails.handler(
      {
        organizationSlug: "test-org",
        conversationId: "conv-out-of-order",
      },
      baseContext,
    );

    const structuredContent = getStructuredContent(result);
    expect(structuredContent["timeline"]).toMatchObject([
      {
        type: "message",
        role: "user",
        spanId: "ai-first",
        timestamp: 1713805400000,
      },
      {
        type: "message",
        role: "assistant",
        spanId: "ai-first",
        timestamp: 1713805400500,
      },
      {
        type: "tool_call",
        name: "search_events",
        spanId: "tool-first",
        timestamp: 1713805401000,
      },
      {
        type: "tool_call",
        name: "get_issue_details",
        spanId: "tool-second",
        timestamp: 1713805402000,
      },
      {
        type: "message",
        role: "user",
        spanId: "ai-second",
        timestamp: 1713805404000,
      },
      {
        type: "message",
        role: "assistant",
        spanId: "ai-second",
        timestamp: 1713805405000,
      },
    ]);
  });

  it("keeps tool calls chronological after the final AI client span", async () => {
    mockConversationEndpoint("test-org", "conv-final-tool", [
      {
        ...conversationSpans[0],
        "gen_ai.conversation.id": "conv-final-tool",
        "precise.start_ts": 1713805400,
        "precise.finish_ts": 1713805401,
        span_id: "final-ai-1",
        "gen_ai.input.messages": JSON.stringify([
          { role: "user", content: "check the latest event" },
        ]),
        "gen_ai.output.messages": JSON.stringify([
          { role: "assistant", content: "I will inspect that event." },
        ]),
      },
      {
        ...conversationSpans[1],
        "gen_ai.conversation.id": "conv-final-tool",
        "precise.start_ts": 1713805402,
        "precise.finish_ts": 1713805403,
        span_id: "final-tool-1",
        "gen_ai.tool.name": "get_issue_details",
      },
    ]);

    const result = await getAIConversationDetails.handler(
      {
        organizationSlug: "test-org",
        conversationId: "conv-final-tool",
      },
      baseContext,
    );

    const structuredContent = getStructuredContent(result);
    expect(structuredContent["toolCallCount"]).toBe(1);
    expect(structuredContent["timeline"]).toMatchObject([
      { type: "message", role: "user", spanId: "final-ai-1" },
      { type: "message", role: "assistant", spanId: "final-ai-1" },
      {
        type: "tool_call",
        name: "get_issue_details",
        spanId: "final-tool-1",
        status: "ok",
      },
    ]);
  });

  it("counts only tool calls included in the transcript", async () => {
    const unnamedToolSpan: Record<string, unknown> = {
      ...conversationSpans[1],
      "gen_ai.conversation.id": "conv-unnamed-tool",
      "precise.start_ts": 1713805402,
      "precise.finish_ts": 1713805403,
      span_id: "unnamed-tool-1",
      "gen_ai.tool.name": undefined,
    };

    mockConversationEndpoint("test-org", "conv-unnamed-tool", [
      {
        ...conversationSpans[0],
        "gen_ai.conversation.id": "conv-unnamed-tool",
        "precise.start_ts": 1713805400,
        "precise.finish_ts": 1713805401,
        span_id: "unnamed-ai-1",
      },
      unnamedToolSpan,
    ]);

    const result = await getAIConversationDetails.handler(
      {
        organizationSlug: "test-org",
        conversationId: "conv-unnamed-tool",
      },
      baseContext,
    );

    const structuredContent = getStructuredContent(result);
    expect(structuredContent["toolCallCount"]).toBe(0);
    expect(structuredContent["timeline"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "message", spanId: "unnamed-ai-1" }),
      ]),
    );
    expect(structuredContent["timeline"]).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_call",
          spanId: "unnamed-tool-1",
        }),
      ]),
    );
  });
});
