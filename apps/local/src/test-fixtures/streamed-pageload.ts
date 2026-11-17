/**
 * Scrubbed span v2 items from a Sentry JavaScript browser SDK 11 pageload in
 * stream mode. Resource and fetch spans are named by host, with the URL in
 * `url.full`. TTFB/FCP live on the segment; LCP, CLS and INP arrive later as
 * their own spans. LCP and CLS values are raised to cover
 * non-good ratings.
 */
const traceId = "3deb203c4ee144c8bb6104076eabc7f4";
const pageloadId = "a39103452fcf4abc";

const attributes = (values: Record<string, string | number | boolean>) =>
  Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      {
        value,
        type:
          typeof value === "string"
            ? "string"
            : typeof value === "boolean"
              ? "boolean"
              : Number.isInteger(value)
                ? "integer"
                : "double",
      },
    ]),
  );

const segment = {
  "sentry.segment.id": pageloadId,
  "sentry.segment.name": "Pageload",
  "sentry.sdk.name": "sentry.javascript.browser",
  "sentry.sdk.version": "11.14.0",
  "sentry.trace_lifecycle": "stream",
};

const child = (
  span_id: string,
  name: string,
  start: number,
  end: number,
  values: Record<string, string | number | boolean>,
) => ({
  name,
  span_id,
  trace_id: traceId,
  parent_span_id: pageloadId,
  start_timestamp: start,
  end_timestamp: end,
  is_segment: false,
  status: "ok",
  attributes: attributes({ ...values, ...segment }),
});

const resource = (span_id: string, op: string, path: string, start: number) =>
  child(span_id, "localhost", start, start + 0.04, {
    "sentry.op": op,
    "sentry.origin": "auto.resource.browser.metrics",
    "url.full": `http://localhost:4000${path}`,
    "url.domain": "localhost",
    "server.address": "localhost:4000",
    "http.response.body.size": 1200,
  });

export const streamedPageloadSpans = [
  {
    name: "Pageload",
    span_id: pageloadId,
    trace_id: traceId,
    start_timestamp: 1794949298.4079,
    end_timestamp: 1794949298.7285,
    is_segment: true,
    status: "ok",
    attributes: attributes({
      "sentry.op": "pageload",
      "sentry.origin": "auto.pageload.browser",
      "sentry.segment.name.source": "url",
      "url.path": "/",
      "url.full": "http://localhost:4000/",
      "browser.web_vital.ttfb.value": 24.4,
      "browser.web_vital.fp.value": 252,
      "browser.web_vital.fcp.value": 252,
      ...segment,
    }),
  },
  resource("b5a0feefbd6a1dd8", "resource.script", "/app.js", 1794949298.4756),
  resource("c5a0feefbd6a1dd8", "resource.script", "/js/mod1.js", 1794949298.48),
  resource("d5a0feefbd6a1dd8", "resource.link", "/style1.css", 1794949298.47),
  child("867d69464fab926b", "GET localhost", 1794949298.6784, 1794949298.7285, {
    "sentry.op": "http.client",
    "sentry.origin": "auto.http.browser",
    "http.request.method": "GET",
    "url.full": "http://localhost:4000/api/data",
    "url.domain": "localhost",
    "server.address": "localhost:4000",
    "http.response.status_code": 200,
  }),
];

/** Web vital spans the SDK sends after the pageload segment. */
export const streamedWebVitalSpans = [
  child(
    "938bffa38304c5e3",
    "Largest contentful paint",
    1794949298.4079,
    1794949298.6599,
    {
      "sentry.op": "ui.webvital.lcp",
      "sentry.origin": "auto.ui.browser.lcp",
      "sentry.pageload.span_id": pageloadId,
      "browser.web_vital.lcp.value": 3200,
      "browser.web_vital.lcp.element": "body > h1",
    },
  ),
  child("9f85c8bac4e3ddc2", "Layout shift", 1794949298.4079, 1794949298.4079, {
    "sentry.op": "ui.webvital.cls",
    "sentry.origin": "auto.ui.browser.cls",
    "sentry.pageload.span_id": pageloadId,
    "browser.web_vital.cls.value": 0.3,
  }),
  child("884777f7b416aa02", "Click", 1794949301.7939, 1794949301.8099, {
    "sentry.op": "ui.interaction.click",
    "sentry.origin": "auto.ui.browser.inp",
    "sentry.pageload.span_id": pageloadId,
    "browser.web_vital.inp.value": 16,
  }),
];

/** Encode span v2 items as the SSE envelope payload the receiver emits. */
export function spanEnvelope(spans: readonly unknown[]): string {
  return JSON.stringify([
    { sent_at: "2026-11-17T21:01:40.267Z" },
    [
      [
        {
          type: "span",
          item_count: spans.length,
          content_type: "application/vnd.sentry.items.span.v2+json",
        },
        { version: 2, items: spans },
      ],
    ],
  ]);
}
