import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { decodeEnvelope } from "@/lib/spotlight.ts";
import { buildTraceGroups } from "@/lib/trace-model.ts";
import { TraceWorkspace } from "./trace-workspace.tsx";

afterEach(cleanup);

test("selects spans within the trace inspector and returns to the waterfall", () => {
  const traces = buildTraceGroups(
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
            },
          ],
        ],
      ]),
      "trace",
    ),
  );
  const selectSpan = vi.fn();
  const clearSpan = vi.fn();
  const { rerender } = render(
    <TraceWorkspace
      traces={traces}
      onSelect={vi.fn()}
      selectedTraceId="trace"
      onSelectSpan={selectSpan}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Inspect span GET /orders" }),
  );
  expect(selectSpan).toHaveBeenCalledWith("trace", "root");
  rerender(
    <TraceWorkspace
      traces={traces}
      onSelect={vi.fn()}
      selectedTraceId="trace"
      selectedSpanId="root"
      onClearSpan={clearSpan}
    />,
  );
  expect(screen.getByRole("region", { name: "Span detail" })).toBeDefined();
  expect(screen.queryByRole("table", { name: "Trace spans" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Back to trace" }));
  expect(clearSpan).toHaveBeenCalledOnce();
});

test("a stale trace selection cannot drill into a duplicate span ID on a fallback trace", () => {
  const traces = buildTraceGroups(
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
            },
          ],
        ],
      ]),
      "trace",
    ),
  );
  render(
    <TraceWorkspace
      traces={traces}
      onSelect={vi.fn()}
      selectedTraceId="expired-trace"
      selectedSpanId="root"
      onSelectSpan={vi.fn()}
    />,
  );
  expect(screen.queryByRole("region", { name: "Span detail" })).toBeNull();
  expect(screen.getByRole("table", { name: "Trace spans" })).toBeDefined();
  expect(
    screen
      .getByRole("button", { name: "Inspect span GET /orders" })
      .getAttribute("aria-pressed"),
  ).toBe("false");
});

test("drilling into a span and returning restores keyboard focus", () => {
  const traces = buildTraceGroups(
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
            },
          ],
        ],
      ]),
      "trace",
    ),
  );
  function Workspace() {
    const [selectedSpanId, setSelectedSpanId] = useState<string>();
    return (
      <TraceWorkspace
        traces={traces}
        onSelect={() => undefined}
        selectedTraceId="trace"
        selectedSpanId={selectedSpanId}
        onSelectSpan={(_traceId, spanId) => setSelectedSpanId(spanId)}
        onClearSpan={() => setSelectedSpanId(undefined)}
      />
    );
  }
  render(<Workspace />);
  fireEvent.click(
    screen.getByRole("button", { name: "Inspect span GET /orders" }),
  );
  const back = screen.getByRole("button", { name: "Back to trace" });
  expect(document.activeElement).toBe(back);
  fireEvent.click(back);
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Inspect span GET /orders" }),
  );
});
