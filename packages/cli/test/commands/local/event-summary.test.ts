import { describe, expect, test } from "vitest";
import { summarizeEnvelope } from "../../../src/commands/local/event-summary.js";

describe("summarizeEnvelope", () => {
  test("cuts a long title so list entries stay small", () => {
    const body = `SELECT ${"column, ".repeat(100)}id FROM orders`;
    const { title } = summarizeEnvelope({
      envelope: [{}, [[{ type: "log" }, { items: [{ level: "info", body }] }]]],
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
          {},
          [[{ type: "log" }, { items: [{ level: "info", body }] }]],
        ],
      }).title,
    ).toBe("GET /boom HTTP/1.1 500");
  });

  test("keeps a title at the limit as is", () => {
    const message = "x".repeat(200);
    expect(
      summarizeEnvelope({
        envelope: [{}, [[{ type: "event" }, { message }]]],
      }).title,
    ).toBe(message);
  });

  test("reads a standalone span whose payload is the span itself", () => {
    expect(
      summarizeEnvelope({
        envelope: [
          {},
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
          {},
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

  test("reads timestamps the way the tail does", () => {
    const timestampOf = (timestamp: unknown) =>
      summarizeEnvelope({
        envelope: [{}, [[{ type: "event" }, { message: "hi", timestamp }]]],
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
      summarizeEnvelope({ envelope: [{}, [[{ type: "event" }, payload]]] });
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
