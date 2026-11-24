/**
 * Tail labels for items a Next.js app sends from the browser with JavaScript
 * SDK 11: streamed spans and logs (which carry no platform or runtime), page
 * URLs on custom spans, anonymous and native stack frames, and replay
 * segments. Next.js uses one SDK name on both sides, so these items have to be
 * placed by what they carry.
 */

import { gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { createReceiverEnvelope } from "../../../src/commands/local/envelope.js";
import {
  createReplayTracker,
  formatEnvelopeLines,
  formatEnvelopeLinesJson,
  formatErrorItem,
  formatItem,
  formatItemJson,
} from "../../../src/lib/formatters/local.js";
import { stripAnsi } from "../../../src/lib/formatters/plain-detect.js";

const TRACE_ID = "3deb203c4ee144c8bb6104076eabc7f4";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const nextjsHeader = {
  sdk: { name: "sentry.javascript.nextjs", version: "11.14.0" },
};

type Value = string | number | boolean;

function attributes(values: Record<string, Value>) {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      { type: typeof value === "string" ? "string" : "double", value },
    ]),
  );
}

/** A streamed span as the browser SDK sends it; `httpcontext` adds the user agent and page URL. */
function browserSpan(name: string, values: Record<string, Value>) {
  return {
    trace_id: TRACE_ID,
    span_id: "a39103452fcf4abc",
    name,
    start_timestamp: 1_794_949_298.4,
    end_timestamp: 1_794_949_298.7,
    is_segment: true,
    status: "ok",
    attributes: attributes({
      "sentry.sdk.name": "sentry.javascript.nextjs",
      "user_agent.original": USER_AGENT,
      "sentry.is_localhost": true,
      "url.full": "http://localhost:3000/client",
      ...values,
    }),
  };
}

/** A route handler's server span: the server SDK sets the user agent too. */
const serverRequestSpan = {
  trace_id: TRACE_ID,
  span_id: "b39103452fcf4abc",
  name: "GET /api/orders",
  start_timestamp: 1_794_949_299,
  end_timestamp: 1_794_949_299.05,
  is_segment: true,
  status: "ok",
  attributes: attributes({
    "sentry.op": "http.server",
    "sentry.origin": "auto.http.otel.http",
    "http.request.method": "GET",
    "http.route": "/api/orders",
    "http.response.status_code": 200,
    "user_agent.original": USER_AGENT,
  }),
};

function tail(itemType: string, payload: Record<string, unknown>): string[] {
  return formatItem(itemType, payload, nextjsHeader, itemType).map((line) =>
    stripAnsi(line),
  );
}

function jsonSource(itemType: string, payload: Record<string, unknown>) {
  const [line] = formatItemJson(itemType, payload, nextjsHeader);
  return (JSON.parse(line ?? "{}") as { source?: string }).source;
}

