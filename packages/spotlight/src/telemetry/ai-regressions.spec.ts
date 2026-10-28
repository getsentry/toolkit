import { expect, test } from "vitest";
import { createTelemetryStore } from "../sdk/core.ts";

function span(
  id: string,
  data: Record<string, unknown> = {},
  parent = "transaction",
  op = "gen_ai.chat",
) {
  return {
    trace_id: "ai-trace",
    span_id: id,
    parent_span_id: parent,
    op,
    start_timestamp: 1,
    timestamp: 2,
    data,
  };
}

async function ingestSpans(
  store: ReturnType<typeof createTelemetryStore>,
  spans: ReturnType<typeof span>[],
) {
  const result = await store.ingestEnvelope([
    {},
    [
      [
        { type: "transaction" },
        {
          type: "transaction",
          event_id: "transaction-event",
          transaction: "AI request",
          start_timestamp: 1,
          timestamp: 2,
          contexts: {
            trace: {
              trace_id: "ai-trace",
              span_id: "transaction",
              op: "http.server",
            },
          },
          spans,
        },
      ],
    ],
  ]);
  expect(result.status).toBe("processed");
}

const calls = [
  { toolCallId: "weather-call", toolName: "weather", args: { city: "Pune" } },
];

test.each([
  { value: '["stop"]', expected: "stop" },
  { value: '["stop","length"]', expected: "stop" },
  { value: ["length"], expected: "length" },
  { value: "stop", expected: "stop" },
  { value: "[]", expected: undefined },
  { value: [], expected: undefined },
  { value: '["stop"', expected: undefined },
  { value: "null", expected: undefined },
  { value: [null], expected: undefined },
  { value: " ", expected: undefined },
])("AI queries normalize finish reason $value", async ({ value, expected }) => {
  const store = createTelemetryStore();
  try {
    await ingestSpans(store, [
      span("root", {
        "gen_ai.response.finish_reasons": value,
        "gen_ai.response.text": "Available response",
      }),
    ]);
    expect(store.getAITraces()[0]?.response).toMatchObject({
      text: "Available response",
    });
    expect(store.getAITraces()[0]?.response?.finishReason).toBe(expected);
  } finally {
    store.dispose();
  }
});

test.each([
  { value: '["stop"]', expected: "stop" },
  { value: ["length"], expected: "length" },
  { value: "stop", expected: "stop" },
  { value: "[]", expected: undefined },
  { value: [], expected: undefined },
  { value: '["stop"', expected: undefined },
  { value: "null", expected: undefined },
  { value: [null], expected: undefined },
  { value: " ", expected: undefined },
])(
  "Vercel AI queries normalize finish reason $value",
  async ({ value, expected }) => {
    const store = createTelemetryStore();
    try {
      await ingestSpans(store, [
        span("root", {
          "vercel.ai.operationId": "ai.generateText",
          "gen_ai.response.finish_reasons": value,
          "gen_ai.response.text": "Available response",
        }),
      ]);
      expect(store.getAITraces()[0]?.response?.text).toBe("Available response");
      expect(store.getAITraces()[0]?.response?.finishReason).toBe(expected);
    } finally {
      store.dispose();
    }
  },
);

test("Vercel AI queries prioritize the legacy singular finish reason", async () => {
  const store = createTelemetryStore();
  try {
    await ingestSpans(store, [
      span("root", {
        "vercel.ai.response.finishReason": "tool-calls",
        "gen_ai.response.finish_reasons": '["stop"]',
      }),
    ]);
    expect(store.getAITraces()[0]?.response?.finishReason).toBe("tool-calls");
  } finally {
    store.dispose();
  }
});

