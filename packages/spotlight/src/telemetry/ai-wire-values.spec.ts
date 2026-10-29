import { expect, test } from "vitest";
import { createTelemetryStore } from "../sdk/core.ts";

function span(
  id: string,
  data: Record<string, unknown>,
  parent = "transaction",
) {
  return {
    trace_id: "ai-wire-trace",
    span_id: id,
    parent_span_id: parent,
    op: "gen_ai.chat",
    start_timestamp: 1,
    timestamp: 2,
    data,
  };
}

async function queryTrace(spans: ReturnType<typeof span>[]) {
  const store = createTelemetryStore();
  try {
    const result = await store.ingestEnvelope([
      {},
      [
        [
          { type: "transaction" },
          {
            type: "transaction",
            event_id: "ai-wire-event",
            transaction: "AI request",
            start_timestamp: 1,
            timestamp: 2,
            contexts: {
              trace: {
                trace_id: "ai-wire-trace",
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
    const traces = store.getAITraces();
    expect(traces).toHaveLength(1);
    return traces[0];
  } finally {
    store.dispose();
  }
}

const calls = [
  { toolCallId: "weather-call", toolName: "weather", args: { city: "Pune" } },
];

test.each(["null", "{}", "not JSON"])(
  "Vercel AI queries preserve a same-span wrapper after malformed request messages: %s",
  async (invalid) => {
    for (const wrapper of [
      {
        messages: [{ role: "user", content: "Usable conversation" }],
        system: "Be concise",
      },
      { prompt: "Usable conversation", system: "Be concise" },
    ]) {
      const trace = await queryTrace([
        span("root", {
          "vercel.ai.operationId": "ai.generateText",
          "vercel.ai.prompt": JSON.stringify(wrapper),
          "gen_ai.request.messages": invalid,
        }),
      ]);
      expect(trace?.prompt).toEqual({
        messages: [{ role: "user", content: "Usable conversation" }],
        system: "Be concise",
      });
    }
  },
);

test.each(["null", "{}", "not JSON"])(
  "Vercel AI queries allow a valid conversation after malformed request messages: %s",
  async (invalid) => {
    const trace = await queryTrace([
      span("root", {
        "vercel.ai.operationId": "ai.generateText",
        "vercel.ai.prompt": JSON.stringify({
          prompt: "Fallback",
          system: "Be concise",
        }),
      }),
      span("invalid", { "gen_ai.request.messages": invalid }, "root"),
      span(
        "valid",
        {
          "gen_ai.request.messages": JSON.stringify([
            { role: "user", content: "Structured" },
          ]),
        },
        "root",
      ),
    ]);
    expect(trace?.prompt).toEqual({
      messages: [{ role: "user", content: "Structured" }],
      system: "Be concise",
    });
  },
);
const invalidCalls = ["null", "{}", "3", '"text"', "true", "[", 3, {}, null];

test.each(invalidCalls.map((invalid) => ({ invalid })))(
  "GenAI queries omit non-array response tool calls: $invalid",
  async ({ invalid }) => {
    const trace = await queryTrace([
      span("root", { "gen_ai.response.tool_calls": invalid }),
    ]);
    expect(trace?.response?.toolCalls).toBeUndefined();
  },
);

test.each(invalidCalls.map((invalid) => ({ invalid })))(
  "GenAI queries preserve valid response tool calls after a malformed later turn: $invalid",
  async ({ invalid }) => {
    const trace = await queryTrace([
      span("root", { "gen_ai.response.tool_calls": JSON.stringify(calls) }),
      span("later", { "gen_ai.response.tool_calls": invalid }, "root"),
    ]);
    expect(trace?.response?.toolCalls).toEqual(calls);
  },
);

test.each(
  [calls, JSON.stringify(calls), []].map((toolCalls) => ({ toolCalls })),
)(
  "GenAI queries accept array response tool calls: $toolCalls",
  async ({ toolCalls }) => {
    const trace = await queryTrace([
      span("root", { "gen_ai.response.tool_calls": toolCalls }),
    ]);
    expect(trace?.response?.toolCalls).toEqual(
      typeof toolCalls === "string" ? calls : toolCalls,
    );
  },
);

test.each(["gen_ai.prompt", "vercel.ai.prompt"])(
  "Vercel AI queries prefer structured request messages over %s",
  async (field) => {
    const trace = await queryTrace([
      span("root", {
        "vercel.ai.operationId": "ai.generateText",
        [field]: JSON.stringify({ prompt: "fallback", system: "Be concise" }),
        "gen_ai.request.messages": JSON.stringify([
          { role: "user", content: [{ type: "text", text: "Structured" }] },
        ]),
      }),
    ]);
    expect(trace?.prompt).toEqual({
      messages: [{ role: "user", content: "Structured" }],
      system: "Be concise",
    });
  },
);

test.each(["gen_ai.prompt", "vercel.ai.prompt"])(
  "Vercel AI queries normalize the text prompt in %s",
  async (field) => {
    const trace = await queryTrace([
      span("root", {
        "vercel.ai.operationId": "ai.generateText",
        [field]: JSON.stringify({
          prompt: "Fallback text",
          system: "Be concise",
        }),
      }),
    ]);
    expect(trace?.prompt).toEqual({
      messages: [{ role: "user", content: "Fallback text" }],
      system: "Be concise",
    });
  },
);

test("Vercel AI queries prefer a child's structured messages over the root fallback", async () => {
  const trace = await queryTrace([
    span("root", {
      "vercel.ai.operationId": "ai.generateText",
      "vercel.ai.prompt": JSON.stringify({
        prompt: "fallback",
        system: "Be concise",
      }),
    }),
    span(
      "first-turn",
      {
        "gen_ai.request.messages": JSON.stringify([
          { role: "user", content: "Initial conversation" },
        ]),
      },
      "root",
    ),
  ]);
  expect(trace?.prompt).toEqual({
    messages: [{ role: "user", content: "Initial conversation" }],
    system: "Be concise",
  });
});

test("Vercel AI queries keep the first explicit request messages across child turns", async () => {
  const trace = await queryTrace([
    span("root", {
      "vercel.ai.operationId": "ai.generateText",
      "vercel.ai.prompt": JSON.stringify({
        prompt: "fallback",
        system: "Be concise",
      }),
    }),
    span(
      "first-turn",
      {
        "gen_ai.request.messages": JSON.stringify([
          { role: "user", content: "Initial conversation" },
        ]),
      },
      "root",
    ),
    span(
      "later-turn",
      {
        "gen_ai.request.messages": JSON.stringify([
          { role: "user", content: "Later conversation" },
        ]),
      },
      "root",
    ),
  ]);
  expect(trace?.prompt).toEqual({
    messages: [{ role: "user", content: "Initial conversation" }],
    system: "Be concise",
  });
});

test.each([
  {
    prompt: "Raw fallback",
    expected: { messages: [{ role: "unknown", content: "Raw fallback" }] },
  },
  {
    prompt: JSON.stringify({
      messages: [
        { role: "user", content: [{ type: "text", text: "Fallback" }] },
      ],
      system: "Be concise",
    }),
    expected: {
      messages: [{ role: "user", content: "Fallback" }],
      system: "Be concise",
    },
  },
  {
    prompt: JSON.stringify({ system: "Be concise" }),
    expected: { system: "Be concise" },
  },
  {
    prompt: JSON.stringify({
      messages: null,
      prompt: "Fallback text",
      system: "Be concise",
    }),
    expected: {
      messages: [{ role: "user", content: "Fallback text" }],
      system: "Be concise",
    },
  },
])(
  "Vercel AI queries preserve fallback prompts: $prompt",
  async ({ prompt, expected }) => {
    const trace = await queryTrace([
      span("root", {
        "vercel.ai.operationId": "ai.generateText",
        "vercel.ai.prompt": prompt,
      }),
    ]);
    expect(trace?.prompt).toEqual(expected);
  },
);

test("Vercel AI queries retain token usage on leaf spans without children", async () => {
  const trace = await queryTrace([
    span("leaf", {
      "vercel.ai.operationId": "ai.generateText",
      "gen_ai.usage.input_tokens": 12,
      "gen_ai.usage.output_tokens": 3,
    }),
  ]);
  expect(trace).toMatchObject({
    promptTokens: 12,
    completionTokens: 3,
    tokensDisplay: "12 / 3",
  });
});