describe("Next.js browser spans and logs", () => {
  test.each([
    ["pageload", "/client", { "sentry.op": "pageload" }],
    ["navigation", "/cart", { "sentry.op": "navigation" }],
    ["custom ui.action", "checkout flow", { "sentry.op": "ui.action" }],
    [
      "fetch",
      "GET http://localhost:3000/api/orders",
      {
        "sentry.op": "http.client",
        "sentry.origin": "auto.http.browser",
        "http.request.method": "GET",
      },
    ],
  ])("a %s span is tagged [BROWSER]", (_kind, name, values) => {
    const payload = { items: [browserSpan(name, values)] };
    expect(tail("span", payload)[0]).toContain("[BROWSER]");
    expect(jsonSource("span", payload)).toBe("browser");
  });

  test("late spans of a browser pageload are tagged [BROWSER]", () => {
    const lateSpan = (span_id: string, file: string) => ({
      ...browserSpan(file, {
        "sentry.op": "resource.script",
        "url.full": `http://localhost:3000/_next/static/chunks/${file}`,
        "sentry.segment.id": "a39103452fcf4abc",
        "sentry.segment.name": "/client",
      }),
      span_id,
      parent_span_id: "a39103452fcf4abc",
      is_segment: false,
    });
    const payload = {
      items: [
        lateSpan("c000000000000001", "main.js"),
        lateSpan("c000000000000002", "app.js"),
      ],
    };
    const lines = tail("span", payload);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[BROWSER] /client [+2 spans]");
  });

  test("a server request span with a user agent stays [SERVER]", () => {
    const payload = { items: [serverRequestSpan] };
    expect(tail("span", payload)[0]).toContain("[SERVER]");
    expect(jsonSource("span", payload)).toBe("server");
  });

  test("a log batch recorded during a replay is tagged [BROWSER]", () => {
    const payload = {
      items: [
        {
          level: "info",
          body: "client clicked",
          timestamp: 1_794_949_300,
          attributes: attributes({
            button: "log",
            "sentry.sdk.name": "sentry.javascript.nextjs",
            "sentry.replay_id": "4d1c5b0e9a3f4c7e8b2a6f1d0c9e8b7a",
          }),
        },
      ],
    };
    expect(tail("log", payload)[0]).toContain(
      "[BROWSER] client clicked [button=log]",
    );
    expect(jsonSource("log", payload)).toBe("browser");
  });

  describe("server-only SDKs ignore browser hints", () => {
    const nodeHeader = {
      sdk: { name: "sentry.javascript.node", version: "11.14.0" },
    };
    const lines = (
      header: Record<string, unknown>,
      itemType: string,
      payload: Record<string, unknown>,
    ) =>
      formatItem(itemType, payload, header, itemType).map((line) =>
        stripAnsi(line),
      );

    test("a Node log with a user agent stays [SERVER]", () => {
      const payload = {
        items: [
          {
            level: "info",
            body: "request handled",
            attributes: attributes({ "user_agent.original": USER_AGENT }),
          },
        ],
      };
      expect(lines(nodeHeader, "log", payload)[0]).toContain("[SERVER]");
    });

    test("a Node span with a custom navigation op stays [SERVER]", () => {
      const span = {
        ...serverRequestSpan,
        name: "route change",
        attributes: attributes({ "sentry.op": "navigation" }),
      };
      expect(lines(nodeHeader, "span", { items: [span] })[0]).toContain(
        "[SERVER]",
      );
    });

    test("late Node spans with a navigation op stay [SERVER]", () => {
      const late = (span_id: string) => ({
        ...serverRequestSpan,
        span_id,
        parent_span_id: "a000000000000001",
        is_segment: false,
        attributes: attributes({
          "sentry.op": "navigation",
          "sentry.segment.id": "a000000000000001",
          "sentry.segment.name": "GET /orders",
        }),
      });
      const payload = {
        items: [late("c000000000000001"), late("c000000000000002")],
      };
      expect(lines(nodeHeader, "span", payload)[0]).toContain(
        "[SERVER]  GET /orders [+2 spans]",
      );
    });

    test("a Next.js server function span with a user agent stays [SERVER]", () => {
      const span = {
        ...serverRequestSpan,
        name: "generateMetadata",
        attributes: attributes({
          "sentry.op": "function.nextjs",
          "sentry.origin": "auto.function.nextjs",
          "user_agent.original": USER_AGENT,
        }),
      };
      expect(tail("span", { items: [span] })[0]).toContain("[SERVER]");
      expect(jsonSource("span", { items: [span] })).toBe("server");
    });
  });

  test("a server log stays [SERVER]", () => {
    const payload = {
      items: [
        {
          level: "info",
          body: "order saved",
          attributes: attributes({ "server.address": "dev-laptop" }),
        },
      ],
    };
    expect(tail("log", payload)[0]).toContain("[SERVER]");
  });
});

