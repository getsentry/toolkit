import { describe, expect, test } from "vitest";
import {
  DEFAULT_STREAM_URL,
  decodeEnvelope,
  parseStreamEndpoint,
  getPreferredStreamUrl,
  resolveInitialStreamUrl,
  getStreamUrlFromHash,
  getStreamUrlFromQuery,
  getStreamUrlFromStorage,
} from "./spotlight.js";

describe("getStreamUrlFromHash", () => {
  test("classifies the default stream as loopback", () => {
    expect(DEFAULT_STREAM_URL).toBe("http://localhost:8969/stream");
    expect(parseStreamEndpoint(DEFAULT_STREAM_URL)).toEqual({
      url: DEFAULT_STREAM_URL,
      kind: "loopback",
    });
  });

  test("accepts an HTTPS remote stream with a query token", () => {
    expect(
      parseStreamEndpoint("https://receiver.example/stream?token=abc"),
    ).toEqual({
      url: "https://receiver.example/stream?token=abc",
      kind: "remote",
    });
  });

  test.each([
    "http://receiver.example/stream",
    "https://user:pass@receiver.example/stream",
    "https://receiver.example/other",
    "https://receiver.example/stream#fragment",
  ])("rejects unsafe custom endpoint %s", (url) => {
    expect(parseStreamEndpoint(url)).toBeUndefined();
  });

  test("accepts a loopback stream URL", () => {
    expect(
      getStreamUrlFromHash("#stream=http%3A%2F%2Flocalhost%3A8969%2Fstream"),
    ).toBe("http://localhost:8969/stream");
  });

  test("accepts a loopback daemon session stream with a read capability", () => {
    const url =
      "http://127.0.0.1:8969/_local/v1/sessions/session/stream?cap=read";
    expect(parseStreamEndpoint(url)).toEqual({ url, kind: "loopback" });
  });

  test("rejects a non-loopback stream URL", () => {
    expect(
      getStreamUrlFromHash("#stream=http%3A%2F%2Fexample.com%2Fstream"),
    ).toBeUndefined();
  });

  test("restores a valid saved loopback stream URL", () => {
    expect(getStreamUrlFromStorage("http://127.0.0.1:8969/stream")).toBe(
      "http://127.0.0.1:8969/stream",
    );
  });

  test("rejects a saved non-loopback stream URL", () => {
    expect(
      getStreamUrlFromStorage("http://example.com/stream"),
    ).toBeUndefined();
  });

  test("prefers a fresh CLI fragment over a saved stream URL", () => {
    expect(
      getPreferredStreamUrl(
        "#stream=http%3A%2F%2Flocalhost%3A9000%2Fstream",
        "http://127.0.0.1:8969/stream",
      ),
    ).toBe("http://localhost:9000/stream");
  });

  test("accepts a plain loopback url query over saved connections without accepting credentials or remote targets", () => {
    const query = `?${new URLSearchParams({ url: "http://localhost:9012/stream" })}`;
    expect(getStreamUrlFromQuery(query)).toBe("http://localhost:9012/stream");
    expect(
      resolveInitialStreamUrl("", "http://localhost:8969/stream", null, query),
    ).toBe("http://localhost:9012/stream");
    for (const target of [
      "https://evil.example/stream",
      "http://user:password@localhost:9012/stream",
      "http://localhost:9012/_local/v1/sessions/web/stream?cap=secret",
      "http://localhost:9012/stream?token=secret",
    ]) {
      expect(
        getStreamUrlFromQuery(`?${new URLSearchParams({ url: target })}`),
      ).toBeUndefined();
    }
  });

  test("uses CLI pairing, saved endpoints, then the default in priority order", () => {
    expect(
      resolveInitialStreamUrl(
        "#stream=http%3A%2F%2Flocalhost%3A9000%2Fstream",
        null,
        null,
      ),
    ).toBe("http://localhost:9000/stream");
    expect(
      resolveInitialStreamUrl("", "http://127.0.0.1:8970/stream", null),
    ).toBe("http://127.0.0.1:8970/stream");
    expect(resolveInitialStreamUrl("", null, null)).toBe(DEFAULT_STREAM_URL);
  });
});

