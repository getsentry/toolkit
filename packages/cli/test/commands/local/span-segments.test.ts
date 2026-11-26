import { describe, expect, test } from "vitest";
import { summarizeEnvelope } from "../../../src/commands/local/event-summary.js";
import { formatItem } from "../../../src/lib/formatters/local.js";
import { stripAnsi } from "../../../src/lib/formatters/plain-detect.js";

const pageloadId = "a39103452fcf4abc";

/** A web vital span the browser SDK sends after its pageload segment. */
function vital(span_id: string, name: string, op: string) {
  return {
    trace_id: "3deb203c4ee144c8bb6104076eabc7f4",
    span_id,
    parent_span_id: pageloadId,
    name,
    is_segment: false,
    start_timestamp: 1_794_949_298.4,
    end_timestamp: 1_794_949_298.6,
    attributes: {
      "sentry.op": { type: "string", value: op },
      "sentry.segment.id": { type: "string", value: pageloadId },
      "sentry.segment.name": { type: "string", value: "/client" },
    },
  };
}

describe("span segments", () => {
  test("event list and the tail name a late web vitals batch the same way", () => {
    const payload = {
      items: [
        vital(
          "938bffa38304c5e3",
          "Largest contentful paint",
          "ui.webvital.lcp",
        ),
        vital("9f85c8bac4e3ddc2", "Layout shift", "ui.webvital.cls"),
        vital("884777f7b416aa02", "Click", "ui.interaction.click"),
      ],
    };
    const header = {
      sdk: { name: "sentry.javascript.nextjs", version: "11.14.0" },
    };
    const { title } = summarizeEnvelope({
      envelope: [
        { ...header, __spotlight_envelope_id: "test-envelope" },
        [[{ type: "span" }, payload]],
      ],
    });
    const [line] = formatItem("span", payload, header, "span").map((l) =>
      stripAnsi(l),
    );
    expect(title).toBe("/client");
    expect(line).toContain(`${title} [+3 spans]`);
  });

  /**
   * Span v2 batches as JavaScript SDK 11.17 sends them, scrubbed to the
   * fields that name and count them.
   */
  const traceId = "157b82a784834ab18d36e980edb751fe";
  const typed = (values: Record<string, string | number>) =>
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        { type: typeof value === "string" ? "string" : "integer", value },
      ]),
    );
  /** A server request segment with no route, as wrangler, Bun, and Deno send it. */
  const urlOnlyServerSpan = (name: string, url: string) => {
    const { pathname, search } = new URL(url);
    return {
      trace_id: traceId,
      span_id: "9a1cd869a0664ca7",
      name,
      is_segment: true,
      start_timestamp: 1_795_504_185.1,
      end_timestamp: 1_795_504_185.103,
      status: "ok",
      attributes: typed({
        "sentry.op": "http.server",
        "http.request.method": "GET",
        "url.full": url,
        "url.path": pathname,
        ...(search ? { "url.query": search.slice(1) } : {}),
        "server.address": "localhost",
        "http.response.status_code": 200,
        "sentry.segment.name": name,
        "sentry.segment.id": "9a1cd869a0664ca7",
      }),
    };
  };
  /** An Express request: the route handler span, then its http.server segment. */
  const expressSpans = [
    {
      trace_id: traceId,
      span_id: "8ee59c0d7492b687",
      parent_span_id: "a3d9718a90f804ea",
      name: "/feedback",
      is_segment: false,
      start_timestamp: 1_795_504_185.1,
      end_timestamp: 1_795_504_185.102,
      attributes: typed({
        "sentry.op": "handler",
        "http.route": "/feedback",
        "sentry.segment.id": "a3d9718a90f804ea",
      }),
    },
    {
      ...urlOnlyServerSpan("GET /feedback", "http://localhost:3105/feedback"),
      span_id: "a3d9718a90f804ea",
      attributes: typed({
        "sentry.op": "http.server",
        "http.request.method": "GET",
        "http.route": "/feedback",
        "url.full": "http://localhost:3105/feedback",
        "url.path": "/feedback",
        "http.response.status_code": 200,
        "sentry.segment.id": "a3d9718a90f804ea",
      }),
    },
  ];
  /** Outgoing `fetch` calls the SDK sends together, each its own segment. */
  const fetchSpans = ["/feedback", "/ok"].map((path, index) => ({
    trace_id: traceId,
    span_id: `81f33854f9ee033${index}`,
    name: "GET localhost",
    is_segment: true,
    start_timestamp: 1_795_504_185.1,
    end_timestamp: 1_795_504_185.13,
    status: "ok",
    attributes: typed({
      "sentry.op": "http.client",
      "http.request.method": "GET",
      "url.full": `http://localhost:3105${path}`,
      "url.path": path,
      "http.response.status_code": 200,
      "sentry.segment.id": `81f33854f9ee033${index}`,
    }),
  }));

  /** The `event list` summary and the tail lines of one span batch. */
  function listAndTail(items: unknown[]) {
    const header = {
      sdk: { name: "sentry.javascript.node", version: "11.17.0" },
    };
    const payload = { items };
    const { title, count } = summarizeEnvelope({
      envelope: [
        { ...header, __spotlight_envelope_id: "test-envelope" },
        [[{ type: "span" }, payload]],
      ],
    });
    const lines = formatItem("span", payload, header, "span").map((l) =>
      stripAnsi(l),
    );
    return { title, count, lines };
  }

  test.each([
    [
      "an Express request and its handler span",
      expressSpans,
      "GET /feedback",
      1,
    ],
    [
      "a request named only by its method",
      [urlOnlyServerSpan("GET", "http://localhost:3107/ok")],
      "GET /ok",
      0,
    ],
    [
      "a request to the root URL named only by its method",
      [urlOnlyServerSpan("GET", "http://localhost:3105/?q=1")],
      "GET /",
      0,
    ],
    [
      "a request to the root URL named by its route",
      [urlOnlyServerSpan("GET /", "http://localhost:3107/?q=1")],
      "GET /",
      0,
    ],
    [
      "outgoing calls named by host",
      fetchSpans,
      "GET localhost:3105/feedback",
      0,
    ],
  ])(
    "event list titles and counts %s like the tail",
    (_case, items, label, others) => {
      const { title, count, lines } = listAndTail(items);
      expect(title).toBe(label);
      expect(lines[0]).toContain(` ${label} [200]`);
      expect(count).toBe(others);
      if (others > 0) {
        expect(lines[0]).toContain(
          `[${others} span${others === 1 ? "" : "s"}]`,
        );
      } else {
        expect(lines[0]).not.toContain("span]");
        expect(lines[0]).not.toContain("spans]");
      }
    },
  );

  test("event list counts every span the tail counts in a mixed batch", () => {
    // The tail prints the Express segment with [1 span] and a lone late
    // span with [+1 span].
    const late = {
      ...expressSpans[0],
      span_id: "7e5166c86d64b307",
      parent_span_id: "f000000000000000",
      attributes: typed({ "sentry.op": "handler" }),
    };
    const { count, lines } = listAndTail([...expressSpans, late]);
    expect(lines.map((line) => line.match(/\[\+?\d+ spans?\]/)?.[0])).toEqual([
      "[1 span]",
      "[+1 span]",
    ]);
    expect(count).toBe(2);
  });
});
