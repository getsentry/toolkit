import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getServerContext } from "../../test-setup.js";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import type { SearchEventsStructuredContent } from "../support/search-events/structured";
import searchProfiles, { searchProfilesOutputSchema } from "./search-profiles";

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

type SearchParams = Parameters<typeof searchProfiles.handler>[0];

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

async function runSearch(
  params: Partial<SearchParams> & { query: string },
  context = getServerContext(),
) {
  const result = await searchProfiles.handler(
    { ...baseParams, ...params },
    context,
  );
  assertStructuredOnlyResult(result);
  const structuredContent =
    getStructuredContent<SearchEventsStructuredContent>(result);
  expect(searchProfilesOutputSchema.parse(structuredContent)).toEqual(
    structuredContent,
  );
  return structuredContent;
}

describe("search_profiles structured output", () => {
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
        project: "backend",
        "profile.id": "a1b2c3d4e5f60718293a4b5c6d7e8f90",
        "profiler.id": "",
        "thread.id": "",
        timestamp: "2025-01-15T10:30:00+00:00",
        transaction: "/api/users",
        "transaction.duration": 152000000,
        release: "backend@1.2.3",
        environment: "production",
        trace: "6a477f5b0f31ef7b6b9b5e1dea66c91d",
        "precise.start_ts": "",
        "precise.finish_ts": "",
        secretBackendField: "must-not-leak",
      },
    ]);

    const structuredContent = await runSearch({
      query: "transaction:/api/users",
    });

    expect(JSON.stringify(structuredContent)).not.toContain("must-not-leak");
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "executedSearch": {
          "dataset": "profiles",
          "fields": [
            "project",
            "profile.id",
            "profiler.id",
            "thread.id",
            "timestamp",
            "transaction",
            "transaction.duration",
            "release",
            "environment",
            "trace",
            "precise.start_ts",
            "precise.finish_ts",
          ],
          "query": "transaction:/api/users",
          "sort": "-timestamp",
          "timeRange": {
            "end": null,
            "start": null,
            "statsPeriod": "24h",
          },
        },
        "explanation": null,
        "notes": [
          "transaction.duration values are in nanoseconds.",
        ],
        "presentationHint": "Concise summaries work well for these profiles, highlighting profile ID, transaction, duration, release, and trace context. Please tell the user this dashboard link is available if they want to open the results in Sentry.",
        "query": "transaction:/api/users",
        "resultType": "samples",
        "results": [
          {
            "links": {
              "profileUrl": "https://test-org.sentry.io/explore/profiling/profile/backend/a1b2c3d4e5f60718293a4b5c6d7e8f90/flamegraph/",
              "traceUrl": "https://test-org.sentry.io/explore/traces/trace/6a477f5b0f31ef7b6b9b5e1dea66c91d",
            },
            "values": {
              "environment": "production",
              "precise.finish_ts": "",
              "precise.start_ts": "",
              "profile.id": "a1b2c3d4e5f60718293a4b5c6d7e8f90",
              "profiler.id": "",
              "project": "backend",
              "release": "backend@1.2.3",
              "thread.id": "",
              "timestamp": "2025-01-15T10:30:00+00:00",
              "trace": "6a477f5b0f31ef7b6b9b5e1dea66c91d",
              "transaction": "/api/users",
              "transaction.duration": 152000000,
            },
          },
        ],
        "suggestedActions": [
          {
            "arguments": {
              "profileUrl": "https://test-org.sentry.io/explore/profiling/profile/backend/a1b2c3d4e5f60718293a4b5c6d7e8f90/flamegraph/",
            },
            "reason": "Analyze the flamegraph for the first matching profile.",
            "toolName": "get_profile_details",
            "type": "tool_call",
          },
          {
            "arguments": {
              "organizationSlug": "test-org",
              "resourceId": "6a477f5b0f31ef7b6b9b5e1dea66c91d",
              "resourceType": "trace",
            },
            "reason": "Inspect the trace for the first profiled request.",
            "toolName": "get_sentry_resource",
            "type": "tool_call",
          },
        ],
        "timeSeries": null,
        "url": "https://test-org.sentry.io/explore/profiling/?query=transaction%3A%2Fapi%2Fusers&sort=-timestamp&field=project&field=profile.id&field=profiler.id&field=thread.id&field=timestamp&field=transaction&field=transaction.duration&field=release&field=environment&field=trace&field=precise.start_ts&field=precise.finish_ts&statsPeriod=24h",
      }
    `);
  });

  it("links continuous profiles and routes experimental follow-ups through get_sentry_resource", async () => {
    mockEvents([
      {
        project: "backend",
        "profile.id": "",
        "profiler.id": "041bde57b9844e36b8b7e5734efae5f7",
        "thread.id": "259",
        timestamp: "2025-01-15T10:30:00+00:00",
        transaction: "/api/users",
        "transaction.duration": 152000000,
        release: "backend@1.2.3",
        environment: "production",
        trace: "",
        "precise.start_ts": "2025-01-15T10:30:00.000Z",
        "precise.finish_ts": "2025-01-15T10:30:01.000Z",
      },
    ]);

    const structuredContent = await runSearch(
      { query: "transaction:/api/users" },
      getServerContext({ experimentalMode: true }),
    );

    expect(structuredContent.results[0]?.links).toMatchInlineSnapshot(`
      {
        "profileUrl": "https://test-org.sentry.io/explore/profiling/profile/backend/flamegraph/?profilerId=041bde57b9844e36b8b7e5734efae5f7&start=2025-01-15T10%3A30%3A00.000Z&end=2025-01-15T10%3A30%3A01.000Z",
        "traceUrl": null,
      }
    `);
    expect(structuredContent.suggestedActions).toMatchInlineSnapshot(`
      [
        {
          "arguments": {
            "url": "https://test-org.sentry.io/explore/profiling/profile/backend/flamegraph/?profilerId=041bde57b9844e36b8b7e5734efae5f7&start=2025-01-15T10%3A30%3A00.000Z&end=2025-01-15T10%3A30%3A01.000Z",
          },
          "reason": "Analyze the flamegraph for the first matching profile.",
          "toolName": "get_sentry_resource",
          "type": "tool_call",
        },
      ]
    `);
  });

  it("returns aggregate rows", async () => {
    mockEvents([
      {
        transaction: "/api/users",
        "count()": 42,
        "p95()": 310000000,
      },
    ]);

    const structuredContent = await runSearch({
      query: "transaction:/api/users",
      fields: ["transaction", "count()", "p95()"],
      sort: "-count()",
    });

    expect(structuredContent.resultType).toBe("aggregates");
    expect(structuredContent.results).toMatchInlineSnapshot(`
      [
        {
          "links": {
            "profileUrl": null,
            "traceUrl": null,
          },
          "values": {
            "count()": 42,
            "p95()": 310000000,
            "transaction": "/api/users",
          },
        },
      ]
    `);
    expect(structuredContent.presentationHint).toMatchInlineSnapshot(
      `"A compact table with readable duration units works well for these profile aggregates. Please tell the user this dashboard link is available if they want to open the results in Sentry."`,
    );
  });

  it("explains an empty result in notes", async () => {
    mockEvents([]);

    const structuredContent = await runSearch({
      query: "transaction:/api/users",
    });

    expect(structuredContent.results).toEqual([]);
    expect(structuredContent.notes).toEqual([
      "No results found. Try narrowing the transaction, release, platform, or profile filters.",
    ]);
    expect(structuredContent.suggestedActions).toEqual([]);
  });
});
