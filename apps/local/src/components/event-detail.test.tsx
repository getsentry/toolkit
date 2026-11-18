import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { decodeEnvelope } from "@/lib/spotlight.ts";
import { buildTraceGroups } from "@/lib/trace-model.ts";
import { werkzeugLogEnvelope } from "@/test-fixtures/sentry-python.ts";
import { EventDetail } from "./event-detail.tsx";
import {
  pythonHandledException,
  pythonLoggingEvent,
  sdkErrorMessage,
} from "@/test-fixtures/sdk-message.ts";

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

test("logs display their message, severity, and structured attributes", () => {
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

test("raw-only SDK payloads default to JSON and reset on a different item", () => {
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

test("arrow navigation wraps between detail tabs and moves keyboard focus", () => {
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

test("raw envelopes retain their recognizable heading and open directly in JSON", () => {
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

test("malformed and nested log attributes remain readable inert text", () => {
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

test("requests show a compact copyable summary with captured method and URL", () => {
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

test("span summaries use captured typed URL attributes without inventing request fields", () => {
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

test("repeated parent updates keep one request summary and its waterfall", () => {
  const transaction = item("transaction", {
    transaction: "GET /orders",
    start_timestamp: 1,
    timestamp: 2,
    request: { status_code: 200 },
    contexts: { trace: { trace_id: "trace", span_id: "root" } },
  });
  const [trace] = buildTraceGroups([transaction]);
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

test("captured context suppresses the empty-details message", () => {
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

test("a related trace suppresses the empty-details message", () => {
  const transaction = item("transaction", {
    transaction: "GET /trace",
    contexts: { trace: { trace_id: "trace", span_id: "root" } },
    start_timestamp: 1,
    timestamp: 2,
  });
  const [trace] = buildTraceGroups([transaction]);
  render(<EventDetail item={item("event", {})} trace={trace} />);
  expect(screen.getByRole("region", { name: "Trace waterfall" })).toBeDefined();
  expect(screen.queryByText("No additional event details.")).toBeNull();
});

test("errors list their captured attachments collapsed until previewed", () => {
  const eventId = "a".repeat(32);
  const attachment = (filename: string, data: string) => [
    { type: "attachment", filename, content_type: "text/plain" },
    { data },
  ];
  // The bundled fixture shows envelope and payload IDs can differ; match either.
  const sameEnvelope = decodeEnvelope(
    JSON.stringify([
      { event_id: "d".repeat(32) },
      [
        [{ type: "event" }, { event_id: eventId, message: "Checkout failed" }],
        attachment("screen.txt", "captured screen"),
      ],
    ]),
    "error",
  );
  const [laterAttachment] = decodeEnvelope(
    JSON.stringify([
      { event_id: eventId },
      [attachment("hierarchy.txt", "view tree")],
    ]),
    "later",
  );
  const [otherAttachment] = decodeEnvelope(
    JSON.stringify([
      { event_id: "b".repeat(32) },
      [attachment("other.txt", "another event")],
    ]),
    "other",
  );
  const event = sameEnvelope[0]!;
  render(
    <EventDetail
      item={event}
      relatedItems={[...sameEnvelope, laterAttachment!, otherAttachment!]}
    />,
  );
  const attachments = screen.getByRole("region", { name: "Event attachments" });
  expect(attachments.textContent).toContain("screen.txt");
  expect(attachments.textContent).toContain("hierarchy.txt");
  expect(attachments.textContent).not.toContain("other.txt");
  expect(attachments.textContent).not.toContain("captured screen");

  fireEvent.click(
    screen.getByRole("button", { name: "Show screen.txt preview" }),
  );
  expect(attachments.textContent).toContain("captured screen");
  expect(attachments.textContent).not.toContain("view tree");
});

test("errors without captured attachments show no attachment section", () => {
  const event = item("event", { event_id: "c".repeat(32), message: "Boom" });
  render(<EventDetail item={event} relatedItems={[event]} />);
  expect(
    screen.queryByRole("region", { name: "Event attachments" }),
  ).toBeNull();
  expect(screen.queryByRole("heading", { name: "Attachments" })).toBeNull();
});

test("log messages hide terminal colour codes while JSON keeps them", () => {
  const [banner] = decodeEnvelope(werkzeugLogEnvelope, "logs");
  if (!banner) throw new Error("Expected log");
  render(<EventDetail item={banner} />);
  const overview = screen.getByRole("tabpanel").textContent ?? "";
  expect(overview).toContain("WARNING: This is a development server.");
  expect(overview).not.toContain("\u001b");
  expect(overview).not.toContain("[31m");
  fireEvent.click(screen.getByRole("tab", { name: "JSON" }));
  expect(screen.getByRole("tabpanel").textContent).toContain("[31m");
});

test("breadcrumb messages hide terminal colour codes", () => {
  // sentry-python records werkzeug's coloured access log as a breadcrumb.
  render(
    <EventDetail
      item={item("event", {
        level: "error",
        message: "Checkout failed",
        breadcrumbs: {
          values: [
            {
              type: "log",
              category: "werkzeug",
              level: "info",
              message:
                '127.0.0.1 - - [17/Nov/2026 20:59:55] "\u001b[33mGET /missing HTTP/1.1\u001b[0m" 404 -',
              timestamp: "2026-11-17T20:59:55.120Z",
            },
          ],
        },
      })}
    />,
  );
  const breadcrumbs = screen.getByRole("region", { name: "Breadcrumbs" });
  expect(breadcrumbs.textContent).toContain('"GET /missing HTTP/1.1" 404');
  expect(breadcrumbs.textContent).not.toContain("[33m");
});

test("logging events show their message and key event fields in Overview", () => {
  render(<EventDetail item={item("event", pythonLoggingEvent)} />);
  expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
    "Database query failed for orders",
  );
  expect(
    screen.getByTestId("event-detail").querySelector("header")?.textContent,
  ).toContain("Message");
  const details = screen.getByRole("table", { name: "Event details" });
  for (const [label, value] of [
    ["Message", "Database query failed for orders"],
    ["Level", "error"],
    ["Environment", "production"],
    ["Release", "shop@1.4.2"],
    ["Server", "web-1"],
  ])
    expect(
      within(details).getByRole("rowheader", { name: label }).nextSibling
        ?.textContent,
    ).toBe(value);
  const user = screen.getByRole("table", { name: "Event user" });
  for (const value of ["42", "ada@example.test", "ada", "127.0.0.1"])
    expect(user.textContent).toContain(value);
});

test("exception events show whether the SDK handled them", () => {
  render(<EventDetail item={item("event", pythonHandledException)} />);
  const details = screen.getByRole("table", { name: "Event details" });
  expect(
    within(details).getByRole("rowheader", { name: "Handled" }).nextSibling
      ?.textContent,
  ).toBe("Yes");
  const header = screen.getByTestId("event-detail").querySelector("header");
  expect(header?.textContent).toContain("Exception");
  expect(header?.textContent).not.toContain("event.django");
});

test("message events at error level are labelled as messages, not exceptions", () => {
  render(<EventDetail item={item("event", sdkErrorMessage)} />);
  const header = screen.getByTestId("event-detail").querySelector("header");
  expect(header?.textContent).toContain("Message");
  expect(header?.textContent).not.toContain("http.server");
  expect(header?.textContent).not.toContain("Exception");
});

test("contexts use readable names and skip empty sections", () => {
  render(<EventDetail item={item("event", pythonLoggingEvent)} />);
  const headings = screen
    .getAllByRole("heading", { level: 4 })
    .map((heading) => heading.textContent);
  expect(headings).toContain("OS");
  expect(headings).toContain("Runtime");
  expect(headings).not.toContain("Cloud resource");
  expect(headings).not.toContain("cloud_resource");
});

test("events whose contexts are all empty show no Contexts section", () => {
  render(
    <EventDetail
      item={item("event", {
        message: "Cache warmed",
        contexts: { cloud_resource: {}, culture: {} },
        tags: { region: "eu" },
      })}
    />,
  );
  expect(screen.queryByText(/^contexts$/i)).toBeNull();
  expect(screen.getByRole("table", { name: "Event tags" })).toBeDefined();
});
