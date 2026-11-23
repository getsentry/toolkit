/**
 * Scrubbed sentry-python 2.x captures from a Flask development server, as
 * the receiver streams them. Werkzeug colours its startup banner and access
 * logs with ANSI escapes, and request-mode session tracking sends a
 * `sessions` aggregate instead of individual `session` items.
 */
const traceId = "c22c7d1b8e124f7c99a0dc36a80ccbae";
const attributes = {
  "sentry.origin": { value: "auto.log.stdlib", type: "string" },
  "logger.name": { value: "werkzeug", type: "string" },
  "sentry.sdk.name": { value: "sentry.python.flask", type: "string" },
  "sentry.sdk.version": { value: "2.75.0", type: "string" },
  "sentry.severity_text": { value: "info", type: "string" },
};

export const werkzeugBanner =
  "\u001b[31m\u001b[1mWARNING: This is a development server. Do not use it in a production deployment. Use a production WSGI server instead.\u001b[0m\n * Running on http://127.0.0.1:5050";

export const werkzeugLogEnvelope = JSON.stringify([
  { sent_at: "2026-11-17T21:01:09.200673Z" },
  [
    [
      {
        item_count: 2,
        type: "log",
        content_type: "application/vnd.sentry.items.log+json",
      },
      {
        version: 2,
        items: [
          {
            timestamp: 1794949191.5353491,
            level: "info",
            body: werkzeugBanner,
            attributes,
            trace_id: traceId,
          },
          {
            timestamp: 1794949195.2575,
            level: "info",
            body: '127.0.0.1 - - [17/Nov/2026 20:59:55] "\u001b[33mGET /missing HTTP/1.1\u001b[0m" 404 -',
            attributes,
            trace_id: traceId,
          },
        ],
      },
    ],
  ],
]);

export const sessionsAggregateEnvelope = JSON.stringify([
  {},
  [
    [
      { type: "sessions", content_type: "application/json", length: 126 },
      {
        attrs: { environment: "dev", release: "flaskapp@1.0.0" },
        aggregates: [{ started: "2026-11-17T20:59:00.000000Z", exited: 5 }],
      },
    ],
  ],
]);
