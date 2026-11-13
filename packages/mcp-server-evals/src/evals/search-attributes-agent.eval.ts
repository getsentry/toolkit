import { describeEval } from "vitest-evals/legacy";
import { SentryApiService } from "@sentry/mcp-core/api-client";
import {
  generateKeyHintsAgent,
  shortlistAttributesAgent,
} from "@sentry/mcp-core/tools/search-attributes/agent";
import { FIXTURES } from "./utils";
import { StructuredOutputScorer } from "./utils/structuredOutputScorer";
import "../setup-env";

// The shared MSW server is already started in setup-env.ts.
//
// Each dataset's fixture has a pair of near-identical keys that only their
// descriptions tell apart, such as kiosk.firmware (installed) and
// kiosk.firmware_revision (staged). Those cases check that the shortlist agent
// matches on meaning, not just on shared words.

const ITEM_TYPES = {
  spans: "spans",
  logs: "logs",
  metrics: "tracemetrics",
} as const;

type Dataset = keyof typeof ITEM_TYPES;

/** Shortlist the dataset's mock attributes, as search_attributes does. */
function shortlistTask(dataset: Dataset) {
  return async (input: string) => {
    const apiService = new SentryApiService({ accessToken: "test-token" });
    const attributes = await apiService.listTraceItemAttributes({
      organizationSlug: FIXTURES.organizationSlug,
      itemType: ITEM_TYPES[dataset],
      context: true,
    });
    const { best, candidates, reason } = await shortlistAttributesAgent({
      query: input,
      dataset,
      attributes,
      limit: 10,
    });
    return JSON.stringify({
      best: best?.key ?? null,
      candidates: candidates.map(({ key }) => key),
      reason,
    });
  };
}

const isNull = (value: unknown) => value === null;

describeEval("search-attributes-shortlist-spans", {
  data: async () => [
    {
      // http.method is deprecated in favor of http.request.method, and both
      // are listed. Without a mention of deprecation, the replacement wins.
      input: "HTTP request method",
      expected: { best: "http.request.method" },
    },
    {
      // Asking about the old attribute returns the deprecated key.
      input: "Are we still sending the old, deprecated HTTP method attribute?",
      expected: { best: "http.method" },
    },
    {
      // kiosk.firmware_revision is downloaded but not installed yet.
      input: "Which firmware is installed on the kiosk right now?",
      expected: {
        best: "kiosk.firmware",
      },
    },
    {
      // No span attribute holds this.
      input: "shopping cart capacity",
      expected: { best: isNull, candidates: [] },
    },
  ],
  task: shortlistTask("spans"),
  scorers: [StructuredOutputScorer({ match: "fuzzy" })],
});

describeEval("search-attributes-shortlist-logs", {
  data: async () => [
    {
      // worker.queue_wait_time is the configured maximum, not the actual wait.
      input:
        "How long did jobs wait in the queue before a worker picked them up?",
      expected: { best: "worker.queue_wait" },
    },
  ],
  task: shortlistTask("logs"),
  scorers: [StructuredOutputScorer({ match: "fuzzy" })],
});

describeEval("search-attributes-shortlist-metrics", {
  data: async () => [
    {
      // fleet.deployment_region is where the server moves next.
      input: "Which region is the server running in right now?",
      expected: { best: "fleet.region" },
    },
    {
      // multiple candidates but no best answer
      input: "Which attributes are related to retries?",
      expected: { best: isNull, candidates: ["retry.count", "retry.delay_ms"] },
    },
  ],
  task: shortlistTask("metrics"),
  scorers: [StructuredOutputScorer({ match: "fuzzy" })],
});

describeEval("search-attributes-key-hints", {
  data: async () => [
    {
      // Plain English becomes a key segment.
      input: "HTTP status code",
      expected: {
        hints: (hintList: string[]) =>
          hintList.includes("http") && hintList.includes("status"),
      },
    },
    {
      // A synonym: keys say "duration", not "how long".
      input: "How long did the request take?",
      expected: {
        hints: (hintList: string[]) =>
          hintList.includes("duration") && hintList.includes("request"),
      },
    },
    {
      // Part of a key is kept exactly as written.
      input: "gen_ai.usage tokens",
      expected: {
        hints: (hintList: string[]) => hintList.includes("gen_ai.usage"),
      },
    },
  ],
  task: async (input) =>
    JSON.stringify({
      hints: await generateKeyHintsAgent({ query: input, dataset: "spans" }),
    }),
  scorers: [StructuredOutputScorer({ match: "fuzzy" })],
});
