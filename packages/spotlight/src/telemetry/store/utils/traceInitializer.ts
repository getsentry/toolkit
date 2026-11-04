import type {
  SentryEvent,
  SentryTransactionEvent,
  Span,
  Trace,
} from "../../types.ts";

/**
 * Creates a new trace object from an event's trace context.
 * This is used when we receive an event with a trace_id but don't have a trace yet.
 */
export function initializeTrace(event: SentryEvent): Trace {
  // Add guard to ensure contexts, trace context and trace_id exist
  if (!event.contexts?.trace || !event.contexts.trace.trace_id) {
    throw new Error("Event missing required trace context or trace_id");
  }

  const traceCtx = event.contexts.trace;
  const timestamp = event.timestamp ?? 0;

  return {
    ...traceCtx,
    trace_id: traceCtx.trace_id!,
    spans: new Map(),
    spanTree: [] as Span[],
    transactions: [] as SentryTransactionEvent[],
    errors: 0,
    start_timestamp: event.start_timestamp ?? timestamp,
    timestamp,
    status: traceCtx.status,
    rootTransactionName: event.transaction || "(unknown transaction)",
    rootTransaction: null,
    profileGrafted: false,
  };
}
