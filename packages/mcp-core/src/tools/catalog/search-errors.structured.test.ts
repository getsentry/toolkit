import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getServerContext } from "../../test-setup.js";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import { translateWithSeer } from "../support/search-events/seer";
import type { SearchEventsStructuredContent } from "../support/search-events/structured";
import searchErrors, { searchErrorsOutputSchema } from "./search-errors";

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

type SearchErrorsParams = Parameters<typeof searchErrors.handler>[0];

const baseParams: Omit<SearchErrorsParams, "query"> = {
  organizationSlug: "test-org",
  regionUrl: null,
  projectSlug: null,
  fields: null,
  sort: null,
  period: "24h",
  limit: 10,
  includeExplanation: false,
};

function mockEventsValidation() {
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
}

async function runSearch(
  params: Partial<SearchErrorsParams> & { query: string },
) {
  const result = await searchErrors.handler(
    { ...baseParams, ...params },
    getServerContext(),
  );
  assertStructuredOnlyResult(result);
  const structuredContent =
    getStructuredContent<SearchEventsStructuredContent>(result);
  expect(searchErrorsOutputSchema.parse(structuredContent)).toEqual(
    structuredContent,
  );
  return structuredContent;
}

describe("search_errors structured output", () => {
  beforeEach(() => {
    vi.mocked(translateWithSeer).mockResolvedValue(null);
    mockEventsValidation();
  });

  it("returns requested fields, issue links, and an issue follow-up", async () => {
    mswServer.use(
      http.get("https://sentry.io/api/0/organizations/test-org/events/", () =>
        HttpResponse.json({
          data: [
            {
              issue: "CLOUDFLARE-MCP-41",
              title: "TypeError: Cannot read properties of undefined",
              project: "cloudflare-mcp",
              timestamp: "2025-01-15T10:30:00+00:00",
              level: "error",
              message: "Cannot read properties of undefined",
              "error.type": "TypeError",
              culprit: "src/handler.ts",
              secretBackendField: "must-not-leak",
            },
          ],
        }),
      ),
    );

    const structuredContent = await runSearch({ query: "level:error" });

    expect(JSON.stringify(structuredContent).includes("must-not-leak")).toBe(
      false,
    );
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "executedSearch": {
          "dataset": "errors",
          "fields": [
            "issue",
            "title",
            "project",
            "timestamp",
            "level",
            "message",
            "error.type",
            "culprit",
            "user.email",
            "user.id",
          ],
          "query": "level:error",
          "sort": "-timestamp",
          "timeRange": {
            "end": null,
            "start": null,
            "statsPeriod": "24h",
          },
        },
        "explanation": null,
        "notes": [],
        "presentationHint": "Useful details to surface include severity, event IDs, and links. Please tell the user this dashboard link is available if they want to open the results in Sentry.",
        "query": "level:error",
        "resultType": "samples",
        "results": [
          {
            "links": {
              "issueUrl": "https://test-org.sentry.io/issues/CLOUDFLARE-MCP-41",
            },
            "values": {
              "culprit": "src/handler.ts",
              "error.type": "TypeError",
              "issue": "CLOUDFLARE-MCP-41",
              "level": "error",
              "message": "Cannot read properties of undefined",
              "project": "cloudflare-mcp",
              "timestamp": "2025-01-15T10:30:00+00:00",
              "title": "TypeError: Cannot read properties of undefined",
            },
          },
        ],
        "suggestedActions": [
          {
            "arguments": {
              "organizationSlug": "test-org",
              "resourceId": "CLOUDFLARE-MCP-41",
              "resourceType": "issue",
            },
            "reason": "Inspect the first matching issue.",
            "toolName": "get_sentry_resource",
            "type": "tool_call",
          },
        ],
        "timeSeries": null,
        "url": "https://test-org.sentry.io/explore/discover/homepage/?dataset=errors&queryDataset=error-events&query=level%3Aerror&field=issue&field=title&field=project&field=timestamp&field=level&field=message&field=error.type&field=culprit&field=user.email&field=user.id&sort=-timestamp&statsPeriod=24h&yAxis=count%28%29",
      }
    `);
  });

  it("returns aggregate rows without a follow-up when no issue is grouped", async () => {
    mswServer.use(
      http.get("https://sentry.io/api/0/organizations/test-org/events/", () =>
        HttpResponse.json({
          data: [
            { project: "cloudflare-mcp", "count()": 42 },
            { project: "backend", "count()": 7 },
          ],
        }),
      ),
    );

    const structuredContent = await runSearch({
      query: "level:error",
      fields: ["project", "count()"],
      sort: "-count()",
    });

    expect(structuredContent.resultType).toBe("aggregates");
    expect(structuredContent.results).toEqual([
      {
        values: { project: "cloudflare-mcp", "count()": 42 },
        links: { issueUrl: null },
      },
      {
        values: { project: "backend", "count()": 7 },
        links: { issueUrl: null },
      },
    ]);
    expect(structuredContent.presentationHint).toContain("compact table");
    expect(structuredContent.suggestedActions).toEqual([]);
  });

  it("explains an empty result in notes", async () => {
    mswServer.use(
      http.get("https://sentry.io/api/0/organizations/test-org/events/", () =>
        HttpResponse.json({ data: [] }),
      ),
    );

    const structuredContent = await runSearch({ query: "level:fatal" });

    expect(structuredContent.results).toEqual([]);
    expect(structuredContent.notes).toEqual([
      "No results found. Try being more specific or using different terms in your search.",
    ]);
    expect(structuredContent.suggestedActions).toEqual([]);
  });

  it("returns a time series with totals, peak, and bucket states", async () => {
    vi.mocked(translateWithSeer).mockResolvedValue({
      query: "level:error",
      fields: [],
      sort: "-count()",
      timeParams: { statsPeriod: "24h" },
      timeSeries: { yAxis: "count()", interval: "1h" },
      crossEventQueries: undefined,
      suggestedProjectIds: [],
      explanation: "Bucketed errors hourly",
      runId: "run-1",
      mode: "time_series",
      organizationFeatures: [],
    } as unknown as Awaited<ReturnType<typeof translateWithSeer>>);
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events-timeseries/",
        () =>
          HttpResponse.json({
            secretResponseField: "must-not-leak",
            timeSeries: [
              {
                yAxis: "count()",
                secretSeriesField: "must-not-leak",
                values: [
                  {
                    timestamp: 1757545200000,
                    value: 2,
                    incomplete: true,
                    incompleteReason: "OUTSIDE_RETENTION",
                  },
                  { timestamp: 1757548800000, value: 5, incomplete: false },
                  {
                    timestamp: 1757552400000,
                    value: 8,
                    incomplete: false,
                    secretBucketField: "must-not-leak",
                  },
                  {
                    timestamp: 1757556000000,
                    value: 3,
                    incomplete: true,
                    incompleteReason: "INGESTION_PENDING",
                  },
                ],
                meta: {
                  interval: 3600000,
                  valueType: "integer",
                  valueUnit: null,
                  secretSeriesMetaField: "must-not-leak",
                },
              },
            ],
            meta: {
              start: 1757545200000,
              end: 1757559600000,
              secretMetaField: "must-not-leak",
              ingestion: {
                status: "healthy",
                delaySeconds: 42,
                completeThrough: 1757556000000,
                secretIngestionField: "must-not-leak",
              },
            },
          }),
      ),
    );

    const structuredContent = await runSearch({
      query: "errors per hour",
      includeExplanation: true,
    });

    expect(JSON.stringify(structuredContent)).not.toContain("must-not-leak");
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "executedSearch": {
          "dataset": "errors",
          "fields": [
            "count()",
          ],
          "query": "level:error",
          "sort": null,
          "timeRange": {
            "end": null,
            "start": null,
            "statsPeriod": "24h",
          },
        },
        "explanation": "Bucketed errors hourly",
        "notes": [],
        "presentationHint": "Please tell the user this dashboard link is available if they want to open the results in Sentry.",
        "query": "errors per hour",
        "resultType": "timeSeries",
        "results": [],
        "suggestedActions": [],
        "timeSeries": {
          "bucketCount": 4,
          "buckets": [
            {
              "incomplete": false,
              "outsideRetention": true,
              "time": "2025-09-10T23:00:00.000Z",
              "value": 2,
            },
            {
              "incomplete": false,
              "outsideRetention": false,
              "time": "2025-09-11T00:00:00.000Z",
              "value": 5,
            },
            {
              "incomplete": false,
              "outsideRetention": false,
              "time": "2025-09-11T01:00:00.000Z",
              "value": 8,
            },
            {
              "incomplete": true,
              "outsideRetention": false,
              "time": "2025-09-11T02:00:00.000Z",
              "value": 3,
            },
          ],
          "ingestion": {
            "completeThrough": "2025-09-11T02:00:00.000Z",
            "delaySeconds": 42,
            "status": "healthy",
          },
          "interval": "1h",
          "peak": {
            "time": "2025-09-11T01:00:00.000Z",
            "value": 8,
          },
          "total": 18,
          "totalIncludesIncompleteBuckets": true,
          "yAxis": "count()",
        },
        "url": "https://test-org.sentry.io/explore/discover/homepage/?dataset=errors&queryDataset=error-events&query=level%3Aerror&project=-1&field=count%28%29&sort=-count%28%29&statsPeriod=24h&mode=aggregate&yAxis=count%28%29",
      }
    `);
  });
});
