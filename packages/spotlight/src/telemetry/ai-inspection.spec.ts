import { expect, test } from "vitest";
import { inspectAI } from "../sdk/core.ts";

const messages = [
  {
    role: "user",
    content: [
      { type: "text", text: "Describe the image" },
      { type: "image", image: "https://example.com/image.png" },
    ],
    tool_calls: [{ id: "call", function: { name: "image", arguments: "{}" } }],
  },
];

test.each(["gen_ai.prompt", "vercel.ai.prompt", "ai.prompt"])(
  "AI inspection exposes system instructions in object and JSON %s wrappers",
  (field) => {
    const wrapper = { system: "Be concise", messages };
    for (const value of [wrapper, JSON.stringify(wrapper)]) {
      const payload = { data: { [field]: value } };
      const before = structuredClone(payload);
      expect(inspectAI(payload)).toMatchObject({
        system: "Be concise",
        messages: wrapper,
      });
      expect(payload).toEqual(before);
      expect(
        inspectAI({
          data: {
            [field]: value,
            "gen_ai.request.messages": messages,
            "gen_ai.system_instructions": "Explicit instructions",
          },
        }),
      ).toMatchObject({ system: "Explicit instructions", messages });
    }
  },
);

test.each([
  "gen_ai.input.messages",
  "vercel.ai.prompt.messages",
  "vercel.ai.prompt",
  "gen_ai.prompt",
  "ai.prompt.messages",
  "ai.prompt",
])(
  "AI inspection selects a usable %s after malformed request messages without normalizing content",
  (field) => {
    const fallback = field.endsWith(".messages")
      ? messages
      : { system: "Nested instructions", messages };
    for (const invalid of ["null", {}, "not JSON", [null]]) {
      const payload = {
        attributes: {
          "gen_ai.request.messages": { value: invalid },
          [field]: { value: JSON.stringify(fallback) },
        },
      };
      const before = structuredClone(payload);
      expect(inspectAI(payload)?.messages).toEqual(fallback);
      expect(payload).toEqual(before);
    }
  },
);

test.each([
  { value: "null", expected: null },
  { value: "{}", expected: {} },
  { value: "not JSON", expected: "not JSON" },
  { value: [{ content: "No role" }], expected: [{ content: "No role" }] },
])(
  "AI inspection retains the first raw malformed prompt when no usable conversation exists: $value",
  ({ value, expected }) => {
    expect(
      inspectAI({
        data: {
          "gen_ai.request.messages": value,
          "gen_ai.prompt": { unexpected: "retained" },
        },
      })?.messages,
    ).toEqual(expected);
  },
);

test("AI inspection preserves explicit structured message precedence and nested system fallback", () => {
  expect(
    inspectAI({
      data: {
        "gen_ai.request.messages": messages,
        "vercel.ai.prompt": { system: "Nested instructions", messages: [] },
      },
    }),
  ).toMatchObject({ messages, system: "Nested instructions" });
});

test.each(["vercel.ai.response.toolCalls", "ai.response.toolCalls"])(
  "AI inspection prefers usable %s after malformed standard tool calls",
  (field) => {
    const calls = [
      { id: "call", name: "weather", arguments: { city: "Pune" } },
    ];
    for (const invalid of ["null", {}, "not JSON"]) {
      expect(
        inspectAI({
          data: {
            "gen_ai.response.tool_calls": invalid,
            [field]: JSON.stringify(calls),
          },
        })?.tools,
      ).toEqual(calls);
    }
  },
);

test("AI inspection keeps raw tool calls when no array alias is captured", () => {
  expect(
    inspectAI({ data: { "gen_ai.response.tool_calls": "not JSON" } })?.tools,
  ).toEqual(["not JSON"]);
});
