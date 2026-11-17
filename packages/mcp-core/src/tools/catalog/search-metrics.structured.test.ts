import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getServerContext } from "../../test-setup.js";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import type { SearchEventsStructuredContent } from "../support/search-events/structured";
import searchMetrics, { searchMetricsOutputSchema } from "./search-metrics";

vi.mock("../../internal/agents/provider-factory", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../internal/agents/provider-factory")
  >()),
  hasAgentProvider: () => false,
}));

vi.mock("../support/search-events/seer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../support/search-events/seer")>()),
  translateWithSeer: vi.fn(async () => null),
  trackAiQueryOutcome: vi.fn(),
}));

type SearchParams = Parameters<typeof searchMetrics.handler>[0];

const baseParams: Omit<SearchParams, "query"> = {
  organizationSlug: "test-org",
  regionUrl: null,
  projectSlug: null,
  fields: null,
  sort: null,
  period: "24h",
  limit: 10,
  includeExplanation: false,
};

function mockEvents(data: Record<string, unknown>[]) {
  mswServer.use(
    http.get("https://sentry.io/api/0/organizations/test-org/events/", () =>
      HttpResponse.json({ data }),
    ),
  );
}

async function runSearch(params: Partial<SearchParams> & { query: string }) {
  const result = await searchMetrics.handler(
    { ...baseParams, ...params },
    getServerContext(),
  );
  assertStructuredOnlyResult(result);
  const structuredContent =
    getStructuredContent<SearchEventsStructuredContent>(result);
  expect(searchMetricsOutputSchema.parse(structuredContent)).toEqual(
    structuredContent,
  );
  return structuredContent;
}

describe("search_metrics structured output", () => {
  beforeEach(() => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/validate/",
        () =>
          HttpResponse.json({
            valid: true,
            projects: [],
            dataset: [],
            environment: [],
            field: [],
            query: { valid: true, error: null, fields: [] },
            orderby: [],
          }),
      ),
    );
  });

  it("returns requested fields, links, and a follow-up", async () => {
    mockEvents([
      {
        id: "0190a5c3d1f2a3b4c5d6e7f8a9b0c1d2",
        "metric.name": "http.request.duration",
        "metric.type": "distribution",
        "metric.unit": "millisecond",
        value: 182.4,
        project: "backend",
        timestamp: "2025-01-15T10:30:00+00:00",
        trace: "6a477f5b0f31ef7b6b9b5e1dea66c91d",
        secretBackendField: "must-not-leak",
      },
    ]);

    const structuredContent = await runSearch({
      query: "metric.name:http.request.duration",
    });

    expect(JSON.stringify(structuredContent)).not.toContain("must-not-leak");
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "executedSearch": {
          "dataset": "metrics",
          "fields": [
            "id",
            "timestamp",
            "project",
            "trace",
            "metric.name",
            "metric.type",
            "metric.unit",
            "value",
          ],
          "query": "metric.name:http.request.duration",
          "sort": "-timestamp",
          "timeRange": {
            "end": null,
            "start": null,
            "statsPeriod": "24h",
          },
        },
        "explanation": null,
        "notes": [],
        "presentationHint": "Concise summaries work well for these metric samples, highlighting metric name, type, value, and trace context. Please tell the user this dashboard link is available if they want to open the results in Sentry.",
        "query": "metric.name:http.request.duration",
        "resultType": "samples",
        "results": [
          {
            "links": {
              "traceUrl": "https://test-org.sentry.io/explore/traces/trace/6a477f5b0f31ef7b6b9b5e1dea66c91d",
            },
            "values": {
              "id": "0190a5c3d1f2a3b4c5d6e7f8a9b0c1d2",
              "metric.name": "http.request.duration",
              "metric.type": "distribution",
              "metric.unit": "millisecond",
              "project": "backend",
              "timestamp": "2025-01-15T10:30:00+00:00",
              "trace": "6a477f5b0f31ef7b6b9b5e1dea66c91d",
              "value": 182.4,
            },
          },
        ],
        "suggestedActions": [
          {
            "arguments": {
              "organizationSlug": "test-org",
              "resourceId": "6a477f5b0f31ef7b6b9b5e1dea66c91d",
              "resourceType": "trace",
            },
            "reason": "Inspect the trace for the first matching metric sample.",
            "toolName": "get_sentry_resource",
            "type": "tool_call",
          },
        ],
        "timeSeries": null,
        "url": "https://test-org.sentry.io/explore/metrics/?statsPeriod=24h&metric=%7B%22metric%22%3A%7B%22name%22%3A%22http.request.duration%22%2C%22type%22%3A%22distribution%22%2C%22unit%22%3A%22millisecond%22%7D%2C%22query%22%3A%22metric.name%3Ahttp.request.duration%22%2C%22aggregateFields%22%3A%5B%7B%22yAxes%22%3A%5B%22sum%28value%29%22%5D%7D%5D%2C%22aggregateSortBys%22%3A%5B%7B%22field%22%3A%22sum%28value%29%22%2C%22kind%22%3A%22desc%22%7D%5D%2C%22mode%22%3A%22samples%22%7D",
      }
    `);
  });

  it("returns aggregate rows", async () => {
    mockEvents([
      {
        project: "backend",
        "p95(value,http.request.duration,distribution,millisecond)": 412.5,
      },
      {
        project: "frontend",
        "p95(value,http.request.duration,distribution,millisecond)": 98.2,
      },
    ]);

    const structuredContent = await runSearch({
      query: "metric.name:http.request.duration",
      fields: [
        "project",
        "p95(value,http.request.duration,distribution,millisecond)",
      ],
      sort: "-p95(value,http.request.duration,distribution,millisecond)",
    });

    expect(structuredContent.resultType).toBe("aggregates");
    expect(structuredContent.results).toMatchInlineSnapshot(`
      [
        {
          "links": {
            "traceUrl": null,
          },
          "values": {
            "p95(value,http.request.duration,distribution,millisecond)": 412.5,
            "project": "backend",
          },
        },
        {
          "links": {
            "traceUrl": null,
          },
          "values": {
            "p95(value,http.request.duration,distribution,millisecond)": 98.2,
            "project": "frontend",
          },
        },
      ]
    `);
    expect(structuredContent.presentationHint).toMatchInlineSnapshot(
      `"A compact table with grouping labels and units works well for these metric aggregates. Please tell the user this dashboard link is available if they want to open the results in Sentry."`,
    );
  });

  it("explains an empty result in notes", async () => {
    mockEvents([]);

    const structuredContent = await runSearch({
      query: "metric.name:http.request.duration",
    });

    expect(structuredContent.results).toEqual([]);
    expect(structuredContent.notes).toEqual([
      "No results found. Try being more specific about the metric name, type, or filters.",
    ]);
    expect(structuredContent.suggestedActions).toEqual([]);
  });
});
