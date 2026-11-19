/**
 * Tail and NDJSON output for envelopes shaped like the ones real SDKs send to
 * `sentry local`: sentry-python messages and logging events, JavaScript SDK
 * messages with a synthetic stack, Next.js browser and server events, and a
 * Hono app on Cloudflare Workers.
 */

import { describe, expect, test } from "vitest";
import {
  formatAttributeTable,
  formatItem,
  formatItemJson,
} from "../../../src/lib/formatters/local.js";
import { stripAnsi } from "../../../src/lib/formatters/plain-detect.js";

const TRACE_ID = "4c79f60c11214eb38604f4ae0781bfb2";

/** One tail line for an event item, without colors. */
function tail(
  payload: Record<string, unknown>,
  header: Record<string, unknown>,
): string {
  const lines = formatItem("event", payload, header, "event");
  expect(lines).toHaveLength(1);
  return stripAnsi(lines[0] ?? "");
}

/** The NDJSON record for an event item. */
function json(
  payload: Record<string, unknown>,
  header: Record<string, unknown>,
): Record<string, unknown> {
  const lines = formatItemJson("event", payload, header);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
}

const pythonHeader = {
  event_id: "9ec79c33ec9942ab8353589fcb2e04dc",
  sent_at: "2026-11-17T10:00:00.120000Z",
  sdk: { name: "sentry.python.flask", version: "2.42.0" },
};

/** `logging.error("Payment failed for order %s", 42)` with the logging integration. */
const pythonLoggingEvent = {
  event_id: "9ec79c33ec9942ab8353589fcb2e04dc",
  level: "error",
  logger: "shop.payments",
  logentry: {
    message: "Payment failed for order %s",
    params: [42],
    formatted: "Payment failed for order 42",
  },
  platform: "python",
  timestamp: "2026-11-17T10:00:00.100000Z",
  contexts: {
    runtime: { name: "CPython", version: "3.12.4" },
    trace: { trace_id: TRACE_ID, span_id: "a7e1f3b5c9d2e4f6" },
  },
  sdk: { name: "sentry.python.flask", version: "2.42.0" },
};

/** `sentry_sdk.capture_message("Hello from capture_message", level="warning")`. */
const pythonMessageEvent = {
  event_id: "1f2e3d4c5b6a49788796a5b4c3d2e1f0",
  level: "warning",
  message: "Hello from capture_message",
  platform: "python",
  timestamp: "2026-11-17T10:00:01.000000Z",
  contexts: { runtime: { name: "CPython", version: "3.12.4" } },
  sdk: { name: "sentry.python.flask", version: "2.42.0" },
};

const nextjsHeader = {
  event_id: "b1c2d3e4f5a64b7c8d9e0f1a2b3c4d5e",
  sent_at: "2026-11-17T10:00:02.000Z",
  sdk: { name: "sentry.javascript.nextjs", version: "11.0.0" },
};

/** Oldest to newest, as SDKs send them: React's dispatcher first, the click handler last. */
const browserClickFrames = [
  {
    filename:
      "app:///_next/static/chunks/node_modules_next_dist_compiled_react-dom_client.js",
    function: "dispatchDiscreteEvent",
    lineno: 18512,
    colno: 7,
    in_app: true,
  },
  {
    filename: "app:///_next/static/chunks/app_page_tsx.js",
    function: "onClick",
    lineno: 24,
    colno: 19,
    in_app: true,
  },
];

/**
 * `Sentry.captureMessage("Hello from captureMessage", "warning")` in a
 * Next.js page. With `attachStacktrace`, JavaScript SDK 11 adds a synthetic
 * exception that has a value and a stack but no type.
 */
const nextjsBrowserMessage = {
  event_id: "b1c2d3e4f5a64b7c8d9e0f1a2b3c4d5e",
  level: "warning",
  message: "Hello from captureMessage",
  exception: {
    values: [
      {
        value: "Hello from captureMessage",
        stacktrace: { frames: browserClickFrames },
        mechanism: { type: "generic", handled: true, synthetic: true },
      },
    ],
  },
  platform: "javascript",
  timestamp: 1_794_045_602.123,
  request: {
    url: "http://localhost:3000/",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
  },
  contexts: { trace: { trace_id: TRACE_ID, span_id: "b2c3d4e5f6a7b8c9" } },
  sdk: { name: "sentry.javascript.nextjs", version: "11.0.0" },
};

