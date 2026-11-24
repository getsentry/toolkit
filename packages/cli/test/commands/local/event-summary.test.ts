import { describe, expect, test } from "vitest";
import { summarizeEnvelope } from "../../../src/commands/local/event-summary.js";
import { goPanicEvent } from "../../fixtures/local-sdk-events.js";

describe("summarizeEnvelope", () => {
  test("summarizes a sentry-go event with a plain exception list", () => {
    expect(
      summarizeEnvelope({
        envelope: [
          { __spotlight_envelope_id: "test-envelope", sdk: goPanicEvent.sdk },
          [[{ type: "event" }, goPanicEvent]],
        ],
      }),
    ).toMatchObject({
      title: "*errors.errorString: order 7 not found",
    });
  });

  test("cuts a long title so list entries stay small", () => {
    const body = `SELECT ${"column, ".repeat(100)}id FROM orders`;
    const { title } = summarizeEnvelope({
      envelope: [
        { __spotlight_envelope_id: "test-envelope" },
        [[{ type: "log" }, { items: [{ level: "info", body }] }]],
      ],
    });
    expect(title).toHaveLength(200);
    expect(title?.endsWith("…")).toBe(true);
    expect(body.startsWith(title?.slice(0, -1) ?? "")).toBe(true);
  });

  test("drops ANSI colors from a log title", () => {
    const body = "\u001b[35m\u001b[1mGET /boom HTTP/1.1\u001b[0m 500";
    expect(
      summarizeEnvelope({
        envelope: [
          { __spotlight_envelope_id: "test-envelope" },
          [[{ type: "log" }, { items: [{ level: "info", body }] }]],
        ],
      }).title,
    ).toBe("GET /boom HTTP/1.1 500");
  });

  test("keeps a title at the limit as is", () => {
    const message = "x".repeat(200);
    expect(
      summarizeEnvelope({
        envelope: [
          { __spotlight_envelope_id: "test-envelope" },
          [[{ type: "event" }, { message }]],
        ],
      }).title,
    ).toBe(message);
  });

  test("reads a standalone span whose payload is the span itself", () => {
    expect(
      summarizeEnvelope({
        envelope: [
          { __spotlight_envelope_id: "test-envelope" },
          [
            [
              { type: "span" },
              {
                trace_id: "4C79F60C11214EB38604F4AE0781BFB2",
                span_id: "a1b2c3d4e5f60718",
                op: "db.query",
                description: "SELECT * FROM orders",
                start_timestamp: 1_794_947_106.1,
                timestamp: 1_794_947_106.425,
              },
            ],
          ],
        ],
      }),
    ).toEqual({
      type: "span",
      title: "SELECT * FROM orders",
      timestamp: "2026-11-17T20:25:06.425Z",
      traceId: "4c79f60c11214eb38604f4ae0781bfb2",
    });
  });

  test("counts only a real span batch", () => {
    expect(
      summarizeEnvelope({
        envelope: [
          { __spotlight_envelope_id: "test-envelope" },
          [
            [
              { type: "span" },
              {
                items: [
                  { name: "GET /api", end_timestamp: 1_794_947_106 },
                  { name: "SELECT 1", end_timestamp: 1_794_947_107 },
                ],
              },
            ],
          ],
        ],
      }),
    ).toMatchObject({ type: "span", title: "GET /api", count: 2 });
  });

  /** Summary of one envelope whose only item has this type and payload. */
  const summarize = (type: string, payload: Record<string, unknown>) =>
    summarizeEnvelope({
      envelope: [
        { __spotlight_envelope_id: "test-envelope" },
        [[{ type }, payload]],
      ],
    });

  test("titles an Express span batch from its segment root, not a middleware span", () => {
    // @sentry/node with span streaming: the middleware spans end, and are
    // listed, before the http.server segment that holds them.
    const traceId = "4c79f60c11214eb38604f4ae0781bfb2";
    expect(
      summarize("span", {
        items: [
          {
            trace_id: traceId,
            span_id: "b000000000000002",
            parent_span_id: "a000000000000001",
            name: "<anonymous>",
            is_segment: false,
            end_timestamp: 1_794_947_106.2,
          },
          {
            trace_id: traceId,
            span_id: "b000000000000003",
            parent_span_id: "a000000000000001",
            name: "jsonParser",
            is_segment: false,
            end_timestamp: 1_794_947_106.3,
          },
          {
            trace_id: traceId,
            span_id: "a000000000000001",
            name: "GET /api/hello",
            is_segment: true,
            end_timestamp: 1_794_947_106.425,
          },
        ],
      }),
    ).toEqual({
      type: "span",
      title: "GET /api/hello",
      timestamp: "2026-11-17T20:25:06.425Z",
      traceId,
      count: 3,
    });
  });

  test("titles a span batch from the span with no parent in the batch", () => {
    // Hono with span streaming and no is_segment flag on the spans.
    expect(
      summarize("span", {
        items: [
          { span_id: "c3", parent_span_id: "c2", name: "grandchild" },
          { span_id: "c2", parent_span_id: "c1", name: "child" },
          { span_id: "c1", parent_span_id: "f0", name: "GET /spans" },
        ],
      }).title,
    ).toBe("GET /spans");
  });

  test("labels a log batch with its most severe log", () => {
    expect(
      summarize("log", {
        items: [
          { level: "info", body: "Loaded cart", timestamp: 1_794_947_106 },
          {
            level: "error",
            body: "Payment declined",
            timestamp: 1_794_947_107,
          },
          { level: "warn", body: "Retrying", timestamp: 1_794_947_108 },
        ],
      }),
    ).toMatchObject({
      type: "log",
      level: "error",
      title: "Payment declined",
      timestamp: "2026-11-17T20:25:07.000Z",
      count: 3,
    });
  });

  test("ranks warn and warning logs the same", () => {
    expect(
      summarize("log", {
        items: [
          { level: "warn", body: "Retrying", timestamp: 1_794_947_106 },
          { level: "warning", body: "Disk low", timestamp: 1_794_947_107 },
        ],
      }).title,
    ).toBe("Retrying");
  });

  test("titles feedback with its message, not the request it came from", () => {
    // @sentry/node 11 `captureFeedback` inside an Express route: the SDK also
    // sets `transaction` to the route.
    const feedback = {
      type: "feedback",
      level: "info",
      platform: "node",
      transaction: "GET /feedback",
      timestamp: 1_795_504_185.135,
      contexts: {
        trace: { trace_id: "157b82a784834ab18d36e980edb751fe" },
        feedback: {
          contact_email: "jane@example.com",
          name: "Jane",
          message: "The checkout button does nothing",
        },
      },
    };
    expect(summarize("feedback", feedback)).toMatchObject({
      type: "feedback",
      title: "The checkout button does nothing",
    });
    // Cloudflare, Bun, and Deno send no `transaction`.
    const { transaction: _, ...workerFeedback } = feedback;
    expect(summarize("feedback", workerFeedback).title).toBe(
      "The checkout button does nothing",
    );
    const long = "y".repeat(300);
    expect(
      summarize("feedback", { contexts: { feedback: { message: long } } })
        .title,
    ).toBe(`${"y".repeat(199)}…`);
    // A blank message falls back like a missing one.
    expect(
      summarize("feedback", {
        ...feedback,
        contexts: { feedback: { message: "  \n " } },
      }).title,
    ).toBe("GET /feedback");
  });

  test("cuts a long title without splitting an emoji", () => {
    const title = (prefix: number) =>
      summarize("event", { message: `${"x".repeat(prefix)}🐛 broke` }).title;
    expect(title(197)).toBe(`${"x".repeat(197)}🐛…`);
    // The emoji would end past the limit, so the cut leaves all of it out.
    expect(title(198)).toBe(`${"x".repeat(198)}…`);
  });

  test("titles session aggregates like the viewer", () => {
    expect(
      summarize("sessions", {
        attrs: { release: "web@1.0.0" },
        aggregates: [
          { started: "2026-11-17T20:25:00Z", exited: 4 },
          { started: "2026-11-17T20:26:00Z", exited: 1, errored: 2 },
        ],
      }).title,
    ).toBe("Session counts: 5 exited, 2 errored");
  });

  test("reads timestamps the way the tail does", () => {
    const timestampOf = (timestamp: unknown) =>
      summarizeEnvelope({
        envelope: [
          { __spotlight_envelope_id: "test-envelope" },
          [[{ type: "event" }, { message: "hi", timestamp }]],
        ],
      }).timestamp;
    // Numeric strings are epoch seconds.
    expect(timestampOf("1794947106.425134")).toBe("2026-11-17T20:25:06.425Z");
    // A time with no timezone is UTC, not the host's local time.
    expect(timestampOf("2026-11-17T20:25:06.425134")).toBe(
      "2026-11-17T20:25:06.425Z",
    );
    expect(timestampOf("2026-11-17T20:25:06.425134+00:00")).toBe(
      "2026-11-17T20:25:06.425Z",
    );
    expect(timestampOf("not a time")).toBeUndefined();
  });

  test("labels events like the tail", () => {
    const summaryOf = (payload: Record<string, unknown>) =>
      summarizeEnvelope({
        envelope: [
          { __spotlight_envelope_id: "test-envelope" },
          [[{ type: "event" }, payload]],
        ],
      });
    expect(
      summaryOf({
        exception: {
          values: [{ type: "TypeError", value: "x is not a function" }],
        },
      }),
    ).toMatchObject({
      type: "error",
      level: "error",
      title: "TypeError: x is not a function",
    });
    expect(summaryOf({ level: "warning", message: "Hello" })).toMatchObject({
      type: "message",
      level: "warning",
      title: "Hello",
    });
    expect(summaryOf({})).toMatchObject({
      type: "error",
      level: "error",
      title: "Error: Unknown error",
    });
  });
});
