import type { SearchEventsStructuredContent } from "../tools/support/search-events/structured";
import type { StructuredToolOutput } from "../tools/types";

/**
 * An empty structured search result. Dataset search tool tests that mock
 * `runSearchEvents` return it, so the result still matches the tool's
 * outputSchema (see structured-output-guard.ts).
 */
export const SEARCH_EVENTS_STUB: StructuredToolOutput<SearchEventsStructuredContent> =
  {
    structuredContent: {
      query: "anything",
      explanation: null,
      executedSearch: {
        dataset: "stub",
        query: "",
        fields: [],
        sort: null,
        timeRange: { statsPeriod: null, start: null, end: null },
      },
      url: "https://sentry.io/",
      presentationHint: "",
      notes: [],
      resultType: "samples",
      results: [],
      timeSeries: null,
      suggestedActions: [],
    },
  };