/** A thrown `Error` in a Next.js client component. */
const nextjsBrowserError = {
  event_id: "c1d2e3f4a5b64c7d8e9f0a1b2c3d4e5f",
  level: "error",
  exception: {
    values: [
      {
        type: "Error",
        value: "Client button exploded",
        stacktrace: { frames: browserClickFrames },
        mechanism: {
          type: "auto.browser.global_handlers.onerror",
          handled: false,
        },
      },
    ],
  },
  platform: "javascript",
  timestamp: 1_794_045_603.5,
  request: {
    url: "http://localhost:3000/",
    headers: { "User-Agent": "Mozilla/5.0" },
  },
  contexts: { trace: { trace_id: TRACE_ID, span_id: "c3d4e5f6a7b8c9d0" } },
  sdk: { name: "sentry.javascript.nextjs", version: "11.0.0" },
};

/** An error thrown in a Next.js route handler on the Node.js runtime. */
const nextjsServerError = {
  event_id: "d1e2f3a4b5c64d7e8f9a0b1c2d3e4f5a",
  level: "error",
  exception: {
    values: [
      {
        type: "TypeError",
        value: "Cannot read properties of undefined (reading 'id')",
        stacktrace: {
          frames: [
            {
              filename: "node:internal/process/task_queues",
              function: "process.processTicksAndRejections",
              lineno: 105,
              colno: 5,
              in_app: false,
            },
            {
              filename: "/app/.next/server/app/api/users/route.js",
              function: "GET",
              lineno: 12,
              colno: 22,
              in_app: true,
            },
            {
              filename: "/app/node_modules/next/dist/server/base-server.js",
              function: "renderToResponse",
              lineno: 900,
              colno: 3,
              in_app: false,
            },
          ],
        },
        mechanism: { type: "auto.function.nextjs", handled: false },
      },
    ],
  },
  platform: "node",
  timestamp: 1_794_045_604.25,
  contexts: {
    runtime: { name: "node", version: "v22.11.0" },
    trace: { trace_id: TRACE_ID, span_id: "d4e5f6a7b8c9d0e1" },
  },
  sdk: { name: "sentry.javascript.nextjs", version: "11.0.0" },
};

const honoHeader = {
  event_id: "e1f2a3b4c5d64e7f8a9b0c1d2e3f4a5b",
  sent_at: "2026-11-17T10:00:05.000Z",
  sdk: { name: "sentry.javascript.hono", version: "11.0.0" },
};

/** An error thrown three calls deep in a Hono route on Cloudflare Workers. */
const honoWorkerError = {
  event_id: "e1f2a3b4c5d64e7f8a9b0c1d2e3f4a5b",
  level: "error",
  exception: {
    values: [
      {
        type: "Error",
        value: "Boom from deepFunction",
        stacktrace: {
          frames: [
            {
              filename: "/index.js",
              function: "dispatch",
              lineno: 410,
              colno: 27,
              in_app: true,
            },
            {
              filename: "/index.js",
              function: "handler",
              lineno: 1203,
              colno: 10,
              in_app: true,
            },
            {
              filename: "/index.js",
              function: "deepFunction",
              lineno: 1190,
              colno: 9,
              in_app: true,
            },
          ],
        },
        mechanism: { type: "auto.faas.hono.error_handler", handled: false },
      },
    ],
  },
  platform: "javascript",
  timestamp: 1_794_045_605.75,
  contexts: {
    runtime: { name: "cloudflare", version: "2025-06-01" },
    cloud_resource: { "cloud.provider": "cloudflare" },
    trace: { trace_id: TRACE_ID, span_id: "e5f6a7b8c9d0e1f2" },
  },
  sdk: { name: "sentry.javascript.hono", version: "11.0.0" },
};

