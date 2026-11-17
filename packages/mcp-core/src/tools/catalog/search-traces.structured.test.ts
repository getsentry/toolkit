import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getServerContext } from "../../test-setup.js";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import type { SearchEventsStructuredContent } from "../support/search-events/structured";
import searchTraces, { searchTracesOutputSchema } from "./search-traces";

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

type SearchParams = Parameters<typeof searchTraces.handler>[0];

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
  const result = await searchTraces.handler(
    { ...baseParams, ...params },
    getServerContext(),
  );
  assertStructuredOnlyResult(result);
  const structuredContent =
    getStructuredContent<SearchEventsStructuredContent>(result);
  expect(searchTracesOutputSchema.parse(structuredContent)).toEqual(
    structuredContent,
  );
  return structuredContent;
}

describe("search_traces structured output", () => {
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
        id: "a1b2c3d4e5f60718",
        "span.op": "http.client",
        "span.description": "GET https://api.example.com/users",
        "span.duration": 1234.5,
        transaction: "/api/users",
        timestamp: "2025-01-15T10:30:00+00:00",
        project: "backend",
        trace: "6a477f5b0f31ef7b6b9b5e1dea66c91d",
        secretBackendField: "must-not-leak",
      },
    ]);

    const structuredContent = await runSearch({ query: "span.op:http.client" });

    expect(JSON.stringify(structuredContent)).not.toContain("must-not-leak");
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "executedSearch": {
          "dataset": "spans",
          "fields": [
            "id",
            "span.op",
            "span.description",
            "span.duration",
            "transaction",
            "timestamp",
            "project",
            "trace",
          ],
          "query": "span.op:http.client",
          "sort": "-timestamp",
          "timeRange": {
            "end": null,
            "start": null,
            "statsPeriod": "24h",
          },
        },
        "explanation": null,
        "notes": [
          "span.duration values are in milliseconds.",
        ],
        "presentationHint": "A timeline works well for these traces, with durations and parent-child span relationships visible. Please tell the user this dashboard link is available if they want to open the results in Sentry.",
        "query": "span.op:http.client",
        "resultType": "samples",
        "results": [
          {
            "links": {
              "traceUrl": "https://test-org.sentry.io/explore/traces/trace/6a477f5b0f31ef7b6b9b5e1dea66c91d",
            },
            "values": {
              "id": "a1b2c3d4e5f60718",
              "project": "backend",
              "span.description": "GET https://api.example.com/users",
              "span.duration": 1234.5,
              "span.op": "http.client",
              "timestamp": "2025-01-15T10:30:00+00:00",
              "trace": "6a477f5b0f31ef7b6b9b5e1dea66c91d",
              "transaction": "/api/users",
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
            "reason": "Inspect the trace for the first matching span.",
            "toolName": "get_sentry_resource",
            "type": "tool_call",
          },
        ],
        "timeSeries": null,
        "url": "https://test-org.sentry.io/explore/traces/?query=span.op%3Ahttp.client&field=id&field=span.op&field=span.description&field=span.duration&field=transaction&field=timestamp&field=project&field=trace&sort=-timestamp&statsPeriod=24h&table=span",
      }
    `);
  });

  it("returns aggregate rows", async () => {
    mockEvents([
      {
        transaction: "/api/users",
        "avg(span.duration)": 812.4,
      },
      {
        transaction: "/api/orders",
        "avg(span.duration)": 95.1,
      },
    ]);

    const structuredContent = await runSearch({
      query: "span.op:http.client",
      fields: ["transaction", "avg(span.duration)"],
      sort: "-avg(span.duration)",
    });

    expect(structuredContent.resultType).toBe("aggregates");
    expect(structuredContent.results).toMatchInlineSnapshot(`
      [
        {
          "links": {
            "traceUrl": null,
          },
          "values": {
            "avg(span.duration)": 812.4,
            "transaction": "/api/users",
          },
        },
        {
          "links": {
            "traceUrl": null,
          },
          "values": {
            "avg(span.duration)": 95.1,
            "transaction": "/api/orders",
          },
        },
      ]
    `);
    expect(structuredContent.presentationHint).toMatchInlineSnapshot(
      `"A compact table works well for these aggregate results. Please tell the user this dashboard link is available if they want to open the results in Sentry."`,
    );
  });

  it("explains an empty result in notes", async () => {
    mockEvents([]);

    const structuredContent = await runSearch({ query: "span.op:http.client" });

    expect(structuredContent.results).toEqual([]);
    expect(structuredContent.notes).toEqual([
      "No results found. Try being more specific or using different terms in your search.",
    ]);
    expect(structuredContent.suggestedActions).toEqual([]);
  });
});
