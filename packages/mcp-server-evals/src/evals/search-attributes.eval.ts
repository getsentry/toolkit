import searchAttributes, {
  type SearchAttributesOutput,
} from "@sentry/mcp-core/tools/search-attributes";
import type { ServerContext } from "@sentry/mcp-core/types";
import { mswServer } from "@sentry/mcp-server-mocks";
import { http, HttpResponse } from "msw";
import { describeEval } from "vitest-evals/legacy";
import { z } from "zod";
import { FIXTURES } from "./utils";
import { StructuredOutputScorer } from "./utils/structuredOutputScorer";
import "../setup-env";

// These run the whole search_attributes tool: the attributes fetch, the
// cut-off check, the hint searches, the shortlist agent, and the structured
// output. A call that fell back to listing attributes has no best match, so it
// scores as no match.

const context: ServerContext = {
  accessToken: "mocked-access-token",
  sentryHost: "sentry.io",
  constraints: { organizationSlug: null, projectSlug: null },
};

async function searchDatasetAttributes(
  query: string | undefined,
  dataset: string,
): Promise<SearchAttributesOutput> {
  const result = await searchAttributes.handler(
    z.object(searchAttributes.inputSchema).parse({
      organizationSlug: FIXTURES.organizationSlug,
      dataset,
      query,
    }),
    context,
  );
  return result.structuredContent;
}

/** The fields the expectations below check. */
function summarize(output: SearchAttributesOutput) {
  const attributeKeys = output.attributes.map(({ key }) => key);
  return {
    result: JSON.stringify({
      resultType: output.resultType,
      best: output.best?.key ?? null,
      bestReplacementKey: output.best?.replacementKey ?? null,
      // The listed attributes, or the candidates other than best.
      allAttributeKeys: attributeKeys,
      matchedKeys: output.best
        ? [output.best.key, ...attributeKeys]
        : attributeKeys,
    }),
  };
}

const matchesAll = (wanted: string[]) => (keys: string[]) =>
  wanted.every((key) => keys.includes(key));

// With no query, the tool lists every attribute and suggests a query. The
// input is the dataset.
describeEval("search-attributes-list", {
  data: async () => [
    {
      input: "spans",
      expected: {
        resultType: "list",
        best: null,
        allAttributeKeys: (keys: string[]) => keys.length === 37,
      },
    },
    {
      input: "logs",
      expected: {
        resultType: "list",
        best: null,
        allAttributeKeys: (keys: string[]) => keys.length === 20,
      },
    },
    {
      input: "metrics",
      expected: {
        resultType: "list",
        best: null,
        allAttributeKeys: (keys: string[]) => keys.length === 15,
      },
    },
  ],
  task: async (input) => {
    const output = await searchDatasetAttributes(undefined, input);
    return summarize(output);
  },
  scorers: [StructuredOutputScorer({ match: "fuzzy" })],
  timeout: 60000,
});

describeEval("search-attributes-spans", {
  data: async () => [
    {
      // The list is short enough that no hints are needed.
      input: "Which city was the user in?",
      expected: { best: "geo.city" },
    },
    {
      // None of the span attribute mocks holds this.
      input: "Which payment provider handled the charge?",
      expected: { best: null, allAttributeKeys: [] },
    },
    {
      // A group of HTTP attributes.
      input: "Which attributes are related to HTTP requests?",
      expected: {
        resultType: "matches",
        matchedKeys: matchesAll([
          "http.request.method",
          "http.status_code",
          "http.url",
        ]),
      },
    },
    {
      // Similar descriptions: kiosk.firmware_revision is downloaded but not
      // installed yet.
      input: "Which firmware is installed on the kiosk right now?",
      expected: { best: "kiosk.firmware" },
    },
    {
      // No descriptions: user.id, user.email, and user.username only have
      // their names.
      input: "Which attribute has the user's numeric account ID?",
      expected: { best: "user.id" },
    },
    {
      // http.method is deprecated in favor of http.request.method, and both
      // are listed. Asking about the old one returns the deprecated key.
      input: "Are we still sending the old, deprecated HTTP method attribute?",
      expected: {
        best: "http.method",
        bestReplacementKey: "http.request.method",
      },
    },
  ],
  task: async (input) => {
    const output = await searchDatasetAttributes(input, "spans");
    return summarize(output);
  },
  scorers: [StructuredOutputScorer({ match: "fuzzy" })],
  timeout: 60000,
});