describe("message events", () => {
  test("a JavaScript captureMessage shows its level and text, not an error", () => {
    const line = tail(nextjsBrowserMessage, nextjsHeader);
    expect(line).toContain("[WARNING] [BROWSER] Hello from captureMessage");
    expect(line).not.toContain("[ERROR]");
    expect(line).not.toContain("Error:");

    expect(json(nextjsBrowserMessage, nextjsHeader)).toMatchObject({
      type: "message",
      level: "warning",
      message: "Hello from captureMessage",
      function: "onClick",
      source: "browser",
    });
    expect(json(nextjsBrowserMessage, nextjsHeader)).not.toHaveProperty(
      "error_type",
    );
  });

  test("a Python capture_message shows its level and text", () => {
    const line = tail(pythonMessageEvent, pythonHeader);
    expect(line).toContain("[WARNING] [SERVER]  Hello from capture_message");
    expect(line).not.toContain("Error:");

    expect(json(pythonMessageEvent, pythonHeader)).toMatchObject({
      type: "message",
      level: "warning",
      message: "Hello from capture_message",
      source: "server",
    });
  });

  test("a Python logging event shows the formatted logentry and logger", () => {
    const line = tail(pythonLoggingEvent, pythonHeader);
    expect(line).toContain("[ERROR]   [SERVER]  Payment failed for order 42");
    expect(line).toContain("[logger:shop.payments]");
    expect(line).not.toContain("Unknown error");

    expect(json(pythonLoggingEvent, pythonHeader)).toMatchObject({
      type: "message",
      level: "error",
      message: "Payment failed for order 42",
      logger: "shop.payments",
    });
  });

  test("falls back to the logentry template when it has no formatted text", () => {
    const { formatted: _formatted, ...logentry } = pythonLoggingEvent.logentry;
    const event = { ...pythonLoggingEvent, logentry };
    expect(tail(event, pythonHeader)).toContain("Payment failed for order %s");
  });
});

describe("exception events", () => {
  test("captureException with a string is an Error, not a message", () => {
    // SDK 11 wraps the string in a synthetic exception and fills in the
    // "Error" type (addExceptionTypeValue), so it stays an error record.
    const event = {
      ...nextjsBrowserMessage,
      level: "error",
      message: "Checkout failed",
      exception: {
        values: [
          {
            type: "Error",
            value: "Checkout failed",
            stacktrace: { frames: browserClickFrames },
            mechanism: { type: "generic", handled: true, synthetic: true },
          },
        ],
      },
    };
    expect(tail(event, nextjsHeader)).toContain(
      "[ERROR]   [BROWSER] Error: Checkout failed",
    );
    expect(json(event, nextjsHeader)).toMatchObject({
      type: "error",
      error_type: "Error",
      message: "Checkout failed",
    });
  });

  test("keep the exception type and use the event level", () => {
    const line = tail(nextjsServerError, nextjsHeader);
    expect(line).toContain(
      "[ERROR]   [SERVER]  TypeError: Cannot read properties of undefined (reading 'id')",
    );

    const fatal = { ...nextjsServerError, level: "fatal" };
    expect(tail(fatal, nextjsHeader)).toContain("[FATAL]");

    expect(json(nextjsServerError, nextjsHeader)).toMatchObject({
      type: "error",
      level: "error",
      error_type: "TypeError",
    });
  });
});

describe("frame hint", () => {
  test("points at the newest in-app frame, not React's dispatcher", () => {
    const line = tail(nextjsBrowserError, nextjsHeader);
    expect(line).toContain(
      "[app:///_next/static/chunks/app_page_tsx.js:24:19]",
    );
    expect(line).toContain("[onClick]");
    expect(line).not.toContain("dispatchDiscreteEvent");

    expect(json(nextjsBrowserError, nextjsHeader)).toMatchObject({
      filename: "app:///_next/static/chunks/app_page_tsx.js",
      lineno: 24,
      colno: 19,
      function: "onClick",
    });
  });

  test("points at the throwing function in a Hono route, not dispatch", () => {
    const line = tail(honoWorkerError, honoHeader);
    expect(line).toContain("[/index.js:1190:9] [deepFunction]");
    expect(json(honoWorkerError, honoHeader)["function"]).toBe("deepFunction");
  });

  test("skips library frames newer than the app frame", () => {
    const line = tail(nextjsServerError, nextjsHeader);
    expect(line).toContain("[GET]");
    expect(json(nextjsServerError, nextjsHeader)["function"]).toBe("GET");
  });
});