describe("decodeEnvelope", () => {
  test("unpacks batched span and log items from the Local receiver", () => {
    expect(
      decodeEnvelope(
        '[{},[[{"type":"span"},{"version":2,"items":[{"trace_id":"trace-123","span_id":"span-456","parent_span_id":"root-span","name":"agent.run","start_timestamp":1700000000,"end_timestamp":1700000000.004,"attributes":{"sentry.op":{"value":"gen_ai.invoke_agent","type":"string"}}}]}],[{"type":"log"},{"version":2,"items":[{"trace_id":"trace-123","timestamp":1700000000.005,"level":"error","body":"Fixture request failed"}]}]]]',
        "event-1",
      ),
    ).toMatchObject([
      {
        id: "event-1:0",
        type: "span",
        timestamp: 1700000000.004,
        metadata: {
          title: "agent.run",
          traceId: "trace-123",
          spanId: "span-456",
          operation: "gen_ai.invoke_agent",
          durationMs: 4,
        },
      },
      {
        id: "event-1:1",
        type: "log",
        timestamp: 1700000000.005,
        metadata: {
          title: "Fixture request failed",
          traceId: "trace-123",
          level: "error",
        },
      },
    ]);
  });

  test("describes standalone spans and logs with their own payload fields", () => {
    expect(
      decodeEnvelope(
        '[{},[[{"type":"span"},{"trace_id":"trace-123","span_id":"span-456","op":"db.query","description":"SELECT * FROM orders","start_timestamp":1700000000,"timestamp":1700000000.004}],[{"type":"log"},{"trace_id":"trace-123","level":"error","body":"Inventory lookup failed","timestamp":1700000000.005}]]]',
        "event-1",
      ),
    ).toMatchObject([
      {
        type: "span",
        metadata: {
          title: "SELECT * FROM orders",
          traceId: "trace-123",
          spanId: "span-456",
          operation: "db.query",
          durationMs: 4,
        },
      },
      {
        type: "log",
        metadata: {
          title: "Inventory lookup failed",
          traceId: "trace-123",
          level: "error",
        },
      },
    ]);
  });

  test("keeps the decoded payload available for trace views", () => {
    const [item] = decodeEnvelope(
      '[{},[[{"type":"transaction"},{"transaction":"GET /orders/42","contexts":{"trace":{"trace_id":"trace-123","span_id":"root-span"}},"spans":[{"span_id":"db-span","parent_span_id":"root-span","op":"db.query","description":"SELECT * FROM orders","start_timestamp":1700000000.001,"timestamp":1700000000.003}]}]]]',
      "event-1",
    );

    expect((item as { payload?: unknown }).payload).toEqual({
      transaction: "GET /orders/42",
      contexts: { trace: { trace_id: "trace-123", span_id: "root-span" } },
      spans: [
        {
          span_id: "db-span",
          parent_span_id: "root-span",
          op: "db.query",
          description: "SELECT * FROM orders",
          start_timestamp: 1700000000.001,
          timestamp: 1700000000.003,
        },
      ],
    });
  });

  test("turns envelope items into displayable feed entries", () => {
    expect(
      decodeEnvelope(
        '[{"sdk":{"name":"sentry.node"}},[[{"type":"transaction"},{"transaction":"GET /api/users/42","start_timestamp":1700000000,"timestamp":1700000000.00668,"contexts":{"trace":{"trace_id":"trace-123","span_id":"span-456","op":"http.server","data":{"http.method":"GET","http.url":"http://127.0.0.1:3030/api/users/42","http.response.status_code":200,"sentry.origin":"auto.http.otel.http"}}}}]]]',
        "event-1",
      ),
    ).toEqual([
      {
        id: "event-1:0",
        type: "transaction",
        timestamp: 1700000000.00668,
        metadata: {
          title: "GET /api/users/42",
          method: "GET",
          route: "/api/users/42",
          statusCode: 200,
          durationMs: 6.68,
          traceId: "trace-123",
          spanId: "span-456",
          operation: "http.server",
          origin: "auto.http.otel.http",
        },
        text: '{\n  "transaction": "GET /api/users/42",\n  "start_timestamp": 1700000000,\n  "timestamp": 1700000000.00668,\n  "contexts": {\n    "trace": {\n      "trace_id": "trace-123",\n      "span_id": "span-456",\n      "op": "http.server",\n      "data": {\n        "http.method": "GET",\n        "http.url": "http://127.0.0.1:3030/api/users/42",\n        "http.response.status_code": 200,\n        "sentry.origin": "auto.http.otel.http"\n      }\n    }\n  }\n}',
        payload: {
          transaction: "GET /api/users/42",
          start_timestamp: 1700000000,
          timestamp: 1700000000.00668,
          contexts: {
            trace: {
              trace_id: "trace-123",
              span_id: "span-456",
              op: "http.server",
              data: {
                "http.method": "GET",
                "http.url": "http://127.0.0.1:3030/api/users/42",
                "http.response.status_code": 200,
                "sentry.origin": "auto.http.otel.http",
              },
            },
          },
        },
      },
    ]);
  });

  test("rejects malformed envelopes", () => {
    expect(() => decodeEnvelope("not json", "event-1")).toThrow(
      "Invalid Sentry envelope",
    );
  });
});
