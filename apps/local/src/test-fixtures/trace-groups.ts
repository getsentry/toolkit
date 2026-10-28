import { createTelemetryStore } from "@sentry/telemetry";
import {
  adaptTraceGroups,
  traceIdForItem,
  type TraceGroup,
} from "../lib/trace-model.ts";
import type { LocalFeedItem } from "../lib/spotlight.ts";
import { record } from "../lib/inspection.ts";

/** Reconstruct a parsed wire envelope for callers that already decoded its items. */
export function telemetryEnvelope(items: readonly LocalFeedItem[]): unknown {
  const fallbackTimestamp =
    items
      .map((item) => record(item.payload).timestamp ?? item.timestamp)
      .find((value) => value !== undefined) ?? 0;
  return [
    items[0]?.envelopeHeader ?? {},
    items.map((item) => {
      const payload = record(item.payload);
      const metadata = item.metadata;
      const contexts = record(payload.contexts);
      const trace = record(contexts.trace);
      const traceId = traceIdForItem(item);
      const timestamp =
        payload.timestamp ??
        payload.end_timestamp ??
        item.timestamp ??
        fallbackTimestamp;
      const enriched = {
        ...payload,
        event_id: payload.event_id ?? item.id,
        timestamp,
        ...(traceId
          ? {
              contexts: {
                ...contexts,
                trace: {
                  trace_id: traceId,
                  span_id: metadata?.spanId ?? item.id,
                  op: metadata?.operation,
                  ...trace,
                },
              },
            }
          : {}),
      };
      if (item.type === "transaction") {
        Object.assign(enriched, {
          type: "transaction",
          transaction: payload.transaction ?? metadata?.title,
          start_timestamp: payload.start_timestamp ?? timestamp,
        });
      }
      if (item.type === "span") {
        // Decoded span-v2 items have typed attributes. Pass a v2 container to
        // the shared processor rather than reimplementing attribute normalization.
        const span = {
          ...payload,
          trace_id: payload.trace_id ?? traceId,
          span_id: payload.span_id ?? metadata?.spanId ?? item.id,
          op: payload.op ?? metadata?.operation,
          description: payload.description ?? metadata?.title,
          timestamp,
        };
        return [
          item.itemHeader ?? { type: item.type },
          "attributes" in payload
            ? {
                version: 2,
                items: [
                  {
                    ...span,
                    end_timestamp: payload.end_timestamp ?? timestamp,
                  },
                ],
              }
            : span,
        ];
      }
      if (item.type === "log") {
        const log = {
          ...payload,
          timestamp,
          trace_id: payload.trace_id ?? traceId,
          level: payload.level ?? metadata?.level ?? "info",
          body: payload.body ?? metadata?.title ?? "",
        };
        return [
          item.itemHeader ?? { type: item.type },
          { ...enriched, items: [log] },
        ];
      }
      return [item.itemHeader ?? { type: item.type }, enriched];
    }),
  ];
}

/** Convenience for isolated captures; the live workspace uses its session store. */
export async function buildTraceGroups(
  items: readonly LocalFeedItem[],
): Promise<TraceGroup[]> {
  const store = createTelemetryStore({
    maxEnvelopeBytes: 128 * 1024 * 1024,
    retention: { maxBytes: 128 * 1024 * 1024 },
  });
  try {
    await store.ingestEnvelope(telemetryEnvelope(items));
    return adaptTraceGroups(items, store.getTraces());
  } finally {
    store.dispose();
  }
}
