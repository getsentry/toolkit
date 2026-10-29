import type { Span } from "../types.ts";

export function getAllSpansInTree(root: Span): Span[] {
  const spans: Span[] = [];
  const pending = [root];
  const visited = new Set<Span>();
  for (let span = pending.pop(); span; span = pending.pop()) {
    if (visited.has(span)) continue;
    visited.add(span);
    spans.push(span);
    for (let index = (span.children?.length ?? 0) - 1; index >= 0; index--) {
      pending.push(span.children![index]);
    }
  }
  return spans;
}
