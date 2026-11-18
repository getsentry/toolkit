import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { decodeEnvelope } from "@/lib/spotlight.ts";
import { buildTraceGroups } from "@/lib/trace-model.ts";
import { profiledRequest } from "@/test-fixtures/profiled-request.ts";
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

test("log-only trace groups are labelled and listed after traces with spans", () => {
  // sentry-python: werkzeug startup and access logs share the process
  // propagation trace ID, and keep arriving after each request finishes.
  const traces = buildTraceGroups([
    ...decodeEnvelope(
      JSON.stringify([
        {},
        [
          [
            { type: "transaction" },
            {
              transaction: "nested",
              start_timestamp: 1794949195.2293,
              timestamp: 1794949195.256,
              contexts: {
                trace: {
                  trace_id: "400af9c14606486da31dd2736ad3e526",
                  span_id: "8f3f855ff016f0dd",
                  op: "http.server",
                },
              },
            },
          ],
        ],
      ]),
      "request",
    ),
    ...decodeEnvelope(
      JSON.stringify([
        {},
        [
          [
            { type: "log", item_count: 2 },
            {
              items: [
                {
                  timestamp: 1794949191.5353,
                  level: "info",
                  body: " * Running on http://127.0.0.1:5050",
                  trace_id: "c22c7d1b8e124f7c99a0dc36a80ccbae",
                },
                {
                  timestamp: 1794949195.2575,
                  level: "info",
                  body: '127.0.0.1 - - [17/Nov/2026 20:59:55] "GET /nested HTTP/1.1" 200 -',
                  trace_id: "c22c7d1b8e124f7c99a0dc36a80ccbae",
                },
              ],
            },
          ],
        ],
      ]),
      "logs",
    ),
  ]);
  render(<TraceWorkspace traces={traces} onSelect={vi.fn()} />);
  const entries = screen
    .getAllByRole("button", { name: /^View trace / })
    .map((entry) => entry.textContent);
  expect(entries).toHaveLength(2);
  expect(entries[0]).toContain("nested");
  expect(entries[1]).toContain("Logs only");
  expect(entries[1]).not.toContain("0 spans");
  expect(
    screen.getByRole("table", { name: "Trace spans" }).textContent,
  ).toContain("nested");
});

test("trace counts use singular nouns for one", () => {
  const traces = buildTraceGroups(
    decodeEnvelope(
      JSON.stringify([
        {},
        [
          [
            { type: "transaction" },
            {
              transaction: "GET /logerror",
              start_timestamp: 1,
              timestamp: 2,
              contexts: { trace: { trace_id: "trace", span_id: "root" } },
              spans: [
                {
                  span_id: "child",
                  parent_span_id: "root",
                  op: "db",
                  start_timestamp: 1.1,
                  timestamp: 1.2,
                },
              ],
            },
          ],
          [
            { type: "event" },
            {
              level: "error",
              logentry: { message: "Something went wrong" },
              contexts: { trace: { trace_id: "trace", span_id: "root" } },
            },
          ],
          [
            { type: "log" },
            {
              items: [
                {
                  timestamp: 1.5,
                  level: "error",
                  body: "Something went wrong",
                  trace_id: "trace",
                },
              ],
            },
          ],
        ],
      ]),
      "trace",
    ),
  );
  render(<TraceWorkspace traces={traces} onSelect={vi.fn()} />);
  expect(screen.getByText("1 trace")).toBeDefined();
  const entry = screen.getByRole("button", {
    name: "View trace GET /logerror",
  }).textContent;
  expect(entry).toContain("1 error");
  expect(entry).toContain("1 log");
  expect(entry).not.toMatch(/1 (span|error|log)s/);
  expect(screen.getByLabelText("Trace summary").textContent).not.toMatch(
    /\b1 (span|error|log)s/,
  );
});

test("a profiled trace lists real spans and links its profile once", () => {
  const items = profiledRequest();
  const traces = buildTraceGroups(items);
  const selectProfile = vi.fn();
  render(
    <TraceWorkspace
      traces={traces}
      onSelect={vi.fn()}
      profiles={items.filter((item) => item.type === "profile_chunk")}
      onSelectProfile={selectProfile}
    />,
  );
  const entry = screen.getByRole("button", { name: "View trace GET /slow" });
  expect(entry.textContent).toContain("1 span");
  expect(entry.textContent).not.toContain("1 spans");
  const links = screen.getAllByRole("button", {
    name: /^Inspect .*profile.* for this trace$/,
  });
  expect(links).toHaveLength(1);
  fireEvent.click(links[0]!);
  expect(selectProfile).toHaveBeenCalledOnce();
});

test("returning from a sampled function keeps its row shown and focused", () => {
  const traces = buildTraceGroups(profiledRequest());
  function Workspace() {
    const [selectedSpanId, setSelectedSpanId] = useState<string>();
    return (
      <TraceWorkspace
        traces={traces}
        onSelect={() => undefined}
        selectedTraceId="t"
        selectedSpanId={selectedSpanId}
        onSelectSpan={(_traceId, spanId) => setSelectedSpanId(spanId)}
        onClearSpan={() => setSelectedSpanId(undefined)}
      />
    );
  }
  render(<Workspace />);
  fireEvent.click(
    screen.getByRole("button", { name: /^Show \d+ sampled function/ }),
  );
  const sampled = screen.getAllByRole("button", { name: "Inspect span work" });
  const id = sampled[0]!.dataset.spanId;
  fireEvent.click(sampled[0]!);
  fireEvent.click(screen.getByRole("button", { name: "Back to trace" }));
  expect((document.activeElement as HTMLElement | null)?.dataset.spanId).toBe(
    id,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Hide sampled functions" }),
  );
  expect(
    screen.queryAllByRole("button", { name: "Inspect span work" }),
  ).toHaveLength(0);
});