describe("page URL on browser spans", () => {
  /** The JSON label for a span batch, which the tail line should agree with. */
  function jsonLabel(payload: Record<string, unknown>) {
    const [line] = formatItemJson("span", payload, nextjsHeader);
    return (JSON.parse(line ?? "{}") as { label?: string }).label;
  }

  /** A browser segment as `startSpan` sends it, with or without a name or op. */
  function customSpan(name: string | undefined, values: Record<string, Value>) {
    const { name: _name, ...span } = browserSpan("", {
      "url.full": "http://localhost:3000/cart",
      ...values,
    });
    return name === undefined ? span : { ...span, name };
  }

  test.each([
    [
      "an op-less custom span keeps its name",
      "checkout-submit",
      {},
      "checkout-submit",
    ],
    [
      "an op-less custom span with a URL path keeps its name",
      "checkout-submit",
      { "url.path": "/cart" },
      "checkout-submit",
    ],
    [
      "an op-less custom span with a route keeps its name",
      "checkout-submit",
      { "http.route": "/cart/:id" },
      "checkout-submit",
    ],
    [
      "an op-less custom span with a server address keeps its name",
      "checkout-submit",
      { "server.address": "localhost", "server.port": 3000 },
      "checkout-submit",
    ],
    [
      "a custom span with a named op keeps its name",
      "checkout flow",
      { "sentry.op": "ui.action" },
      "checkout flow",
    ],
    [
      "an op-less span with no name uses the URL",
      undefined,
      {},
      "localhost:3000/cart",
    ],
    ["an op-less custom span named trace keeps its name", "trace", {}, "trace"],
    ["an op-less custom span named get keeps its name", "get", {}, "get"],
    [
      "an op-less custom span named connect keeps its name",
      "connect",
      {},
      "connect",
    ],
    [
      "a lowercase method word beats a URL path too",
      "delete",
      { "url.path": "/cart" },
      "delete",
    ],
    [
      "an op-less span named only a method uses the URL",
      "GET",
      {},
      "localhost:3000/cart",
    ],
    [
      "an op-less span named its URL uses the URL",
      "http://localhost:3000/cart",
      {},
      "localhost:3000/cart",
    ],
    [
      "a nameless span with an exception uses the exception type",
      undefined,
      { "url.full": "", "exception.type": "TypeError" },
      "TypeError",
    ],
    [
      "a nameless span with only an HTTP method shows the method",
      undefined,
      { "url.full": "", "http.request.method": "GET" },
      "GET",
    ],
    [
      "an op-less span with an HTTP method uses the URL",
      "submit",
      { "http.request.method": "POST" },
      "POST localhost:3000/cart",
    ],
    [
      "an http.client span uses the URL",
      "GET http://localhost:3000/api/orders",
      {
        "sentry.op": "http.client",
        "http.request.method": "GET",
        "url.full": "http://localhost:3000/api/orders",
      },
      "GET localhost:3000/api/orders",
    ],
    [
      "a resource span uses the URL",
      "localhost",
      {
        "sentry.op": "resource.script",
        "url.full": "http://localhost:3000/_next/static/chunks/main.js",
      },
      "localhost:3000/_next/static/chunks/main.js",
    ],
  ])("%s, in the tail and in JSON", (_case, name, values, label) => {
    const payload = { items: [customSpan(name, values)] };
    expect(tail("span", payload)[0]).toContain(` ${label} `);
    expect(jsonLabel(payload)).toBe(label);
  });

  test("a custom span keeps its name instead of the page URL", () => {
    const payload = {
      items: [browserSpan("checkout flow", { "sentry.op": "ui.action" })],
    };
    const [line] = tail("span", payload);
    expect(line).toContain("[ui.action] checkout flow");
    expect(line).not.toContain("localhost:3000/client");
  });

  test("a pageload keeps its route name", () => {
    const payload = {
      items: [browserSpan("/client", { "sentry.op": "pageload" })],
    };
    expect(tail("span", payload)[0]).toContain("[pageload] /client");
  });

  test("a resource span is still named by its URL", () => {
    const payload = {
      items: [
        browserSpan("localhost", {
          "sentry.op": "resource.script",
          "url.full": "http://localhost:3000/_next/static/chunks/main.js",
        }),
      ],
    };
    expect(tail("span", payload)[0]).toContain(
      "localhost:3000/_next/static/chunks/main.js",
    );
  });
});

describe("frame hints", () => {
  const errorWithFrames = (frames: Record<string, unknown>[]) => ({
    exception: {
      values: [
        {
          type: "SyntaxError",
          value: "Unexpected token",
          stacktrace: { frames },
        },
      ],
    },
    platform: "javascript",
  });

  test("leave out an anonymous function name", () => {
    const line = stripAnsi(
      formatErrorItem(
        errorWithFrames([
          {
            filename: "app:///_next/static/chunks/app_client_page_tsx.js",
            function: "?",
            lineno: 12,
            colno: 9,
            in_app: true,
          },
        ]),
        nextjsHeader,
      ),
    );
    expect(line).toContain(
      "[app:///_next/static/chunks/app_client_page_tsx.js:12:9]",
    );
    expect(line).not.toContain("[?]");
  });

  test("skip a native frame for the app frame that called it", () => {
    const event = errorWithFrames([
      {
        filename: "app:///_next/static/chunks/app_client_page_tsx.js",
        function: "parseOrder",
        lineno: 30,
        colno: 17,
        in_app: true,
      },
      // `at JSON.parse (<anonymous>)`: the browser SDK marks it in app.
      { filename: "<anonymous>", function: "JSON.parse", in_app: true },
    ]);
    const line = stripAnsi(formatErrorItem(event, nextjsHeader));
    expect(line).toContain("[parseOrder]");
    expect(line).not.toContain("JSON.parse");
    const [json] = formatItemJson("event", event, nextjsHeader);
    expect(JSON.parse(json ?? "{}")).toMatchObject({
      function: "parseOrder",
      lineno: 30,
    });
  });
});

