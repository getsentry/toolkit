import type {
  Sdk,
  SentrySpanEvent,
  SentryTransactionEvent,
  Span,
} from "../../types.ts";
import { initializeTrace } from "./traceInitializer.ts";
import {
  type TraceProcessingContext,
  type TraceProcessingResult,
  processTransactionEvent,
  rebuildSpanTree,
} from "./traceProcessor.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Decode the span v2 container, or a legacy standalone span, without changing the raw envelope. */
export function normalizeSpanItem(
  payload: unknown,
  sdk: Sdk,
): SentrySpanEvent[] {
  if (!isRecord(payload)) return [];
  const isContainer = "items" in payload;
  if (isContainer && (payload.version !== 2 || !Array.isArray(payload.items)))
    return [];

  const events: SentrySpanEvent[] = [];
  for (const raw of isContainer ? (payload.items as unknown[]) : [payload]) {
    if (!isRecord(raw)) continue;
    const end = isContainer ? raw.end_timestamp : raw.timestamp;
    if (
      typeof raw.trace_id !== "string" ||
      !raw.trace_id ||
      typeof raw.span_id !== "string" ||
      !raw.span_id ||
      typeof raw.start_timestamp !== "number" ||
      !Number.isFinite(raw.start_timestamp) ||
      typeof end !== "number" ||
      !Number.isFinite(end)
    )
      continue;

    const data: Record<string, unknown> = {};
    if (isContainer && isRecord(raw.attributes)) {
      for (const [key, attribute] of Object.entries(raw.attributes)) {
        if (isRecord(attribute) && "value" in attribute)
          data[key] = attribute.value;
      }
    } else if (isRecord(raw.data)) {
      Object.assign(data, raw.data);
    }

    const op = isContainer ? data["sentry.op"] : raw.op;
    const name = isContainer ? raw.name : raw.description;
    const span: Span = {
      trace_id: raw.trace_id,
      span_id: raw.span_id,
      parent_span_id:
        typeof raw.parent_span_id === "string" ? raw.parent_span_id : undefined,
      description: typeof name === "string" ? name : undefined,
      op: typeof op === "string" ? op : undefined,
      start_timestamp: raw.start_timestamp,
      timestamp: end,
      status: typeof raw.status === "string" ? raw.status : undefined,
      data,
    };

    events.push({
      type: "span",
      event_id: `${raw.trace_id}:${raw.span_id}`,
      timestamp: end,
      start_timestamp: raw.start_timestamp,
      contexts: {
        trace: {
          trace_id: raw.trace_id,
          span_id: raw.span_id,
          parent_span_id: span.parent_span_id ?? undefined,
          op: span.op ?? undefined,
          status: span.status,
          data,
        },
      },
      sdk,
      span,
      is_segment: raw.is_segment === true,
    });
  }
  return events;
}

export function processSpanEvent(
  event: SentrySpanEvent,
  context: TraceProcessingContext,
): TraceProcessingResult {
  const trace = context.existingTrace ?? initializeTrace(event);
  const span = {
    ...event.span,
    start_timestamp: event.span.start_timestamp,
    timestamp: event.span.timestamp,
  };

  // A segment serves the same role as the root transaction in the existing UI.
  // Child spans must not inflate the transaction count or replace its name.
  if (event.is_segment) {
    const transaction: SentryTransactionEvent = {
      ...event,
      type: "transaction",
      transaction: span.description ?? "(unknown transaction)",
      start_timestamp:
        event.start_timestamp as SentryTransactionEvent["start_timestamp"],
      contexts: { ...event.contexts, trace: event.contexts!.trace! },
    };
    return processTransactionEvent(transaction, {
      ...context,
      existingTrace: trace,
    });
  }

  trace.spans.set(span.span_id, span);
  rebuildSpanTree(trace);
  return { trace, shouldUpdateTrace: true };
}
