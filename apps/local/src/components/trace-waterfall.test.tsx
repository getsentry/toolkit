import { afterEach, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { decodeEnvelope } from "@/lib/spotlight.ts";
import { buildTraceGroups } from "@/lib/trace-model.ts";
import { profiledRequest } from "@/test-fixtures/profiled-request.ts";
import {
  spanEnvelope,
  streamedPageloadSpans,
} from "@/test-fixtures/streamed-pageload.ts";
import { TraceWaterfall } from "./trace-waterfall.tsx";

afterEach(cleanup);

test.each(["internal_error", "error"])(
  "styles status-only %s failures without affecting healthy children",
  (status) => {
    const items = decodeEnvelope(
      JSON.stringify([
        {},
        [
          [
            { type: "transaction" },
            {
              transaction: "GET /failed",
              start_timestamp: 1,
              timestamp: 2,
              contexts: {
                trace: { trace_id: "trace", span_id: "root", status },
              },
              spans: [
                {
                  span_id: "healthy",
                  parent_span_id: "root",
                  op: "db.query",
                  status: "ok",
                  start_timestamp: 1.1,
                  timestamp: 1.2,
                },
                {
                  span_id: "failed",
                  parent_span_id: "root",
                  op: "db.query",
                  status,
                  start_timestamp: 1.3,
                  timestamp: 1.4,
                },
              ],
            },
          ],
        ],
      ]),
      "envelope",
    );
    const trace = buildTraceGroups(items)[0];
    expect(trace).toBeDefined();
    if (!trace) throw new Error("Expected trace");
    render(<TraceWaterfall trace={trace} />);
    expect(screen.getByTestId("waterfall-bar-root").className).toContain(
      "bg-red-500",
    );
    expect(screen.getByTestId("waterfall-bar-failed").className).toContain(
      "bg-red-500",
    );
    expect(screen.getByTestId("waterfall-bar-healthy").className).not.toContain(
      "bg-red-500",
    );
  },
);

test("renders a deeply nested valid span chain without overflowing the stack", () => {
  const count = 4000;
  const items = decodeEnvelope(
    JSON.stringify([
      {},
      [
        [
          { type: "transaction" },
          {
            transaction: "deep trace",
            start_timestamp: 0,
            timestamp: count + 1,
            contexts: { trace: { trace_id: "deep", span_id: "root" } },
            spans: Array.from({ length: count }, (_, index) => ({
              span_id: `span-${index}`,
              parent_span_id: index === 0 ? "root" : `span-${index - 1}`,
              description: `deep-${index}`,
              start_timestamp: index,
              timestamp: index + 1,
            })),
          },
        ],
      ],
    ]),
    "deep-envelope",
  );
  const trace = buildTraceGroups(items)[0];
  if (!trace) throw new Error("Expected deep trace");
  const markup = renderToStaticMarkup(<TraceWaterfall trace={trace} />);
  expect(markup).toContain(`waterfall-bar-span-${count - 1}`);
  expect(markup.indexOf("deep-0")).toBeLessThan(
    markup.indexOf(`deep-${count - 1}`),
  );
});

test("span descriptions are keyboard-selectable and expose selected state", () => {
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
            },
          ],
        ],
      ]),
      "select",
    ),
  );
  if (!trace) throw new Error("Expected trace");
  let selected: string | undefined;
  render(
    <TraceWaterfall
      trace={trace}
      selectedSpanId="root"
      onSelectSpan={(spanId) => {
        selected = spanId;
      }}
    />,
  );
  const button = screen.getByRole("button", {
    name: "Inspect span GET /orders",
  });
  expect(button.getAttribute("aria-pressed")).toBe("true");
  button.click();
  expect(selected).toBe("root");
});

test("rows indent by depth whether or not they can expand", () => {
  // sentry-python Flask request with a nested span and a leaf sibling.
  const [trace] = buildTraceGroups(
    decodeEnvelope(
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
              spans: [
                {
                  span_id: "b101bbb76c7ef0f6",
                  parent_span_id: "8f3f855ff016f0dd",
                  op: "db.query",
                  description: "db.query",
                  start_timestamp: 1794949195.2299,
                  timestamp: 1794949195.2504,
                },
                {
                  span_id: "9557ac27dc16718d",
                  parent_span_id: "b101bbb76c7ef0f6",
                  op: "function",
                  description: "nested compute",
                  start_timestamp: 1794949195.2402,
                  timestamp: 1794949195.2503,
                },
                {
                  span_id: "a98476103a8d8356",
                  parent_span_id: "8f3f855ff016f0dd",
                  op: "cache.get",
                  description: "cache lookup",
                  start_timestamp: 1794949195.2505,
                  timestamp: 1794949195.2556,
                },
              ],
            },
          ],
        ],
      ]),
      "nested",
    ),
  );
  if (!trace) throw new Error("Expected trace");
  render(<TraceWaterfall trace={trace} onSelectSpan={() => {}} />);
  const labelOffset = (description: string) => {
    const cell = screen
      .getByRole("button", { name: `Inspect span ${description}` })
      .closest('[role="cell"]') as HTMLElement;
    const toggle = cell.querySelector(":scope > .size-3, :scope > button");
    expect(toggle, `${description} reserves the expand control`).not.toBeNull();
    return Number.parseFloat(cell.style.paddingLeft);
  };
  const root = labelOffset("nested");
  const query = labelOffset("db.query");
  const compute = labelOffset("nested compute");
  const cache = labelOffset("cache lookup");
  expect(query).toBeGreaterThan(root);
  expect(cache).toBe(query);
  expect(compute).toBeGreaterThan(query);
});

