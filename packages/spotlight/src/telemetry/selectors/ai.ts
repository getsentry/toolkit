import {
  createAITraceFromSpan,
  extractAllAIRootSpans,
} from "../ai/aiLibraries.ts";
import type { AITrace, Span, Trace } from "../types.ts";

export function getAIRootSpans(traces: Iterable<Trace>): Span[] {
  return Array.from(traces).flatMap((trace) =>
    extractAllAIRootSpans(trace.spanTree).map(({ span }) => span),
  );
}

export function getAITraces(traces: Iterable<Trace>): AITrace[] {
  return getAIRootSpans(traces).flatMap((span) => {
    const result = createAITraceFromSpan(span);
    return result ? [result] : [];
  });
}
