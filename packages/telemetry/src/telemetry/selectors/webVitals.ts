import { PERFORMANCE_SCORE_PROFILES } from "../constants/performance.ts";
import type { SentryEvent, SentryEventWithPerformanceData } from "../types.ts";
import { normalizePerformanceScore } from "../utils/webVitals.ts";

export function getWebVitals(
  events: Iterable<SentryEvent>,
): SentryEventWithPerformanceData[] {
  return Array.from(events)
    .filter(
      (event) => event.measurements && event.contexts?.trace?.op === "pageload",
    )
    .map((event) => {
      const copy = structuredClone(event);
      normalizePerformanceScore(copy, PERFORMANCE_SCORE_PROFILES);
      return copy as unknown as SentryEventWithPerformanceData;
    })
    .filter((event) => event.measurements["score.total"] != null);
}