describe("session replays", () => {
  const replayId = "4d1c5b0e9a3f4c7e8b2a6f1d0c9e8b7a";
  const replayEvent = (segment_id: number, urls: string[]) => ({
    type: "replay_event",
    replay_id: replayId,
    event_id: replayId,
    replay_type: "session",
    segment_id,
    timestamp: 1_794_949_301,
    urls,
    platform: "javascript",
  });

  /** A parsed replay envelope: a replay_event and its recording. */
  const replayEnvelope = (segment_id: number, urls: string[]) => ({
    getParsedEnvelope: () => ({
      envelope: [
        nextjsHeader,
        [
          [{ type: "replay_event" }, replayEvent(segment_id, urls)],
          [{ type: "replay_recording" }, { segment_id }],
        ],
      ] as [Record<string, unknown>, [{ type?: string }, unknown][]],
    }),
    getContentType: () => "application/x-sentry-envelope",
    getEventTypes: () => ["replay_event", "replay_recording"],
  });

  test("the first segment prints one line with the replay ID and page", () => {
    const lines = formatEnvelopeLines(
      replayEnvelope(0, ["http://localhost:3000/client"]),
      new Set(),
      false,
      createReplayTracker(),
    ).map((line) => stripAnsi(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[REPLAY]");
    expect(lines[0]).toContain("[BROWSER]");
    expect(lines[0]).toContain(
      "replay 4d1c5b0e http://localhost:3000/client [from segment 0]",
    );
  });

  test("later segments of a replay already shown print nothing", () => {
    const replays = createReplayTracker();
    formatEnvelopeLines(replayEnvelope(0, []), new Set(), false, replays);
    expect(
      formatEnvelopeLines(replayEnvelope(1, []), new Set(), false, replays),
    ).toEqual([]);
  });

  test("a tail that starts mid-replay prints the first segment it sees", () => {
    const replays = createReplayTracker();
    const envelope = replayEnvelope(7, ["http://localhost:3000/cart"]);
    const lines = formatEnvelopeLines(envelope, new Set(), false, replays).map(
      (line) => stripAnsi(line),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(
      "replay 4d1c5b0e http://localhost:3000/cart [from segment 7]",
    );
    expect(formatEnvelopeLines(envelope, new Set(), false, replays)).toEqual(
      [],
    );
  });

  /**
   * A replay segment as the browser SDK sends it, decoded by the receiver:
   * the recording is `{"segment_id":N}` and gzip rrweb events, kept as base64.
   */
  const receivedSegment = (segment_id: number) => {
    const recording = Buffer.concat([
      Buffer.from(`${JSON.stringify({ segment_id })}\n`),
      gzipSync(JSON.stringify([{ type: 3, timestamp: 1_794_949_301_000 }])),
    ]);
    return createReceiverEnvelope({
      body: Buffer.concat([
        Buffer.from(
          [
            JSON.stringify({
              event_id: replayId,
              sent_at: "2026-11-19T07:01:41.000Z",
              sdk: { name: "sentry.javascript.react", version: "11.17.0" },
            }),
            JSON.stringify({ type: "replay_event" }),
            JSON.stringify(
              replayEvent(
                segment_id,
                segment_id === 0 ? ["http://localhost:5173/"] : [],
              ),
            ),
            JSON.stringify({
              type: "replay_recording",
              length: recording.length,
            }),
            "",
          ].join("\n"),
        ),
        recording,
      ]),
    });
  };

  test("JSON has one record per segment item with its replay and segment", () => {
    const records = [0, 1, 2].flatMap((segment) =>
      formatEnvelopeLinesJson(receivedSegment(segment), new Set()).map(
        (line) => JSON.parse(line) as Record<string, unknown>,
      ),
    );
    expect(
      records.map(({ type, replay_id, segment_id }) => ({
        type,
        replay_id,
        segment_id,
      })),
    ).toEqual(
      [0, 1, 2].flatMap((segment_id) =>
        ["replay_event", "replay_recording"].map((type) => ({
          type,
          replay_id: replayId,
          segment_id,
        })),
      ),
    );
    expect(records[0]).toMatchObject({
      event_id: replayId,
      timestamp: 1_794_949_301,
    });
  });

  test("JSON reads the segment of a recording kept as text", () => {
    // An uncompressed recording with a text content type stays utf8, not base64.
    const recording = `${JSON.stringify({ segment_id: 4 })}\n[{"type":3}]`;
    const envelope = createReceiverEnvelope({
      body: Buffer.from(
        [
          JSON.stringify({ event_id: replayId }),
          JSON.stringify({
            type: "replay_recording",
            length: Buffer.byteLength(recording),
            content_type: "application/json",
          }),
          recording,
        ].join("\n"),
      ),
    });
    const [line] = formatEnvelopeLinesJson(envelope, new Set());
    expect(JSON.parse(line ?? "{}")).toMatchObject({
      type: "replay_recording",
      replay_id: replayId,
      segment_id: 4,
    });
  });

  test("each tail tracks its own replays", () => {
    const envelope = replayEnvelope(3, []);
    for (const replays of [createReplayTracker(), createReplayTracker()]) {
      expect(
        formatEnvelopeLines(envelope, new Set(), false, replays),
      ).toHaveLength(1);
    }
  });
});