test("streamed resource and fetch spans show and match their URL instead of the host", () => {
  const [trace] = buildTraceGroups(
    decodeEnvelope(spanEnvelope(streamedPageloadSpans), "pageload"),
  );
  if (!trace) throw new Error("Expected trace");
  render(<TraceWaterfall trace={trace} onSelectSpan={() => {}} />);
  expect(
    screen.getByRole("button", {
      name: "Inspect span GET http://localhost:4000/api/data",
    }),
  ).toBeDefined();
  expect(
    screen.getByRole("button", {
      name: "Inspect span http://localhost:4000/app.js",
    }),
  ).toBeDefined();
  expect(screen.queryByText("localhost")).toBeNull();
  fireEvent.change(screen.getByLabelText("Search in trace"), {
    target: { value: "api" },
  });
  expect(screen.getByRole("status").textContent).toContain("1 matches");
});

test("sampled profile rows stay folded under their span until shown", () => {
  const trace = buildTraceGroups(profiledRequest())[0]!;
  render(<TraceWaterfall trace={trace} onSelectSpan={() => undefined} />);
  const summary = screen.getByLabelText("Trace summary").textContent;
  expect(summary).toContain("1 span");
  expect(summary).not.toContain("1 spans");
  expect(
    screen.queryAllByRole("button", { name: "Inspect span work" }),
  ).toEqual([]);
  const toggle = screen.getByRole("button", {
    name: /^Show \d+ sampled function/,
  });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(
    screen.getAllByRole("button", { name: "Inspect span work" }).length,
  ).toBeGreaterThan(0);
  fireEvent.click(
    screen.getByRole("button", { name: /^Hide sampled functions/ }),
  );
  expect(
    screen.queryAllByRole("button", { name: "Inspect span work" }),
  ).toEqual([]);
});

test("each sampled-functions toggle names its span", () => {
  const trace = buildTraceGroups(profiledRequest())[0]!;
  render(<TraceWaterfall trace={trace} onSelectSpan={() => undefined} />);
  const toggle = screen.getByRole("button", {
    name: /^Show \d+ sampled functions? under GET \/slow$/,
  });
  fireEvent.click(toggle);
  expect(
    screen.getByRole("button", {
      name: "Hide sampled functions under GET /slow",
    }),
  ).toBeDefined();
});

test("search unfolds sampled rows only when a sampled row matches", () => {
  const trace = buildTraceGroups(profiledRequest())[0]!;
  render(<TraceWaterfall trace={trace} onSelectSpan={() => undefined} />);
  const search = screen.getByLabelText("Search in trace");
  fireEvent.change(search, { target: { value: "SELECT" } });
  expect(
    screen.queryAllByRole("button", { name: "Inspect span work" }),
  ).toEqual([]);
  fireEvent.change(search, { target: { value: "work" } });
  expect(
    screen.getAllByRole("button", { name: "Inspect span work" }).length,
  ).toBeGreaterThan(0);
});

test("selecting a sampled row after mount shows its folded siblings", () => {
  const trace = buildTraceGroups(profiledRequest())[0]!;
  const sampled = trace.spans.find((span) => span.sampled)!;
  const { rerender } = render(
    <TraceWaterfall trace={trace} onSelectSpan={() => undefined} />,
  );
  rerender(
    <TraceWaterfall
      trace={trace}
      selectedSpanId={sampled.id}
      onSelectSpan={() => undefined}
    />,
  );
  expect(
    screen
      .getAllByRole("button", { name: "Inspect span work" })
      .some((button) => button.getAttribute("aria-pressed") === "true"),
  ).toBe(true);
});

test("a selected sampled row stays visible when returning to the trace", () => {
  const trace = buildTraceGroups(profiledRequest())[0]!;
  const sampled = trace.spans.find((span) => span.sampled)!;
  render(
    <TraceWaterfall
      trace={trace}
      selectedSpanId={sampled.id}
      onSelectSpan={() => undefined}
    />,
  );
  expect(
    screen
      .getAllByRole("button", { name: "Inspect span work" })
      .some((button) => button.getAttribute("aria-pressed") === "true"),
  ).toBe(true);
});
