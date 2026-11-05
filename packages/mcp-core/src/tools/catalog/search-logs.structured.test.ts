import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getServerContext } from "../../test-setup.js";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import type { SearchEventsStructuredContent } from "../support/search-events/structured";
import searchLogs, { searchLogsOutputSchema } from "./search-logs";

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

type SearchParams = Parameters<typeof searchLogs.handler>[0];

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
  const result = await searchLogs.handler(
    { ...baseParams, ...params },
    getServerContext(),
  );
  assertStructuredOnlyResult(result);
  const structuredContent =
    getStructuredContent<SearchEventsStructuredContent>(result);
  expect(searchLogsOutputSchema.parse(structuredContent)).toEqual(
    structuredContent,
  );
  return structuredContent;
}

describe("search_logs structured output", () => {
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
        timestamp: "2025-01-15T10:30:00+00:00",
        severity: "error",
        message: "Timeout after 5000ms",
        project: "backend",
        trace: "6a477f5b0f31ef7b6b9b5e1dea66c91d",
        secretBackendField: "must-not-leak",
      },
    ]);

    const structuredContent = await runSearch({ query: "severity:error" });

    expect(JSON.stringify(structuredContent)).not.toContain("must-not-leak");
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "executedSearch": {
          "dataset": "logs",
          "fields": [
            "timestamp",
            "project",
            "message",
            "severity",
            "trace",
          ],
          "query": "severity:error",
          "sort": "-timestamp",
          "timeRange": {
            "end": null,
            "start": null,
            "statsPeriod": "24h",
          },
        },
        "explanation": null,
        "notes": [],
        "presentationHint": "Console-style formatting works well for these logs, with timestamps preserved. Please tell the user this dashboard link is available if they want to open the results in Sentry.",
        "query": "severity:error",
        "resultType": "samples",
        "results": [
          {
            "links": {
              "logUrl": "https://test-org.sentry.io/explore/logs/?project=-1&logsPinned=0190a5c3d1f2a3b4c5d6e7f8a9b0c1d2",
              "traceUrl": "https://test-org.sentry.io/explore/traces/trace/6a477f5b0f31ef7b6b9b5e1dea66c91d",
            },
            "values": {
              "id": "0190a5c3d1f2a3b4c5d6e7f8a9b0c1d2",
              "message": "Timeout after 5000ms",
              "project": "backend",
              "severity": "error",
              "timestamp": "2025-01-15T10:30:00+00:00",
              "trace": "6a477f5b0f31ef7b6b9b5e1dea66c91d",
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
            "reason": "Inspect the trace for the first matching log.",
            "toolName": "get_sentry_resource",
            "type": "tool_call",
          },
        ],
        "timeSeries": null,
        "url": "https://test-org.sentry.io/explore/logs/?logsQuery=severity%3Aerror&project=-1&logsFields=timestamp&logsFields=project&logsFields=message&logsFields=severity&logsFields=trace&mode=samples&logsSortBys=-timestamp&statsPeriod=24h",
      }
    `);
  });

  it("returns aggregate rows", async () => {
    mockEvents([
      {
        severity: "error",
        "count()": 42,
      },
      {
        severity: "warn",
        "count()": 7,
      },
    ]);

    const structuredContent = await runSearch({
      query: "severity:error",
      fields: ["severity", "count()"],
      sort: "-count()",
    });

    expect(structuredContent.resultType).toBe("aggregates");
    expect(structuredContent.results).toMatchInlineSnapshot(`
      [
        {
          "links": {
            "logUrl": null,
            "traceUrl": null,
          },
          "values": {
            "count()": 42,
            "severity": "error",
          },
        },
        {
          "links": {
            "logUrl": null,
            "traceUrl": null,
          },
          "values": {
            "count()": 7,
            "severity": "warn",
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

    const structuredContent = await runSearch({ query: "severity:error" });

    expect(structuredContent.results).toEqual([]);
    expect(structuredContent.notes).toEqual([
      "No results found. Try being more specific or using different terms in your search.",
    ]);
    expect(structuredContent.suggestedActions).toEqual([]);
  });
});
