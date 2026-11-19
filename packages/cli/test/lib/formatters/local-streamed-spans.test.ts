/**
 * Tail output for span v2 batches shaped like the ones JavaScript SDK 11 sends
 * in stream mode: every span of a trace on its own, children before their
 * segment, and spans that end after their segment in a later batch.
 */

import { describe, expect, test } from "vitest";
import { formatItem } from "../../../src/lib/formatters/local.js";
import { stripAnsi } from "../../../src/lib/formatters/plain-detect.js";

const TRACE_ID = "4c79f60c11214eb38604f4ae0781bfb2";
const SEGMENT_ID = "a39103452fcf4abc";
const REQUEST_START = 1_794_949_298;

type Value = string | number | boolean;

function attributes(values: Record<string, Value>) {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      { type: typeof value === "string" ? "string" : "double", value },
    ]),
  );
}

const honoHeader = {
  sdk: { name: "sentry.javascript.hono", version: "11.14.0" },
};

/** A span of the request; `time` is its start and end, in seconds after the request started. */
function honoSpan(
  span_id: string,
  name: string,
  time: [number, number],
  values: Record<string, Value>,
  parent: string | null = SEGMENT_ID,
) {
  return {
    trace_id: TRACE_ID,
    span_id,
    parent_span_id: parent ?? undefined,
    name,
    start_timestamp: REQUEST_START + time[0],
    end_timestamp: REQUEST_START + time[1],
    is_segment: span_id === SEGMENT_ID,
    status: "ok",
    attributes: attributes({
      ...values,
      "sentry.segment.id": SEGMENT_ID,
      "sentry.segment.name": "GET /spans",
    }),
  };
}

/** `GET /spans` on a Hono server, children first as the SDK buffers them. */
const honoRequestSpans = [
  honoSpan("b000000000000001", "logger", [0.001, 0.002], {
    "sentry.op": "middleware.hono",
  }),
  honoSpan("b000000000000002", "cors", [0.002, 0.003], {
    "sentry.op": "middleware.hono",
  }),
  honoSpan("b000000000000003", "load-orders", [0.003, 0.04], {
    "sentry.op": "function",
  }),
  honoSpan(
    "b000000000000004",
    "SELECT * FROM orders",
    [0.01, 0.035],
    { "sentry.op": "db", "db.system.name": "postgresql" },
    "b000000000000003",
  ),
  honoSpan(
    SEGMENT_ID,
    "GET /spans",
    [0, 0.052],
    {
      "sentry.op": "http.server",
      "http.request.method": "GET",
      "url.path": "/spans",
      "http.response.status_code": 200,
    },
    null,
  ),
];

function tailLines(items: unknown[], showAttributes = false): string[] {
  return formatItem("span", { items }, honoHeader, "span", {
    showAttributes,
  }).map((line) => stripAnsi(line));
}

describe("streamed span batches", () => {
  test("print one line per segment with its span count and duration", () => {
    const lines = tailLines(honoRequestSpans);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[TRACE]");
    expect(lines[0]).toContain("GET /spans");
    expect(lines[0]).toContain("[52ms]");
    expect(lines[0]).toContain("[4 spans]");
    expect(lines[0]).toContain("[trace:4c79f60c]");
  });

  test("keep separate segments of one trace on separate lines", () => {
    const fetchSpan = {
      trace_id: TRACE_ID,
      span_id: "c000000000000001",
      name: "GET http://localhost:4000/api/orders",
      start_timestamp: 1_794_949_299,
      end_timestamp: 1_794_949_299.08,
      is_segment: true,
      status: "ok",
      attributes: attributes({
        "sentry.op": "http.client",
        "sentry.segment.id": "c000000000000001",
        "http.request.method": "GET",
        "url.full": "http://localhost:4000/api/orders",
      }),
    };
    const lines = tailLines([...honoRequestSpans, fetchSpan]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("GET /spans");
    expect(lines[1]).toContain("[http.client]");
    expect(lines[1]).not.toContain("spans]");
  });

  test("group spans without segment attributes by their top parent", () => {
    const bare = honoRequestSpans.map(({ attributes: attrs, ...span }) => ({
      ...span,
      is_segment: undefined,
      attributes: Object.fromEntries(
        Object.entries(attrs).filter(([key]) => !key.startsWith("sentry.seg")),
      ),
    }));
    const lines = tailLines(bare);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("GET /spans");
    expect(lines[0]).toContain("[4 spans]");
  });

  test("don't treat a top parent whose own parent is missing as a segment", () => {
    const bareChildren = honoRequestSpans
      .filter((span) => !span.is_segment)
      .map(({ attributes: attrs, ...span }) => ({
        ...span,
        attributes: Object.fromEntries(
          Object.entries(attrs).filter(
            ([key]) => !key.startsWith("sentry.seg"),
          ),
        ),
      }));
    const lines = tailLines(bareChildren);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain("load-orders [+2 spans]");
    expect(lines.join("\n")).not.toMatch(/\[\d+ spans?\]/);
  });

  test("print spans that arrive after their segment as one line for the segment", () => {
    const late = honoRequestSpans.slice(0, 2);
    const lines = tailLines(late);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("GET /spans [+2 spans]");
    expect(lines[0]).not.toContain("middleware");
  });

  test("print a single late span in full, marked [+1 span]", () => {
    const lines = tailLines(honoRequestSpans.slice(2, 3));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("load-orders");
    expect(lines[0]).toContain("[+1 span]");
  });

  test("with --attributes, list every span under its segment", () => {
    const lines = tailLines(honoRequestSpans, true);
    const spanLines = lines.filter((line) => line.includes("[TRACE]"));
    expect(spanLines).toHaveLength(5);
    expect(spanLines[0]).toContain("GET /spans");
    expect(spanLines[0]).toContain("[4 spans]");
    expect(lines.join("\n")).toContain("postgresql");
  });

  test("with --attributes, list every late span under the segment line", () => {
    const lines = tailLines(honoRequestSpans.slice(0, 2), true);
    const spanLines = lines.filter((line) => line.includes("[TRACE]"));
    expect(spanLines).toHaveLength(3);
    expect(spanLines[0]).toContain("GET /spans [+2 spans]");
    expect(spanLines[1]).toContain("logger");
    expect(spanLines[2]).toContain("cors");
  });
});
