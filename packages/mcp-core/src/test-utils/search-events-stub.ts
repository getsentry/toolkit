import type { SearchReplaysStructuredContent } from "../tools/support/search-events/replays";
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

/** {@link SEARCH_EVENTS_STUB} for search_replays, which has its own schema. */
export const SEARCH_REPLAYS_STUB: StructuredToolOutput<SearchReplaysStructuredContent> =
  {
    structuredContent: {
      query: "anything",
      explanation: null,
      executedSearch: {
        query: "",
        sort: "-started_at",
        environment: [],
        timeRange: { statsPeriod: null, start: null, end: null },
      },
      url: "https://sentry.io/",
      presentationHint: "",
      notes: [],
      replays: [],
      suggestedActions: [],
    },
  };