describeEval("search-attributes-logs", {
  data: async () => [
    {
      // The list is short enough that no hints are needed.
      input: "Which trace was the log emitted in?",
      expected: { best: "trace" },
    },
    {
      // No log attribute holds this.
      input: "Where is customer satisfaction stored?",
      expected: { best: null, allAttributeKeys: [] },
    },
    {
      // A group of attributes.
      input: "Which attributes describe how severe the log is?",
      expected: {
        resultType: "matches",
        matchedKeys: matchesAll(["severity", "severity_number"]),
      },
    },
    {
      // Similar descriptions: worker.queue_wait_time is the configured
      // maximum, not the actual wait.
      input:
        "How long did jobs wait in the queue before a worker picked them up?",
      expected: { best: "worker.queue_wait" },
    },
    {
      // No descriptions: custom.service, custom.component, logger, and module
      // only have their names.
      input: "Which service wrote the log?",
      expected: { best: "custom.service" },
    },
  ],
  task: async (input) => {
    const output = await searchDatasetAttributes(input, "logs");
    return summarize(output);
  },
  scorers: [StructuredOutputScorer({ match: "fuzzy" })],
  timeout: 60000,
});

describeEval("search-attributes-metrics", {
  data: async () => [
    {
      // The list is short enough that no hints are needed.
      input: "What unit is the metric value in?",
      expected: { best: "metric.unit" },
    },
    {
      // No metric attribute holds this.
      input: "Which browser was the user on?",
      expected: { best: null, allAttributeKeys: [] },
    },
    {
      // A group of attributes.
      input: "Which attributes describe the metric itself?",
      expected: {
        resultType: "matches",
        matchedKeys: matchesAll(["metric.name", "metric.type", "metric.unit"]),
      },
    },
    {
      // Similar descriptions: fleet.deployment_region is where the server
      // moves next.
      input: "Which region is the server running in right now?",
      expected: { best: "fleet.region" },
    },
    {
      // No descriptions: payload_size, retry.count, and retry.delay_ms only
      // have their names.
      input: "How many times was the request retried?",
      expected: { best: "retry.count" },
    },
  ],
  task: async (input) => {
    const output = await searchDatasetAttributes(input, "metrics");
    return summarize(output);
  },
  scorers: [StructuredOutputScorer({ match: "fuzzy" })],
  timeout: 60000,
});

const ATTRIBUTES_URL = `https://sentry.io/api/0/organizations/${FIXTURES.organizationSlug}/trace-items/attributes/`;
const ENDPOINT_KEY_CAP = 1000;

function userAttribute(key: string) {
  return {
    key,
    name: key,
    attributeType: "string",
    attributeSource: { source_type: "user" },
  };
}

// the key each dataset's large-org case looks for is past the cut.
const LARGE_ORG_ATTRIBUTES = [
  ...Array.from({ length: ENDPOINT_KEY_CAP }, (_, i) =>
    userAttribute(`app.feature_${String(i).padStart(4, "0")}`),
  ),
  userAttribute("deployment.color"),
  userAttribute("job.queue_name"),
  userAttribute("payment.processor"),
];

/**
 * Behaves like the real endpoint: the substring filter runs over every key
 * before the per-type cap, so only a substring search reaches keys past it.
 */
const largeOrgAttributes = http.get(ATTRIBUTES_URL, ({ request }) => {
  const substring = new URL(request.url).searchParams.get("substringMatch");
  const matching = substring
    ? LARGE_ORG_ATTRIBUTES.filter(({ key }) => key.includes(substring))
    : LARGE_ORG_ATTRIBUTES;
  return HttpResponse.json(matching.slice(0, ENDPOINT_KEY_CAP));
});

describeEval("search-attributes-spans-large-org", {
  data: async () => [
    {
      // Only a hint search can find payment.processor.
      input: "Which payment provider handled the charge?",
      expected: { best: "payment.processor" },
    },
  ],
  beforeEach: () => mswServer.use(largeOrgAttributes),
  afterEach: () => mswServer.resetHandlers(),
  task: async (input) => {
    const output = await searchDatasetAttributes(input, "spans");
    return summarize(output);
  },
  scorers: [StructuredOutputScorer({ match: "fuzzy" })],
  timeout: 60000,
});

describeEval("search-attributes-logs-large-org", {
  data: async () => [
    {
      // Only a hint search can find job.queue_name.
      input: "Which queue did the job run on?",
      expected: { best: "job.queue_name" },
    },
  ],
  beforeEach: () => mswServer.use(largeOrgAttributes),
  afterEach: () => mswServer.resetHandlers(),
  task: async (input) => {
    const output = await searchDatasetAttributes(input, "logs");
    return summarize(output);
  },
  scorers: [StructuredOutputScorer({ match: "fuzzy" })],
  timeout: 60000,
});

describeEval("search-attributes-metrics-large-org", {
  data: async () => [
    {
      // Only a hint search can find deployment.color.
      input: "Was the metric from the blue or the green deployment?",
      expected: { best: "deployment.color" },
    },
  ],
  beforeEach: () => mswServer.use(largeOrgAttributes),
  afterEach: () => mswServer.resetHandlers(),
  task: async (input) => {
    const output = await searchDatasetAttributes(input, "metrics");
    return summarize(output);
  },
  scorers: [StructuredOutputScorer({ match: "fuzzy" })],
  timeout: 60000,
});
