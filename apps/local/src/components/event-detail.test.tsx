import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { decodeEnvelope } from "@/lib/spotlight.ts";
import { buildTraceGroups } from "@/test-fixtures/trace-groups.ts";
import { EventDetail } from "./event-detail.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function item(type: string, payload: unknown) {
  const entry = decodeEnvelope(
    JSON.stringify([{}, [[{ type }, payload]]]),
    "fixture",
  )[0];
  if (!entry) throw new Error("Expected fixture");
  return entry;
}

test("logs display their message, severity, and structured attributes", async () => {
  render(
    <EventDetail
      item={item("log", {
        body: "Cache refreshed",
        level: "info",
        attributes: { "cache.key": { type: "string", value: "orders" } },
      })}
    />,
  );
  expect(screen.getByRole("tabpanel").textContent).toContain("Cache refreshed");
  expect(screen.getByRole("tabpanel").textContent).toContain("info");
  expect(
    screen.getByRole("table", { name: "Log attributes" }).textContent,
  ).toContain("orders");
  expect(screen.getByRole("button", { name: "Copy Message" })).toBeDefined();
});

test("raw-only SDK payloads default to JSON and reset on a different item", async () => {
  const { rerender } = render(
    <EventDetail item={item("log", { body: "first" })} />,
  );
  fireEvent.click(screen.getByRole("tab", { name: "JSON" }));
  rerender(
    <EventDetail
      item={item("client_report", {
        discarded_events: [{ reason: "sample_rate" }],
      })}
    />,
  );
  expect(
    screen.getByRole("tab", { name: "JSON" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(screen.getByTestId("highlighted-json").textContent).toContain(
    "sample_rate",
  );
  rerender(
    <EventDetail item={{ ...item("log", { body: "second" }), id: "second" }} />,
  );
  expect(
    screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected"),
  ).toBe("true");
});

test("arrow navigation wraps between detail tabs and moves keyboard focus", async () => {
  render(<EventDetail item={item("log", { body: "navigation" })} />);
  const overview = screen.getByRole("tab", { name: "Overview" });
  fireEvent.keyDown(overview, { key: "ArrowLeft" });
  const json = screen.getByRole("tab", { name: "JSON" });
  expect(json.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(json);
  fireEvent.keyDown(json, { key: "ArrowRight" });
  expect(overview.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(overview);
});

test("raw envelopes retain their recognizable heading and open directly in JSON", async () => {
  const envelope = {
    id: "envelope:1",
    type: "envelope",
    text: "undecodable source",
    payload: "undecodable source",
    metadata: { title: "Envelope 1" },
  };
  render(<EventDetail item={envelope} />);
  expect(screen.getByRole("heading", { name: "Raw envelope" })).toBeDefined();
  expect(
    screen.getByRole("tab", { name: "JSON" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(screen.getByTestId("highlighted-json").textContent).toContain(
    "undecodable source",
  );
});

test("malformed and nested log attributes remain readable inert text", async () => {
  render(
    <EventDetail
      item={item("log", {
        body: "Attributes",
        attributes: {
          missing: { type: "string" },
          empty: null,
          list: [1, null],
          nested: {
            type: "string",
            value: { source: "<script>unsafe()</script>" },
          },
        },
      })}
    />,
  );
  const attributes = screen.getByRole("table", { name: "Log attributes" });
  expect(attributes.textContent).toContain('"type":"string"');
  expect(attributes.textContent).toContain("null");
  expect(attributes.textContent).toContain("[1,null]");
  expect(attributes.textContent).toContain("<script>unsafe()</script>");
  expect(attributes.querySelector("script")).toBeNull();
});

test("requests show a compact copyable summary with captured method and URL", async () => {
  const copied: string[] = [];
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: async (value: string) => {
        copied.push(value);
      },
    },
  });
  render(
    <EventDetail
      item={item("transaction", {
        transaction: "GET /orders",
        request: {
          method: "GET",
          url: "https://example.test/orders?limit=10",
          status_code: 201,
        },
        start_timestamp: 1,
        timestamp: 1.25,
        contexts: { trace: { data: { "sentry.origin": "auto.http" } } },
      })}
    />,
  );
  const summary = screen.getByLabelText("Request summary");
  expect(summary.tagName).toBe("DL");
  expect(summary.textContent).toContain("GET");
  expect(summary.textContent).toContain("https://example.test/orders?limit=10");
  expect(summary.textContent).toContain("201");
  expect(summary.textContent).toContain("250ms");
  expect(summary.textContent).toContain("auto.http");
  expect(screen.queryByRole("table", { name: "Event details" })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Copy Status", description: "201" }),
  );
  expect(screen.getByRole("status", { name: "Status copied" })).toBeDefined();
  expect(copied).toEqual(["201"]);
});

test("span summaries use captured typed URL attributes without inventing request fields", async () => {
  render(
    <EventDetail
      item={item("span", {
        trace_id: "trace",
        span_id: "span",
        start_timestamp: 1,
        end_timestamp: 2,
        attributes: {
          "url.full": { type: "string", value: "https://example.test/items" },
          "http.request.method": { type: "string", value: "POST" },
        },
      })}
    />,
  );
  const summary = screen.getByLabelText("Span summary");
  expect(summary.textContent).toContain("https://example.test/items");
  expect(summary.textContent).toContain("POST");
  expect(summary.textContent).not.toContain("Status");
});

test("repeated parent updates keep one request summary and its waterfall", async () => {
  const transaction = item("transaction", {
    transaction: "GET /orders",
    start_timestamp: 1,
    timestamp: 2,
    request: { status_code: 200 },
    contexts: { trace: { trace_id: "trace", span_id: "root" } },
  });
  const [trace] = await buildTraceGroups([transaction]);
  const { rerender } = render(<EventDetail item={transaction} trace={trace} />);
  for (let index = 0; index < 10; index += 1) {
    rerender(
      <EventDetail
        item={{ ...transaction }}
        trace={trace}
        onSelectSpan={() => undefined}
      />,
    );
  }
  expect(screen.getAllByLabelText("Request summary")).toHaveLength(1);
  expect(
    screen.getAllByRole("region", { name: "Trace waterfall" }),
  ).toHaveLength(1);
  expect(
    screen.getByRole("button", { name: "Inspect span GET /orders" }),
  ).toBeDefined();
});

test("captured context suppresses the empty-details message", async () => {
  render(
    <EventDetail
      item={item("event", {
        tags: { environment: "local" },
        contexts: { browser: { name: "Firefox" } },
      })}
    />,
  );
  expect(screen.getByText("Firefox")).toBeDefined();
  expect(screen.queryByText("No additional event details.")).toBeNull();
});

test("a related trace suppresses the empty-details message", async () => {
  const transaction = item("transaction", {
    transaction: "GET /trace",
    contexts: { trace: { trace_id: "trace", span_id: "root" } },
    start_timestamp: 1,
    timestamp: 2,
  });
  const [trace] = await buildTraceGroups([transaction]);
  render(<EventDetail item={item("event", {})} trace={trace} />);
  expect(screen.getByRole("region", { name: "Trace waterfall" })).toBeDefined();
  expect(screen.queryByText("No additional event details.")).toBeNull();
});