test.each([undefined, 30])(
  "AI queries keep token subtotals finite when child sums overflow, root=%j",
  async (rootTokens) => {
    const store = createTelemetryStore();
    try {
      await ingestSpans(store, [
        span("root", {
          "vercel.ai.operationId": "ai.generateText",
          "gen_ai.usage.input_tokens": rootTokens,
        }),
        span(
          "first",
          {
            "gen_ai.usage.input_tokens": 1e308,
            "gen_ai.usage.output_tokens": 2,
          },
          "root",
        ),
        span(
          "second",
          {
            "gen_ai.usage.input_tokens": 1e308,
            "gen_ai.usage.output_tokens": 3,
          },
          "root",
        ),
      ]);
      expect(store.getAITraces()[0]?.promptTokens).toBe(rootTokens);
      expect(store.getAITraces()[0]?.metadata.promptTokens).toBe(rootTokens);
      expect(store.getAITraces()[0]?.completionTokens).toBe(5);
    } finally {
      store.dispose();
    }
  },
);

test.each([
  {
    field: "vercel.ai.operationId",
    operation: "ai.generateText",
    tool: "ai.toolCall",
  },
  { field: "operation.name", operation: "ai.streamText", tool: "ai.toolCall" },
  {
    field: "gen_ai.operation.name",
    operation: "invoke_agent",
    tool: "execute_tool",
  },
])(
  "AI queries retain root identity with $field tool descendants",
  async ({ field, operation, tool }) => {
    const store = createTelemetryStore();
    try {
      await ingestSpans(store, [
        {
          ...span(
            "root",
            { [field]: operation, "vercel.ai.model.id": "model" },
            "transaction",
            "gen_ai.invoke_agent",
          ),
          description: "Plan itinerary",
        },
        span("model", { "gen_ai.request.model": "model" }, "root"),
        span(
          "tool",
          { [field]: tool, "gen_ai.tool.name": "weather" },
          "model",
          "gen_ai.execute_tool",
        ),
      ]);
      expect(store.getAITraces()).toHaveLength(1);
      expect(store.getAITraces()[0]).toMatchObject({
        operation,
        name: "Plan itinerary",
        hasToolCall: true,
      });
    } finally {
      store.dispose();
    }
  },
);

test("AI queries name a Vercel tool root from its own tool name", async () => {
  const store = createTelemetryStore();
  try {
    await ingestSpans(store, [
      span(
        "root",
        {
          "vercel.ai.operationId": "ai.toolCall",
          "gen_ai.tool.name": "weather",
        },
        "transaction",
        "gen_ai.execute_tool",
      ),
    ]);
    expect(store.getAITraces()[0]).toMatchObject({
      operation: "ai.toolCall",
      name: "weather",
      hasToolCall: true,
    });
  } finally {
    store.dispose();
  }
});

