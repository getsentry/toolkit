import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { formatDateTime } from "@/lib/presentation.ts";
import { decodeEnvelope } from "@/lib/spotlight.ts";
import { buildTraceGroups } from "@/lib/trace-model.ts";
import { SpanDetail } from "./span-detail.tsx";

afterEach(cleanup);

test("span inspection shows its own timing, attributes and JSON plus navigable trace telemetry", () => {
  const [trace] = buildTraceGroups(
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

test("span start and end times use local time, not raw epoch seconds", () => {
  const [trace] = buildTraceGroups(
    decodeEnvelope(
      JSON.stringify([
        {},
        [
          [
            { type: "transaction" },
            {
              transaction: "GET /orders",
              start_timestamp: 1795010400.538,
              timestamp: 1795010400.65,
              contexts: { trace: { trace_id: "trace", span_id: "root" } },
            },
          ],
        ],
      ]),
      "fixture",
    ),
  );
  const span = trace?.spans.find((entry) => entry.id === "root");
  if (!trace || !span) throw new Error("Expected trace span");
  render(<SpanDetail trace={trace} span={span} />);
  const details = screen.getByRole("table", {
    name: "Span details",
  }).textContent;
  expect(details).not.toContain("1795010400.538");
  expect(details).toContain(
    formatDateTime(1795010400.538, { milliseconds: true }),
  );
  expect(details).toContain(
    formatDateTime(1795010400.65, { milliseconds: true }),
  );
});

test("span times keep milliseconds and show the date when it is not today", () => {
  // A 40 ms span from an earlier day.
  const [trace] = buildTraceGroups(
    decodeEnvelope(
      JSON.stringify([
        {},
        [
          [
            { type: "transaction" },
            {
              transaction: "GET /orders",
              start_timestamp: 1_700_000_000.538,
              timestamp: 1_700_000_000.578,
              contexts: { trace: { trace_id: "trace", span_id: "root" } },
            },
          ],
        ],
      ]),
      "fixture",
    ),
  );
  const span = trace?.spans.find((entry) => entry.id === "root");
  if (!trace || !span) throw new Error("Expected trace span");
  render(<SpanDetail trace={trace} span={span} />);
  const details = screen.getByRole("table", { name: "Span details" });
  const time = (ms: number) =>
    new Date(ms).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
    });
  const start = within(details).getByRole("row", { name: /Start timestamp/ });
  const end = within(details).getByRole("row", { name: /End timestamp/ });
  const day = new Date(1_700_000_000_538).toLocaleDateString();
  expect(start.textContent).toContain(`${day} ${time(1_700_000_000_538)}`);
  expect(end.textContent).toContain(`${day} ${time(1_700_000_000_578)}`);
});
