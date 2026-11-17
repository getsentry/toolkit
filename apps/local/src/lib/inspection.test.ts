import { expect, test } from "vitest";
import { inspectAi } from "./inspection.ts";

const messages = [
  {
    role: "user",
    content: [{ type: "image", image: "captured-image" }],
    unknown: { retained: true },
  },
];

test.each(["null", {}, "not JSON", [null]])(
  "AI inspection finds usable aliases after malformed captured content: %j",
  (invalid) => {
    const payload = {
      data: {
        "gen_ai.request.messages": invalid,
        "vercel.ai.prompt": JSON.stringify({ system: "Be concise", messages }),
        "gen_ai.response.tool_calls": invalid,
        "ai.response.toolCalls": JSON.stringify([
          { name: "weather", arguments: { city: "Pune" } },
        ]),
      },
    };
    const before = structuredClone(payload);
    expect(inspectAi(payload)).toMatchObject({
      system: "Be concise",
      messages: { system: "Be concise", messages },
      tools: [{ name: "weather", arguments: { city: "Pune" } }],
    });
    expect(payload).toEqual(before);
  },
);

test("AI inspection retains explicit message/system precedence and raw malformed fallback", () => {
  expect(
    inspectAi({
      data: {
        "gen_ai.request.messages": messages,
        "gen_ai.system_instructions": "Explicit",
        "ai.prompt": { system: "Wrapped", messages: [] },
      },
    }),
  ).toMatchObject({ messages, system: "Explicit" });
  expect(
    inspectAi({
      data: {
        "gen_ai.request.messages": "not JSON",
        "gen_ai.response.tool_calls": "raw calls",
      },
    }),
  ).toMatchObject({ messages: "not JSON", tools: ["raw calls"] });
});

test("empty standard AI content falls back to populated captured aliases", () => {
  const calls = [{ name: "lookup", unknown: { retained: true } }];
  expect(
    inspectAi({
      data: {
        "gen_ai.request.messages": [],
        "ai.prompt.messages": messages,
        "gen_ai.response.text": "",
        "vercel.ai.response.text": "Captured answer",
        "gen_ai.response.tool_calls": [],
        "ai.response.toolCalls": calls,
      },
    }),
  ).toMatchObject({ messages, response: "Captured answer", tools: calls });
});

test("meaningful standard content keeps precedence over populated aliases", () => {
  const calls = [{ name: "standard" }];
  expect(
    inspectAi({
      data: {
        "gen_ai.request.messages": messages,
        "ai.prompt.messages": [{ role: "user", content: "Alternate" }],
        "gen_ai.response.text": "Standard answer",
        "vercel.ai.response.text": "Alternate answer",
        "gen_ai.response.tool_calls": calls,
        "ai.response.toolCalls": [{ name: "alternate" }],
      },
    }),
  ).toMatchObject({ messages, response: "Standard answer", tools: calls });
});
