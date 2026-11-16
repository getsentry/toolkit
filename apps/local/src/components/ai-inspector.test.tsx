import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { AiInspector } from "./ai-inspector.tsx";
import { buildTraceGroups } from "../lib/trace-model.ts";
import { decodeEnvelope } from "../lib/spotlight.ts";

afterEach(cleanup);

function interaction(spans: unknown[]) {
  return buildTraceGroups(
    decodeEnvelope(
      JSON.stringify([
        {},
        [
          [
            { type: "transaction" },
            {
              start_timestamp: 1,
              timestamp: 8,
              contexts: {
                trace: {
                  trace_id: "trace",
                  span_id: "root",
                  op: "gen_ai.invoke_agent",
                },
              },
              data: {
                "vercel.ai.operationId": "ai.generateText",
                "gen_ai.usage.input_tokens": 10,
              },
              spans,
            },
          ],
        ],
      ]),
      "ai-test",
    ),
  )[0]!.roots[0]!;
}

test("AI interaction summarizes descendant usage, model and latest response while retaining steps", () => {
  const root = interaction([
    {
      span_id: "first",
      parent_span_id: "root",
      op: "gen_ai.chat",
      description: "First turn",
      start_timestamp: 2,
      timestamp: 3,
      data: {
        "gen_ai.request.model": "child-model",
        "gen_ai.system": "child-provider",
        "gen_ai.usage.input_tokens": 6,
        "gen_ai.usage.output_tokens": 2,
        "gen_ai.response.text": "First answer",
        "gen_ai.response.finish_reasons": '["length"]',
      },
    },
    {
      span_id: "second",
      parent_span_id: "root",
      op: "gen_ai.chat",
      description: "Second turn",
      start_timestamp: 4,
      timestamp: 5,
      data: {
        "gen_ai.usage.input_tokens": 7,
        "gen_ai.usage.output_tokens": 3,
        "gen_ai.response.text": "Latest answer",
        "gen_ai.response.finish_reasons": '["stop"]',
      },
    },
    {
      span_id: "tool",
      parent_span_id: "root",
      op: "gen_ai.execute_tool",
      description: "Tool step",
      start_timestamp: 6,
      timestamp: 7,
      data: {
        "gen_ai.response.finish_reasons": '["tool_calls"]',
        "gen_ai.tool.name": "lookup",
        "gen_ai.tool.output": false,
        "gen_ai.usage.input_tokens": -100,
        "gen_ai.usage.output_tokens": "invalid",
      },
    },
  ]);
  render(<AiInspector payload={root.payload} steps={root.children} />);
  const details = screen.getAllByRole("table", { name: "AI details" })[0]!;
  expect(details.textContent).toContain("child-model");
  expect(details.textContent).toContain("child-provider");
  expect(within(details).getByText("13")).toBeDefined();
  expect(within(details).getByText("5")).toBeDefined();
  expect(within(details).getByText("stop")).toBeDefined();
  expect(screen.getAllByText("Latest answer").length).toBeGreaterThan(0);
  expect(screen.getByText("First turn")).toBeDefined();
  expect(screen.getByText("Second turn")).toBeDefined();
  expect(screen.getByText("Tool step")).toBeDefined();
});
