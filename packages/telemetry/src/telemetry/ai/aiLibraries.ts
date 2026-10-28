import type { AILibraryHandler, AITrace, Span, Trace } from "../types.ts";
import { genAIHandler } from "./genAI.ts";
import { vercelAISDKHandler } from "./vercelAISDK.ts";

// Registry of AI span handlers. The generic gen_ai handler runs first because
// it only claims standard `gen_ai.*` spans that lack `vercel.ai.*` fields, so
// the Vercel handler still picks up its own proprietary spans.
const aiLibraries: AILibraryHandler[] = [genAIHandler, vercelAISDKHandler];

export { aiLibraries };

export function detectAILibraryHandler(span: Span): AILibraryHandler | null {
  for (const handler of aiLibraries) {
    // careful if we support multiple libraries, we should improve this method so it doesn't return the first one
    if (handler.canHandleSpan(span)) {
      return handler;
    }
  }
  return null;
}

export function extractAllAIRootSpans(
  spans: Span[],
): { span: Span; handler: AILibraryHandler }[] {
  const results: { span: Span; handler: AILibraryHandler }[] = [];
  // Handlers can match overlapping span shapes (both AI handlers key off the
  // `gen_ai.` op prefix). Attribute each root span to the first handler that
  // claims it so a span is never surfaced twice.
  const claimed = new Set<string>();

  for (const handler of aiLibraries) {
    const rootSpans = handler.extractRootSpans(spans);
    for (const rootSpan of rootSpans) {
      if (claimed.has(rootSpan.span_id)) {
        continue;
      }
      claimed.add(rootSpan.span_id);
      results.push({ span: rootSpan, handler });
    }
  }

  return results;
}

export function createAITraceFromSpan(span: Span): AITrace | null {
  const handler = detectAILibraryHandler(span);
  if (!handler) {
    return null;
  }

  return handler.processTrace(span);
}

export function hasAISpans(trace: Trace): boolean {
  if (!trace.spanTree) {
    return false;
  }

  // TODO: We may want to cache/optimize this `extractAllAIRootSpans` helper
  const aiRootSpans = extractAllAIRootSpans(trace.spanTree);
  return aiRootSpans.length > 0;
}