describe("source tag", () => {
  test("a Hono app on Cloudflare Workers is a server", () => {
    expect(tail(honoWorkerError, honoHeader)).toContain("[SERVER]");
    expect(json(honoWorkerError, honoHeader)["source"]).toBe("server");
  });

  test.each([
    "sentry.javascript.hono",
    "sentry.javascript.vercel-edge",
    "sentry.javascript.aws-serverless",
    "sentry.javascript.google-cloud-serverless",
    "sentry.javascript.nestjs",
    "sentry.javascript.solidstart",
    "sentry.javascript.react-router",
    "sentry.javascript.tanstackstart-react",
    "sentry.javascript.elysia",
    "sentry.javascript.nitro",
  ])("%s logs without event contexts are a server", (sdkName) => {
    const lines = formatItem(
      "log",
      { items: [{ level: "info", body: "request handled" }] },
      { sdk: { name: sdkName, version: "11.0.0" } },
      "log",
    );
    expect(stripAnsi(lines[0] ?? "")).toContain("[SERVER]");
  });

  test("a Next.js browser event is a browser, a server event is a server", () => {
    expect(tail(nextjsBrowserError, nextjsHeader)).toContain("[BROWSER]");
    expect(json(nextjsBrowserError, nextjsHeader)["source"]).toBe("browser");

    expect(tail(nextjsServerError, nextjsHeader)).toContain("[SERVER]");
    expect(json(nextjsServerError, nextjsHeader)["source"]).toBe("server");
  });

  test("a Next.js edge runtime event is a server", () => {
    const edge = {
      ...nextjsServerError,
      platform: "javascript",
      contexts: { runtime: { name: "vercel-edge" } },
    };
    expect(tail(edge, nextjsHeader)).toContain("[SERVER]");
  });

  test.each([
    "sentry.javascript.nuxt",
    "sentry.javascript.sveltekit",
    "sentry.javascript.remix",
    "sentry.javascript.astro",
    "sentry.javascript.solidstart",
    "sentry.javascript.react-router",
  ])("%s events follow the platform and runtime", (sdkName) => {
    const header = { sdk: { name: sdkName, version: "11.0.0" } };
    const sdk = header.sdk;
    expect(tail({ ...nextjsBrowserError, sdk }, header)).toContain("[BROWSER]");
    expect(tail({ ...nextjsServerError, sdk }, header)).toContain("[SERVER]");
  });
});

