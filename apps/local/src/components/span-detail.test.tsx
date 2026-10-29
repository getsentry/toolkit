import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { decodeEnvelope } from "@/lib/spotlight.ts";
import { buildTraceGroups } from "@/test-fixtures/trace-groups.ts";
import { SpanDetail } from "./span-detail.tsx";

afterEach(cleanup);

test("span inspection shows its own timing, attributes and JSON plus navigable trace telemetry", async () => {
  const [trace] = await buildTraceGroups(
    decodeEnvelope(
      JSON.stringify([
        {},
        [
          [
            { type: "transaction" },
            {
              transaction: "GET /orders",
              start_timestamp: 1,
              timestamp: 2,
              contexts: { trace: { trace_id: "trace", span_id: "root" } },
              spans: [
                {
                  span_id: "query",
                  parent_span_id: "root",
                  description: "SELECT orders",
                  start_timestamp: 1.1,
                  timestamp: 1.2,
                  data: { "db.system": "postgresql" },
                },
              ],
            },
          ],
          [
            { type: "log" },
            { body: "Query completed", trace_id: "trace", span_id: "query" },
          ],
        ],
      ]),
      "fixture",
    ),
  );
  const span = trace?.spans.find((entry) => entry.id === "query");
  if (!trace || !span) throw new Error("Expected trace span");
  const related = vi.fn();
  const back = vi.fn();
  render(
    <SpanDetail
      trace={trace}
      span={span}
      onBack={back}
      onSelectRelatedItem={related}
    />,
  );
  expect(
    screen.getByRole("table", { name: "Span details" }).textContent,
  ).toContain("100ms");
  expect(
    screen.getByRole("table", { name: "Span attributes" }).textContent,
  ).toContain("postgresql");
  fireEvent.click(
    screen.getByRole("button", { name: "View log Query completed" }),
  );
  expect(related).toHaveBeenCalledWith(trace.items[1]);
  fireEvent.click(screen.getByRole("tab", { name: "JSON" }));
  expect(screen.getByTestId("highlighted-json").textContent).toContain(
    "SELECT orders",
  );
  expect(screen.getByTestId("highlighted-json").textContent).not.toContain(
    "GET /orders",
  );
  fireEvent.click(screen.getByRole("button", { name: "Back to trace" }));
  expect(back).toHaveBeenCalledOnce();
});
