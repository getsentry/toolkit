import { expect, test } from "vitest";
import { inspectAiInteraction } from "./ai-interactions.ts";
import type { TraceSpan } from "./trace-model.ts";

function step(
  id: string,
  data: Record<string, unknown>,
  children: TraceSpan[] = [],
  startTimestamp = 1,
): TraceSpan {
  return {
    id,
    description: id,
    children,
    startTimestamp,
    payload: { op: "gen_ai.chat", data },
    metadata: { title: id },
    item: { id, type: "span", payload: {}, text: "{}" },
  };
}
function fields(payload: unknown, steps: TraceSpan[] = []) {
  return Object.fromEntries(
    inspectAiInteraction(payload, steps)!.fields.map(({ label, value }) => [
      label,
      value,
    ]),
  );
}

test.each([5, 30])(
  "Vercel summary reconciles a parent subtotal of %i with child turns",
  (subtotal) => {
    const root = {
      op: "gen_ai.invoke_agent",
      data: {
        "vercel.ai.operationId": "ai.generateText",
        "gen_ai.usage.input_tokens": subtotal,
      },
    };
    expect(
      fields(root, [
        step("first", { "gen_ai.usage.input_tokens": 6 }),
        step("second", { "gen_ai.usage.input_tokens": 7 }),
      ])["Input tokens"],
    ).toBe(String(Math.max(subtotal, 13)));
  },
);

test("generic summaries sum turns through non-AI wrappers and ignore duplicate span IDs", () => {
  const first = step("first", {
    "gen_ai.usage.input_tokens": "4",
    "gen_ai.usage.output_tokens": 0,
  });
  const bridge = {
    ...step("bridge", {}, [first]),
    payload: { op: "http.client" },
  };
  expect(
    fields({ op: "gen_ai.invoke_agent" }, [
      bridge,
      first,
      step("second", { "gen_ai.usage.input_tokens": 6 }),
    ]),
  ).toMatchObject({ "Input tokens": "10", "Output tokens": "0" });
});

test("summary token totals omit invalid and overflowing counts but accept usable aliases", () => {
  expect(
    fields({
      op: "gen_ai.chat",
      data: {
        "gen_ai.usage.input_tokens": -2,
        "ai.usage.promptTokens": 0,
        "gen_ai.usage.output_tokens": Infinity,
      },
    }),
  ).toMatchObject({ "Input tokens": "0" });
  expect(
    fields({ op: "gen_ai.chat" }, [
      step("one", { "gen_ai.usage.input_tokens": Number.MAX_VALUE }),
      step("two", { "gen_ai.usage.input_tokens": Number.MAX_VALUE }),
    ])["Input tokens"],
  ).toBeUndefined();
});

test("response pairing follows turn timestamps and clears an older reason when the latest text has none", () => {
  const early = step(
    "early",
    {
      "gen_ai.response.text": "Earlier",
      "gen_ai.response.finish_reasons": '["length"]',
    },
    [],
    1,
  );
  const late = step("late", { "gen_ai.response.text": "Latest" }, [], 2);
  const summary = inspectAiInteraction({ op: "gen_ai.invoke_agent" }, [
    late,
    early,
  ])!;
  expect(summary.response).toBe("Latest");
  expect(summary.fields.some((field) => field.label === "Finish reason")).toBe(
    false,
  );
});

test("finish reasons remain available when content capture is disabled", () => {
  expect(
    fields({ op: "gen_ai.invoke_agent" }, [
      step("chat", { "gen_ai.response.finish_reasons": '["tool_calls"]' }),
    ])["Finish reason"],
  ).toBe("tool_calls");
});

test("blank parent metadata does not hide populated descendant fields", () => {
  expect(
    fields(
      {
        op: "gen_ai.invoke_agent",
        data: {
          "gen_ai.request.model": "",
          "gen_ai.system": "   ",
        },
      },
      [
        step("chat", {
          "gen_ai.request.model": "child-model",
          "gen_ai.system": "child-provider",
        }),
      ],
    ),
  ).toMatchObject({ Model: "child-model", Provider: "child-provider" });
});

test.each([[], "not JSON"])(
  "usable descendant conversation wins over root raw fallback: %j",
  (messages) => {
    const captured = [
      {
        role: "user",
        content: [{ type: "image", image: "captured" }],
        unknown: true,
      },
    ];
    expect(
      inspectAiInteraction(
        {
          op: "gen_ai.invoke_agent",
          data: { "gen_ai.request.messages": messages },
        },
        [step("chat", { "gen_ai.request.messages": captured })],
      )?.messages,
    ).toEqual(captured);
  },
);