describe("log attributes", () => {
  /** A werkzeug access log from sentry-python's logs integration. */
  const werkzeugLog = {
    items: [
      {
        timestamp: 1_794_045_606.1,
        trace_id: TRACE_ID,
        level: "info",
        body: '127.0.0.1 - - [17/Nov/2026 10:00:06] "GET /boom HTTP/1.1" 500 -',
        attributes: {
          "sentry.sdk.name": { value: "sentry.python.flask", type: "string" },
          "sentry.sdk.version": { value: "2.42.0", type: "string" },
          "sentry.environment": { value: "production", type: "string" },
          "sentry.origin": { value: "auto.log.stdlib", type: "string" },
          "sentry.message.template": {
            value: "%s - - [%s] %s %s %s\n",
            type: "string",
          },
          "sentry.trace.trace_id": { value: TRACE_ID, type: "string" },
          "server.address": { value: "dev-laptop.local", type: "string" },
          "logger.name": { value: "werkzeug", type: "string" },
          "code.file.path": {
            value:
              "/app/.venv/lib/python3.12/site-packages/werkzeug/_internal.py",
            type: "string",
          },
          "code.function.name": { value: "_log", type: "string" },
          "code.line.number": { value: 97, type: "integer" },
          "thread.id": { value: 6_171_455_488, type: "integer" },
          "thread.name": {
            value: "Thread-3 (process_request_thread)",
            type: "string",
          },
          "process.pid": { value: 41_822, type: "integer" },
          "user.id": { value: "42", type: "string" },
          "user.email": { value: "jane@example.com", type: "string" },
          "user.name": { value: "jane", type: "string" },
          asctime: { value: "2026-11-17 10:00:06,101", type: "string" },
          request: {
            value: "<socket.socket fd=7, family=2, type=1, proto=0>",
            type: "string",
          },
          server_time: { value: "17/Nov/2026 10:00:06", type: "string" },
          request_id: { value: "req-7f3a", type: "string" },
        },
      },
    ],
  };
  const header = { sdk: { name: "sentry.python.flask", version: "2.42.0" } };

  test("without --attributes, a log line shows only custom attributes", () => {
    const lines = formatItem("log", werkzeugLog, header, "log").map(stripAnsi);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/\[request_id=req-7f3a\] \[trace:[0-9a-f]+\]$/);
    for (const key of [
      "logger.name",
      "code.file.path",
      "thread.name",
      "server.address",
      "user.email",
      "user.id",
      "asctime",
      "request=",
      "server_time",
    ]) {
      expect(lines[0]).not.toContain(key);
    }
  });

  test("with --attributes, SDK attributes are listed under the line", () => {
    const lines = formatItem("log", werkzeugLog, header, "log", {
      showAttributes: true,
    }).map(stripAnsi);
    expect(lines.length).toBeGreaterThan(1);
    const table = lines.slice(1).join("\n");
    expect(table).toContain("sdk attributes");
    expect(table).toContain("code.file.path");
    expect(table).toContain("thread.name");
    expect(table).toContain("logger.name");
    expect(table).toContain("user.email");
    expect(table).toContain("asctime");
  });

  test("a warn log uses the same [WARNING] label as a warning event", () => {
    const warnLog = { items: [{ ...werkzeugLog.items[0], level: "warn" }] };
    const [line] = formatItem("log", warnLog, header, "log").map(stripAnsi);
    expect(line).toContain(" [WARNING] ");
    expect(line).not.toContain("[WARN]");
  });

  /** JSON records for the werkzeug log, with or without `-a`. */
  function logJson(showAttributes: boolean): Record<string, unknown> {
    const lines = formatItemJson("log", werkzeugLog, header, showAttributes);
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  }

  test("JSON log records keep only custom attributes without --attributes", () => {
    expect(logJson(false)["attributes"]).toEqual({ request_id: "req-7f3a" });
  });

  test("JSON log records add SDK attributes with --attributes", () => {
    const attributes = logJson(true)["attributes"] as Record<string, unknown>;
    expect(attributes).toMatchObject({
      request_id: "req-7f3a",
      "logger.name": "werkzeug",
      "code.line.number": 97,
      "user.email": "jane@example.com",
    });
    expect(Object.keys(attributes).some((k) => k.startsWith("sentry."))).toBe(
      false,
    );
  });
});

