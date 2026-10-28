import { expect, test } from "vitest";
import {
  buildProfileModel,
  groupWebVitalPages,
  inspectAI,
  readSpanData,
} from "../sdk/core.ts";

test("profile model calculates intervals independently per thread and preserves leaf/self counts", () => {
  const payload = {
    profile: {
      frames: [
        { function: "main", filename: "app.ts", in_app: true },
        { function: "query" },
      ],
      stacks: [[1, 0], [0]],
      samples: [
        { thread_id: "main", stack_id: 0, elapsed_since_start_ns: "0" },
        { thread_id: "worker", stack_id: 1, elapsed_since_start_ns: "0" },
        { thread_id: "main", stack_id: 1, elapsed_since_start_ns: "10000000" },
        {
          thread_id: "worker",
          stack_id: 1,
          elapsed_since_start_ns: "90000000",
        },
      ],
      thread_metadata: { main: { name: "UI thread" } },
    },
  };
  const before = structuredClone(payload);
  const model = buildProfileModel(payload, "main");
  expect(model.durationMs).toBe(10);
  expect(model.sampleCount).toBe(2);
  expect(model.root.children[0]).toMatchObject({
    name: "main",
    samples: 2,
    selfSamples: 1,
    children: [{ name: "query", selfMs: 10 }],
  });
  expect(buildProfileModel(payload, "worker").durationMs).toBe(90);
  expect(buildProfileModel(payload, "missing").threadId).toBe("main");
  expect(payload).toEqual(before);
});

test("AI inspection reads typed span-v2 aliases, zero token counts, JSON messages and tool execution", () => {
  const payload = {
    attributes: {
      "sentry.op": { type: "string", value: "gen_ai.execute_tool" },
      "gen_ai.request.model": { type: "string", value: "test-model" },
      "gen_ai.usage.input_tokens": { type: "integer", value: 0 },
      "gen_ai.request.messages": {
        type: "string",
        value: '[{"role":"user","content":"Hello"}]',
      },
      "gen_ai.tool.name": { type: "string", value: "weather" },
      "gen_ai.tool.input": { type: "string", value: '{"city":"Pune"}' },
      "gen_ai.tool.output": { type: "string", value: '{"temperature":28}' },
    },
  };
  expect(inspectAI(payload)).toMatchObject({
    fields: { model: "test-model", inputTokens: 0 },
    messages: [{ role: "user", content: "Hello" }],
    tools: [
      {
        name: "weather",
        arguments: { city: "Pune" },
        result: { temperature: 28 },
      },
    ],
  });
  expect(
    inspectAI({ op: "db.query", data: { sql: "select 1" } }),
  ).toBeUndefined();
  expect(
    readSpanData({ data: { custom: "retained" }, ...payload }).custom,
  ).toBe("retained");
});

test("Web Vitals preserve absent metrics, explicit seconds, zero values and separate visits", () => {
  const pages = groupWebVitalPages([
    {
      id: "one",
      transaction: "/orders",
      measurements: { lcp: { value: 3.2, unit: "second" }, cls: { value: 0 } },
    },
    {
      id: "two",
      transaction: "/orders",
      measurements: { inp: { value: 700 }, fcp: { value: -1 } },
    },
    {
      id: "invalid",
      transaction: "/unknown",
      measurements: { lcp: { value: "200" } },
    },
  ]);
  expect(pages).toHaveLength(1);
  expect(pages[0]?.visits).toEqual([
    {
      eventId: "one",
      metrics: {
        lcp: { value: 3200, rating: "Needs improvement" },
        cls: { value: 0, rating: "Good" },
      },
    },
    { eventId: "two", metrics: { inp: { value: 700, rating: "Poor" } } },
  ]);
});