test.each([
  {
    label: "modern aggregate",
    root: { "gen_ai.usage.input_tokens": 30, "gen_ai.usage.output_tokens": 7 },
    expectedInput: 30,
    expectedOutput: 7,
  },
  {
    label: "zero root with observed model usage",
    root: { "gen_ai.usage.input_tokens": 0, "gen_ai.usage.output_tokens": 0 },
    expectedInput: 30,
    expectedOutput: 7,
  },
  {
    label: "normalized legacy last-step root",
    root: { "gen_ai.usage.input_tokens": 20, "gen_ai.usage.output_tokens": 5 },
    expectedInput: 30,
    expectedOutput: 7,
  },
  {
    label: "aggregate with partial child coverage",
    root: {
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 80,
    },
    expectedInput: 100,
    expectedOutput: 80,
  },
  {
    label: "legacy last-step root",
    root: {
      "vercel.ai.usage.promptTokens": 20,
      "vercel.ai.usage.completionTokens": 5,
    },
    expectedInput: 30,
    expectedOutput: 7,
  },
  {
    label: "missing root usage",
    root: {},
    expectedInput: 30,
    expectedOutput: 7,
  },
  {
    label: "malformed root usage",
    root: {
      "gen_ai.usage.input_tokens": "bad",
      "gen_ai.usage.output_tokens": null,
    },
    expectedInput: 30,
    expectedOutput: 7,
  },
])(
  "AI queries count Vercel multi-step usage with $label",
  async ({ root, expectedInput, expectedOutput }) => {
    const store = createTelemetryStore();
    try {
      await ingestSpans(store, [
        span(
          "root",
          { "vercel.ai.operationId": "ai.generateText", ...root },
          "transaction",
          "gen_ai.invoke_agent",
        ),
        span(
          "wrapper",
          {
            "vercel.ai.operationId": "ai.generateText",
            "vercel.ai.usage.promptTokens": 20,
            "vercel.ai.usage.completionTokens": 5,
          },
          "root",
          "gen_ai.invoke_agent",
        ),
        span(
          "first-model",
          {
            "vercel.ai.operationId": "ai.generateText.doGenerate",
            "gen_ai.usage.input_tokens": 10,
            "gen_ai.usage.output_tokens": 2,
          },
          "wrapper",
          "gen_ai.generate_text",
        ),
        span(
          "second-model",
          {
            "operation.name": "ai.generateText.doGenerate",
            "vercel.ai.usage.promptTokens": "20",
            "vercel.ai.usage.completionTokens": "5",
          },
          "wrapper",
          "gen_ai.generate_text",
        ),
        span(
          "invalid-model",
          {
            "vercel.ai.operationId": "ai.generateText.doGenerate",
            "gen_ai.usage.input_tokens": "NaN",
            "gen_ai.usage.output_tokens": false,
          },
          "wrapper",
          "gen_ai.generate_text",
        ),
      ]);
      expect(store.getAITraces()[0]).toMatchObject({
        promptTokens: expectedInput,
        completionTokens: expectedOutput,
        tokensDisplay: `${expectedInput} / ${expectedOutput}`,
        metadata: {
          promptTokens: expectedInput,
          completionTokens: expectedOutput,
        },
      });
    } finally {
      store.dispose();
    }
  },
);

test("AI queries retain zero model usage and omit malformed Vercel token counts", async () => {
  const store = createTelemetryStore();
  try {
    await ingestSpans(store, [
      span("root", {
        "vercel.ai.operationId": "ai.generateText",
        "gen_ai.usage.input_tokens": 0,
        "gen_ai.usage.output_tokens": "Infinity",
      }),
    ]);
    expect(store.getAITraces()[0]).toMatchObject({
      promptTokens: 0,
      tokensDisplay: "0 / ?",
      metadata: { promptTokens: 0 },
    });
    expect(store.getAITraces()[0]?.completionTokens).toBeUndefined();
    expect(store.getAITraces()[0]?.metadata.completionTokens).toBeUndefined();
  } finally {
    store.dispose();
  }
});

test.each(["generic", "vercel"])(
  "AI queries preserve descendant response order and shallowest %s roots",
  async (provider) => {
    const store = createTelemetryStore();
    try {
      await ingestSpans(store, [
        span(
          "root",
          provider === "generic"
            ? { "gen_ai.request.model": "root-model" }
            : { "vercel.ai.model.id": "root-model" },
        ),
        span("first", { "gen_ai.response.text": "first" }, "root"),
        span("nested", { "gen_ai.response.text": "nested" }, "first"),
        span("second", { "gen_ai.response.text": "second" }, "root"),
        span(
          "separate",
          provider === "generic"
            ? { "gen_ai.request.model": "separate-model" }
            : { "vercel.ai.model.id": "separate-model" },
        ),
      ]);
      const traces = store.getAITraces();
      expect(traces.map((trace) => trace.id)).toEqual(["root", "separate"]);
      expect(traces[0]?.response?.text).toBe("second");
      expect(traces[0]?.metadata.modelId).toBe("root-model");
    } finally {
      store.dispose();
    }
  },
);