describe("SDK log attributes stay log-only", () => {
  /** One log item from the given SDK with the given attributes. */
  function sdkLog(
    sdkName: string,
    attributes: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      items: [
        {
          timestamp: 1_794_045_606.1,
          level: "info",
          body: "Checkout done",
          attributes: Object.fromEntries(
            Object.entries({ "sentry.sdk.name": sdkName, ...attributes }).map(
              ([key, value]) => [key, { value }],
            ),
          ),
        },
      ],
    };
  }

  /** The tail line for one log item, without colors. */
  function logLine(sdkName: string, attributes: Record<string, unknown>) {
    const header = { sdk: { name: sdkName, version: "1.0.0" } };
    const lines = formatItem("log", sdkLog(sdkName, attributes), header, "log");
    return stripAnsi(lines[0] ?? "");
  }

  test("custom user.* attributes stay on the line", () => {
    const line = logLine("sentry.python.flask", {
      "user.id": "42",
      "user.plan": "pro",
    });
    expect(line).toContain("[user.plan=pro]");
    expect(line).not.toContain("user.id");
  });

  test("a bare request is hidden only when it is an SDK repr", () => {
    expect(
      logLine("sentry.javascript.node", { request: "checkout" }),
    ).toContain("[request=checkout]");
    expect(
      logLine("sentry.javascript.node", {
        request: "<WSGIRequest: GET '/boom'>",
      }),
    ).not.toContain("request=");
  });

  test("Rust log attributes are hidden without --attributes", () => {
    const attributes = {
      "os.name": "macos",
      "os.version": "15.1",
      parent_span_id: "b0e6f15b45c36b12",
      order_id: "o-1",
    };
    const line = logLine("sentry.rust", attributes);
    expect(line).toContain("[order_id=o-1]");
    for (const key of ["os.name", "os.version", "parent_span_id"]) {
      expect(line).not.toContain(key);
    }
    // Other SDKs keep the same keys as custom attributes.
    expect(logLine("sentry.javascript.node", attributes)).toContain(
      "[os.name=macos]",
    );

    const header = { sdk: { name: "sentry.rust", version: "0.40.0" } };
    const table = formatItem(
      "log",
      sdkLog("sentry.rust", attributes),
      header,
      "log",
      { showAttributes: true },
    )
      .map(stripAnsi)
      .slice(1)
      .join("\n");
    expect(table).toContain("os.name");
    expect(table).toContain("parent_span_id");
  });

  test("Ruby's parameters attribute is hidden without --attributes", () => {
    const line = logLine("sentry.ruby.rails", {
      parameters: '["jane"]',
      "sentry.message.parameter.0": "jane",
      order_id: "o-1",
    });
    expect(line).toContain("[order_id=o-1]");
    expect(line).not.toContain("parameters");
  });

  test("transactions keep log-only keys as custom attributes", () => {
    const data = {
      asctime: "2026-11-17 10:00:06,101",
      "logger.name": "app",
      request: "checkout",
      server_time: "10:00:06",
      "user.email": "jane@example.com",
      "http.method": "GET",
    };
    const event = {
      timestamp: 1_794_045_606.2,
      start_timestamp: 1_794_045_606.1,
      contexts: { trace: { op: "http.server", data } },
    };
    const header = { sdk: { name: "sentry.python.flask", version: "2.42.0" } };
    const [line] = formatItemJson("transaction", event, header, true);
    const record = JSON.parse(line ?? "{}") as {
      attributes: Record<string, Record<string, string>>;
    };
    expect(Object.keys(record.attributes["user"] ?? {}).sort()).toEqual([
      "asctime",
      "logger.name",
      "request",
      "server_time",
      "user.email",
    ]);
    expect(record.attributes["sdk"]).toEqual({ "http.method": "GET" });

    const table = formatAttributeTable(event).map(stripAnsi).join("\n");
    const userGroup = table.slice(0, table.indexOf("sdk attributes"));
    expect(userGroup).toContain("user.email");
    expect(userGroup).toContain("asctime");
  });
});

describe("colored log text", () => {
  /** A uvicorn access log whose formatter colored the message. */
  const uvicornLog = {
    items: [
      {
        timestamp: 1_794_045_606.1,
        level: "info",
        body: "\u001b[35m\u001b[1mGET /boom HTTP/1.1\u001b[0m 500",
        attributes: {
          "logger.name": { value: "uvicorn.access", type: "string" },
          color_message: {
            value:
              '%s - "\u001b[1m%s %s HTTP/%s\u001b[0m" \u001b[31m%d\u001b[0m',
            type: "string",
          },
        },
      },
    ],
  };
  const header = { sdk: { name: "sentry.python.fastapi", version: "2.42.0" } };

  test("JSON log records have no ANSI escapes", () => {
    const [line] = formatItemJson("log", uvicornLog, header);
    expect(line).not.toContain("\\u001b");
    const record = JSON.parse(line ?? "{}") as Record<string, unknown>;
    expect(record["message"]).toBe("GET /boom HTTP/1.1 500");
    expect(record["attributes"]).toEqual({
      color_message: '%s - "%s %s HTTP/%s" %d',
    });
  });

  test("JSON event records have no ANSI escapes", () => {
    const record = json(
      { message: "\u001b[33mdisk almost full\u001b[0m", level: "warning" },
      pythonHeader,
    );
    expect(record["message"]).toBe("disk almost full");
  });
});
