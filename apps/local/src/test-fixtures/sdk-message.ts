/** Scrubbed sentry-python Django `logging.error()` event with a signed-in user. */
export const pythonLoggingEvent = {
  event_id: "b".repeat(32),
  level: "error",
  logger: "shop.db",
  logentry: {
    message: "Database query failed for %s",
    params: ["orders"],
    formatted: "Database query failed for orders",
  },
  platform: "python",
  timestamp: "2026-11-17T15:00:20.913Z",
  transaction: "/db/",
  transaction_info: { source: "route" },
  user: {
    id: "42",
    email: "ada@example.test",
    username: "ada",
    ip_address: "127.0.0.1",
  },
  environment: "production",
  release: "shop@1.4.2",
  server_name: "web-1",
  contexts: {
    trace: {
      trace_id: "c".repeat(32),
      span_id: "d".repeat(16),
      op: "http.server",
    },
    os: { name: "Linux", version: "6.8" },
    runtime: { name: "CPython", version: "3.12.4" },
    cloud_resource: {},
  },
  breadcrumbs: {
    values: [
      {
        category: "query",
        message: "SELECT * FROM orders",
        timestamp: 1794947420.913,
        level: "info",
      },
    ],
  },
  sdk: { name: "sentry.python.django", version: "2.47.0" },
};

/** Scrubbed sentry-python `logging.exception()` event inside an `except` block. */
export const pythonHandledException = {
  event_id: "e".repeat(32),
  level: "error",
  logentry: { message: "Checkout failed", params: [] },
  platform: "python",
  transaction: "/checkout/",
  exception: {
    values: [
      {
        type: "ZeroDivisionError",
        value: "division by zero",
        mechanism: { type: "logging", handled: true },
      },
    ],
  },
  contexts: { trace: { op: "event.django" } },
};

/** Scrubbed `captureMessage("Payment retry limit reached", "error")` event. */
export const sdkErrorMessage = {
  event_id: "f".repeat(32),
  level: "error",
  message: "Payment retry limit reached",
  platform: "javascript",
  transaction: "POST /checkout",
  contexts: { trace: { op: "http.server" } },
  sdk: { name: "sentry.javascript.node", version: "10.20.0" },
};