test.each(["[{", "not JSON", "null", "{}", "3", '"text"', {}, 3, true])(
  "AI queries retain other response data when Vercel tool calls are malformed: %j",
  async (toolCalls) => {
    const store = createTelemetryStore();
    try {
      await ingestSpans(store, [
        span("root", {
          "vercel.ai.operationId": "ai.generateText",
          "vercel.ai.response.toolCalls": JSON.stringify(calls),
        }),
        span(
          "malformed",
          {
            "vercel.ai.response.toolCalls": toolCalls,
            "gen_ai.response.text": "Still available",
            "vercel.ai.response.finishReason": "stop",
          },
          "root",
        ),
        span("sibling", {
          "vercel.ai.operationId": "ai.generateText",
          "vercel.ai.model.id": "sibling-model",
        }),
      ]);
      const traces = store.getAITraces();
      expect(traces).toHaveLength(2);
      expect(traces.find((trace) => trace.id === "root")?.response).toEqual({
        toolCalls: calls,
        text: "Still available",
        finishReason: "stop",
      });
      expect(
        traces.find((trace) => trace.id === "sibling")?.metadata.modelId,
      ).toBe("sibling-model");
    } finally {
      store.dispose();
    }
  },
);

test("AI queries accept structured Vercel response tool-call arrays", async () => {
  const store = createTelemetryStore();
  try {
    await ingestSpans(store, [
      span("root", {
        "vercel.ai.response.toolCalls": calls,
      }),
    ]);
    expect(store.getAITraces()[0]?.response?.toolCalls).toEqual(calls);
  } finally {
    store.dispose();
  }
});

test.each([0, "0"])(
  "AI queries preserve explicit zero retry and step settings: %j",
  async (zero) => {
    const store = createTelemetryStore();
    try {
      await ingestSpans(store, [
        span("root", {
          "vercel.ai.settings.maxRetries": zero,
          "vercel.ai.settings.maxSteps": zero,
        }),
      ]);
      expect(store.getAITraces()[0]?.metadata).toMatchObject({
        maxRetries: 0,
        maxSteps: 0,
      });
    } finally {
      store.dispose();
    }
  },
);

test.each(
  [null, "", " ", false, true, [], {}, "invalid", "Infinity"].map((value) => ({
    value,
  })),
)(
  "AI queries ignore malformed retry and step settings: $value",
  async ({ value }) => {
    const store = createTelemetryStore();
    try {
      await ingestSpans(store, [
        span("root", {
          "vercel.ai.settings.maxRetries": 2,
          "vercel.ai.settings.maxSteps": "3",
        }),
        span(
          "child",
          {
            "vercel.ai.settings.maxRetries": value,
            "vercel.ai.settings.maxSteps": value,
          },
          "root",
        ),
      ]);
      expect(store.getAITraces()[0]?.metadata).toMatchObject({
        maxRetries: 2,
        maxSteps: 3,
      });
    } finally {
      store.dispose();
    }
  },
);

test.each([
  { provider: "generic", aiAtRoot: true },
  { provider: "generic", aiAtRoot: false },
  { provider: "vercel", aiAtRoot: true },
  { provider: "vercel", aiAtRoot: false },
])(
  "AI queries traverse deep $provider trees with aiAtRoot=$aiAtRoot",
  async ({ provider, aiAtRoot }) => {
    const store = createTelemetryStore();
    try {
      const spans = Array.from({ length: 12000 }, (_, index) => {
        const ai = aiAtRoot ? index === 0 : index === 11999;
        return span(
          `span-${index}`,
          ai
            ? provider === "generic"
              ? { "gen_ai.request.model": "deep-model" }
              : { "vercel.ai.model.id": "deep-model" }
            : {},
          index === 0 ? "transaction" : `span-${index - 1}`,
          ai ? "gen_ai.chat" : "function",
        );
      });
      await ingestSpans(store, spans);
      const traces = store.getAITraces();
      expect(traces).toHaveLength(1);
      expect(traces[0]).toMatchObject({
        id: aiAtRoot ? "span-0" : "span-11999",
        metadata: { modelId: "deep-model" },
      });
    } finally {
      store.dispose();
    }
  },
);
