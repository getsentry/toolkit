import { mswServer, replayDetailsFixture } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { getServerContext } from "../../test-setup.js";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import {
  type SearchReplaysStructuredContent,
  searchReplaysOutputSchema,
} from "../support/search-events/replays";
import searchReplays from "./search-replays";

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

type SearchParams = Parameters<typeof searchReplays.handler>[0];

const baseParams: Omit<SearchParams, "query"> = {
  organizationSlug: "test-org",
  regionUrl: null,
  projectSlug: null,
  sort: null,
  period: "24h",
  limit: 10,
  includeExplanation: false,
};

function mockReplays(data: Record<string, unknown>[]) {
  mswServer.use(
    http.get("https://sentry.io/api/0/organizations/test-org/replays/", () =>
      HttpResponse.json({ data }),
    ),
    http.get(
      "https://sentry.io/api/0/organizations/test-org/environments/",
      () => HttpResponse.json([{ id: "1", name: "production" }]),
    ),
  );
}

async function runSearch(params: Partial<SearchParams> & { query: string }) {
  const result = await searchReplays.handler(
    { ...baseParams, ...params },
    getServerContext(),
  );
  assertStructuredOnlyResult(result);
  const structuredContent =
    getStructuredContent<SearchReplaysStructuredContent>(result);
  expect(searchReplaysOutputSchema.parse(structuredContent)).toEqual(
    structuredContent,
  );
  return structuredContent;
}

describe("search_replays structured output", () => {
  it("maps replay fields explicitly and suggests follow-ups", async () => {
    mockReplays([
      {
        ...replayDetailsFixture,
        // Pinned so the snapshot doesn't depend on the shared fixture's user.
        user: {
          id: "user-1",
          username: null,
          email: "taylor@example.com",
          ip: "203.0.113.7",
        },
        tags: { secret: ["must-not-leak"] },
        secretBackendField: "must-not-leak",
      },
    ]);

    const structuredContent = await runSearch({
      query: "count_errors:>0",
      sort: "-count_errors",
      environment: "production",
    });

    // Internal fields stay out; the user data Sentry stored comes through.
    expect(JSON.stringify(structuredContent)).not.toContain("must-not-leak");
    expect(structuredContent.replays[0]?.user).toMatchObject({
      email: "taylor@example.com",
      ip: "203.0.113.7",
    });
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "executedSearch": {
          "environment": [
            "production",
          ],
          "query": "count_errors:>0",
          "sort": "-count_errors",
          "timeRange": {
            "end": null,
            "start": null,
            "statsPeriod": "24h",
          },
        },
        "explanation": null,
        "notes": [],
        "presentationHint": "Cards or rows work well for these replays, with replay IDs, user context, duration, click/error counts, and page URLs visible. Please tell the user this dashboard link is available if they want to open the results in Sentry.",
        "query": "count_errors:>0",
        "replays": [
          {
            "browser": {
              "name": "Chrome",
              "version": "123.0",
            },
            "deadClickCount": 1,
            "durationSeconds": 300,
            "environment": "production",
            "errorCount": 1,
            "id": "7e07485f-12f9-416b-8b14-26260799b51f",
            "isArchived": false,
            "rageClickCount": 0,
            "releaseCount": 1,
            "releases": [
              "frontend@1.2.3",
            ],
            "replayUrl": "https://test-org.sentry.io/explore/replays/7e07485f-12f9-416b-8b14-26260799b51f/",
            "startedAt": "2025-04-07T12:00:00.000Z",
            "traceCount": 1,
            "traceIds": [
              "a4d1aae7216b47ff8117cf4e09ce9d0a",
            ],
            "urlCount": 2,
            "urls": [
              "/login",
              "/checkout",
            ],
            "user": {
              "email": "taylor@example.com",
              "id": "user-1",
              "ip": "203.0.113.7",
              "username": null,
            },
          },
        ],
        "suggestedActions": [
          {
            "arguments": {
              "replayUrl": "https://test-org.sentry.io/explore/replays/7e07485f-12f9-416b-8b14-26260799b51f/",
            },
            "reason": "Inspect the first matching replay in more detail.",
            "toolName": "get_replay_details",
            "type": "tool_call",
          },
          {
            "arguments": {
              "organizationSlug": "test-org",
              "resourceId": "a4d1aae7216b47ff8117cf4e09ce9d0a",
              "resourceType": "trace",
            },
            "reason": "Pivot from a replay into its first trace.",
            "toolName": "get_sentry_resource",
            "type": "tool_call",
          },
        ],
        "url": "https://test-org.sentry.io/explore/replays/?query=count_errors%3A%3E0&environment=production&sort=-count_errors&statsPeriod=24h",
      }
    `);
  });

  it("previews long URL, trace, and release lists with their full counts", async () => {
    mockReplays([
      {
        ...replayDetailsFixture,
        urls: Array.from({ length: 8 }, (_, i) => `/page/${i}`),
        trace_ids: Array.from({ length: 7 }, (_, i) => `${i}`.repeat(32)),
        releases: Array.from({ length: 5 }, (_, i) => `frontend@1.${i}.0`),
      },
    ]);

    const structuredContent = await runSearch({ query: "count_errors:>0" });
    const [replay] = structuredContent.replays;

    expect(replay?.urls).toHaveLength(3);
    expect(replay?.urlCount).toBe(8);
    expect(replay?.traceIds).toHaveLength(3);
    expect(replay?.traceCount).toBe(7);
    expect(replay?.releases).toHaveLength(3);
    expect(replay?.releaseCount).toBe(5);
  });

  it("omits the placeholder user on archived replays", async () => {
    mockReplays([
      {
        ...replayDetailsFixture,
        is_archived: true,
        user: { id: "Archived Replay", display_name: "Archived Replay" },
      },
    ]);

    const structuredContent = await runSearch({ query: "count_errors:>0" });
    const [replay] = structuredContent.replays;

    expect(replay?.isArchived).toBe(true);
    expect(replay?.user).toBeNull();
  });

  it("keeps the unknown-environment warning in notes", async () => {
    mockReplays([replayDetailsFixture]);

    const structuredContent = await runSearch({
      query: "count_errors:>0",
      environment: "nonexistent-xyz",
    });

    expect(structuredContent.notes).toHaveLength(1);
    expect(structuredContent.notes[0]).toContain("nonexistent-xyz");
  });

  it("explains an empty result in notes", async () => {
    mockReplays([]);

    const structuredContent = await runSearch({ query: "count_errors:>0" });

    expect(structuredContent.replays).toEqual([]);
    expect(structuredContent.notes).toEqual([
      "No replays found matching your search criteria. Try broadening the query or expanding the time range.",
    ]);
    expect(structuredContent.suggestedActions).toEqual([]);
  });
});
