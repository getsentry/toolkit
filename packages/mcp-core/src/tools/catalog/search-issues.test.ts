import { issueFixture, mswServer } from "@sentry/mcp-server-mocks";
import { APICallError, generateText, RetryError } from "ai";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import searchIssues from "./search-issues";
import { prepareToolParams } from "../catalog-runtime/availability";
import {
  type SearchIssuesStructuredContent,
  searchIssuesOutputSchema,
} from "../support/search-issues/results";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content";
import type { ServerContext } from "../../types";

// Mock the AI SDK
vi.mock("@ai-sdk/openai", () => {
  const mockModel = vi.fn(() => "mocked-model");
  return {
    openai: mockModel,
    createOpenAI: vi.fn(() => mockModel),
  };
});

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(),
    tool: vi.fn(() => ({ execute: vi.fn() })),
    Output: { object: vi.fn(() => ({})) },
  };
});

const SEER_FEATURES = [
  "mcp-search-events-seer-translate",
  "gen-ai-issues-search",
];

// Sentry only serializes features when explicitly requested.
const mockOrganization = (
  features: string[],
  { hideAiFeatures = false } = {},
) =>
  http.get(
    "https://sentry.io/api/0/organizations/:org/",
    ({ request, params }) =>
      HttpResponse.json({
        id: "1",
        slug: params.org,
        name: "Test Org",
        ...(new URL(request.url).searchParams.get("include_feature_flags") ===
        "1"
          ? { features }
          : {}),
        hideAiFeatures,
      }),
  );

const EMPTY_NOTE =
  "No issues found matching your search criteria. Try adjusting your search criteria or time range.";

async function runSearch(...args: Parameters<typeof searchIssues.handler>) {
  const result = await searchIssues.handler(...args);
  assertStructuredOnlyResult(result);
  const structuredContent =
    getStructuredContent<SearchIssuesStructuredContent>(result);
  expect(searchIssuesOutputSchema.parse(structuredContent)).toEqual(
    structuredContent,
  );
  return structuredContent;
}

describe("search_issues", () => {
  const mockGenerateText = vi.mocked(generateText);
  const mockContext: ServerContext = {
    accessToken: "test-token",
    userId: "user-123",
    clientId: "client-123",
    grantedSkills: new Set(),
    constraints: {},
    sentryHost: "sentry.io",
  };

  // Helper to create AI agent response
  const mockAIResponse = (
    query = "",
    sort: "date" | "freq" | "new" | "user" | "recommended" | null = "date",
    errorMessage?: string,
  ) => {
    const output = errorMessage
      ? { error: errorMessage }
      : {
          query,
          sort,
          explanation: "Test query translation",
        };

    return {
      text: JSON.stringify(output),
      experimental_output: output,
      finishReason: "stop" as const,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      warnings: [] as const,
      experimental_providerMetadata: {
        openai: {
          reasoningTokens: 0,
          cachedPromptTokens: 0,
        },
      },
    } as any;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENROUTER_API_KEY = "";
    mockGenerateText.mockResolvedValue(mockAIResponse());
    // Seer translation stays off unless a test enables it.
    mswServer.use(mockOrganization([]));
  });

  it.each([null, "https://tenant.my.sentry.io"])(
    "returns tenant issue and search links with regionUrl %s",
    async (regionUrl) => {
      mockGenerateText.mockResolvedValue(
        mockAIResponse("is:unresolved", "date"),
      );
      const requests: string[] = [];
      mswServer.use(
        http.get("*/api/0/organizations/product-org/issues/", ({ request }) => {
          requests.push(request.url);
          return HttpResponse.json([{ ...issueFixture, shortId: "WEB-123" }]);
        }),
      );

      const result = await runSearch(
        {
          organizationSlug: "product-org",
          query: "is:unresolved",
          sort: "date",
          projectSlugOrId: "123",
          regionUrl,
          limit: 1,
          period: "24h",
          includeExplanation: false,
        },
        { ...mockContext, sentryHost: "tenant.my.sentry.io" },
      );

      expect(requests).toEqual([
        "https://tenant.my.sentry.io/api/0/organizations/product-org/issues/?limit=1&sort=date&statsPeriod=24h&query=is%3Aunresolved&project=123&collapse=unhandled",
      ]);
      expect(result.url).toBe(
        "https://tenant.my.sentry.io/organizations/product-org/issues/?project=123&query=is%3Aunresolved",
      );
      expect(result.issues[0]?.url).toBe(
        "https://tenant.my.sentry.io/organizations/product-org/issues/WEB-123",
      );
      expect(JSON.stringify(result)).not.toContain(
        "https://product-org.sentry.io",
      );
    },
  );

  it("accepts a 1h period", () => {
    expect(searchIssues.inputSchema.period.parse("1h")).toBe("1h");
  });

  it("should search issues with natural language query", async () => {
    mockGenerateText.mockResolvedValue(mockAIResponse("is:unresolved", "date"));

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/*/issues/",
        ({ request }) => {
          const url = new URL(request.url);
          const query = url.searchParams.get("query");
          expect(query).toBe("is:unresolved");
          return HttpResponse.json([
            {
              id: "123",
              shortId: "PROJ-123",
              title: "Test Error",
              status: "unresolved",
              count: "100",
              userCount: 50,
              firstSeen: "2025-01-15T10:00:00Z",
              lastSeen: "2025-01-15T12:00:00Z",
              permalink: "https://sentry.io/issues/123/",
              project: {
                id: "456",
                slug: "test-project",
                name: "Test Project",
              },
              culprit: "test.function",
            },
          ]);
        },
      ),
    );

    const result = await runSearch(
      {
        organizationSlug: "test-org",
        query: "unresolved issues",
        sort: "date",
        projectSlugOrId: null,
        regionUrl: null,
        limit: 10,
        period: "30d",
        includeExplanation: false,
      },
      mockContext,
    );

    expect(JSON.stringify(result)).not.toContain("permalink");
    expect(result).toMatchInlineSnapshot(`
      {
        "executedSearch": {
          "period": "30d",
          "projectSlugOrId": null,
          "query": "is:unresolved",
          "sort": "date",
        },
        "explanation": null,
        "issues": [
          {
            "assignedTo": null,
            "assigneeEmail": null,
            "culprit": "test.function",
            "firstSeen": "2025-01-15T10:00:00Z",
            "issueCategory": null,
            "lastSeen": "2025-01-15T12:00:00Z",
            "occurrences": 100,
            "projectSlug": "test-project",
            "reporter": null,
            "seerActionability": null,
            "shortId": "PROJ-123",
            "status": "unresolved",
            "substatus": null,
            "title": "Test Error",
            "url": "https://test-org.sentry.io/issues/PROJ-123",
            "usersImpacted": 50,
          },
        ],
        "notes": [],
        "presentationHint": "Cards work well for these issues, with status, assignee, and issue ID links visible. Please tell the user this dashboard link is available if they want to open the results in Sentry.",
        "query": "unresolved issues",
        "suggestedActions": [
          {
            "arguments": {
              "organizationSlug": "test-org",
              "resourceId": "PROJ-123",
              "resourceType": "issue",
            },
            "reason": "Inspect the first matching issue.",
            "toolName": "get_sentry_resource",
            "type": "tool_call",
          },
        ],
        "url": "https://test-org.sentry.io/issues/?query=is%3Aunresolved",
      }
    `);
  });

  it("falls back to the original query when the AI provider is unavailable", async () => {
    mockGenerateText.mockRejectedValue(
      new APICallError({
        message: "Workspace budget exceeded",
        url: "https://openrouter.ai/api/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 402,
        isRetryable: false,
      }),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/*/issues/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("query")).toBe("is:unresolved");
          expect(url.searchParams.get("sort")).toBe("freq");
          return HttpResponse.json([]);
        },
      ),
    );

    const result = await runSearch(
      {
        organizationSlug: "test-org",
        query: "is:unresolved",
        sort: "freq",
        projectSlugOrId: null,
        regionUrl: null,
        limit: 10,
        period: "30d",
        includeExplanation: false,
      },
      mockContext,
    );

    expect(result.issues).toEqual([]);
    expect(result.notes).toEqual([EMPTY_NOTE]);
  });

  it("falls back when the AI SDK wraps a provider outage in RetryError", async () => {
    const serverError = new APICallError({
      message: "Internal server error",
      url: "https://openrouter.ai/api/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 503,
      isRetryable: true,
    });
    mockGenerateText.mockRejectedValue(
      new RetryError({
        message: "Failed after 3 attempts. Last error: Internal server error",
        reason: "maxRetriesExceeded",
        errors: [serverError, serverError, serverError],
      }),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/*/issues/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("query")).toBe("is:unresolved");
          expect(url.searchParams.get("sort")).toBe("date");
          return HttpResponse.json([]);
        },
      ),
    );

    const result = await runSearch(
      {
        organizationSlug: "test-org",
        query: "is:unresolved",
        sort: "date",
        projectSlugOrId: null,
        regionUrl: null,
        limit: 10,
        period: "30d",
        includeExplanation: false,
      },
      mockContext,
    );

    expect(result.issues).toEqual([]);
    expect(result.notes).toEqual([EMPTY_NOTE]);
  });

  it("should search issues with direct query syntax (no agent)", async () => {
    process.env.OPENAI_API_KEY = "";
    process.env.ANTHROPIC_API_KEY = "";
    process.env.OPENROUTER_API_KEY = "";

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/*/issues/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("query")).toBe(
            "is:unresolved is:unassigned",
          );
          expect(url.searchParams.get("sort")).toBe("freq");
          return HttpResponse.json([
            {
              id: "123",
              shortId: "PROJ-123",
              title: "Test Error",
              status: "unresolved",
              count: "100",
              userCount: 50,
              firstSeen: "2025-01-15T10:00:00Z",
              lastSeen: "2025-01-15T12:00:00Z",
              permalink: "https://sentry.io/issues/123/",
              project: {
                id: "456",
                slug: "test-project",
                name: "Test Project",
              },
              culprit: "test.function",
            },
          ]);
        },
      ),
    );

    const result = await runSearch(
      {
        organizationSlug: "test-org",
        query: "is:unresolved is:unassigned",
        sort: "freq",
        projectSlugOrId: null,
        regionUrl: null,
        limit: 10,
        period: "30d",
        includeExplanation: false,
      },
      mockContext,
    );

    // Should NOT have called the AI agent
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(result.issues.map(({ shortId, title }) => [shortId, title])).toEqual(
      [["PROJ-123", "Test Error"]],
    );
  });

  it("suggests only follow-ups the session can call", async () => {
    process.env.OPENAI_API_KEY = "";
    process.env.ANTHROPIC_API_KEY = "";
    process.env.OPENROUTER_API_KEY = "";

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/*/issues/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("query")).toBe("is:unresolved");
          return HttpResponse.json([
            {
              id: "123",
              shortId: "PROJ-123",
              title: "Test Error",
              status: "unresolved",
              count: "100",
              userCount: 50,
              firstSeen: "2025-01-15T10:00:00Z",
              lastSeen: "2025-01-15T12:00:00Z",
              permalink: "https://sentry.io/issues/123/",
              project: {
                id: "456",
                slug: "test-project",
                name: "Test Project",
              },
              culprit: "test.function",
            },
          ]);
        },
      ),
    );

    const result = await runSearch(
      {
        organizationSlug: "test-org",
        query: "is:unresolved",
        sort: "date",
        projectSlugOrId: null,
        regionUrl: null,
        limit: 10,
        period: "30d",
        includeExplanation: false,
      },
      {
        ...mockContext,
        availableToolNames: new Set([
          "execute_sentry_tool",
          "find_organizations",
          "find_projects",
          "get_sentry_resource",
          "search_events",
          "search_issues",
          "search_sentry_tools",
        ]),
        directToolNames: new Set([
          "execute_sentry_tool",
          "find_organizations",
          "find_projects",
          "get_sentry_resource",
          "search_events",
          "search_issues",
          "search_sentry_tools",
        ]),
      },
    );

    expect(result.issues.map((issue) => issue.shortId)).toEqual(["PROJ-123"]);
    expect(result.suggestedActions.map((action) => action.toolName)).toEqual([
      "get_sentry_resource",
    ]);
  });

  it("should preserve explicit query syntax through agent repair", async () => {
    const explicitQuery =
      "is:for_review release:latest assigned:me issue.priority:high";
    mockGenerateText.mockResolvedValue(mockAIResponse(explicitQuery, "date"));

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/*/issues/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("query")).toBe(explicitQuery);
          expect(url.searchParams.get("sort")).toBe("date");
          return HttpResponse.json([
            {
              id: "123",
              shortId: "PROJ-123",
              title: "Needs Review",
              status: "unresolved",
              count: "5",
              userCount: 2,
              firstSeen: "2025-01-15T10:00:00Z",
              lastSeen: "2025-01-15T12:00:00Z",
              permalink: "https://sentry.io/issues/123/",
              culprit: "test.function",
              project: {
                id: "456",
                slug: "test-project",
                name: "Test Project",
              },
            },
          ]);
        },
      ),
    );

    const result = await runSearch(
      {
        organizationSlug: "test-org",
        query: explicitQuery,
        sort: "date",
        projectSlugOrId: null,
        regionUrl: null,
        limit: 10,
        period: "30d",
        includeExplanation: false,
      },
      mockContext,
    );

    expect(mockGenerateText).toHaveBeenCalled();
    expect(result.executedSearch.query).toBe(explicitQuery);
    expect(result.issues.map(({ shortId, title }) => [shortId, title])).toEqual(
      [["PROJ-123", "Needs Review"]],
    );
  });

  it("should handle project slug parameter", async () => {
    process.env.OPENAI_API_KEY = "";
    process.env.ANTHROPIC_API_KEY = "";
    process.env.OPENROUTER_API_KEY = "";

    mswServer.use(
      http.get("https://sentry.io/api/0/projects/*/*/", ({ request }) => {
        expect(new URL(request.url).pathname).toBe(
          "/api/0/projects/MyOrg/MyProject/",
        );
        return HttpResponse.json({
          id: "789",
          slug: "MyProject",
          name: "My Project",
        });
      }),
      http.get(
        "https://sentry.io/api/0/organizations/*/issues/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.pathname).toBe("/api/0/organizations/MyOrg/issues/");
          expect(url.searchParams.get("project")).toBe("789");
          expect(url.searchParams.get("statsPeriod")).toBe("30d");
          return HttpResponse.json([]);
        },
      ),
    );

    const params = prepareToolParams({
      tool: searchIssues,
      params: {
        organizationSlug: " MyOrg ",
        query: "is:unresolved",
        sort: "date",
        projectSlugOrId: " MyProject ",
        regionUrl: null,
        limit: 10,
        period: "30d",
        includeExplanation: false,
      },
      context: mockContext,
    }) as Parameters<typeof searchIssues.handler>[0];

    const result = await runSearch(params, mockContext);

    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(result.issues).toEqual([]);
    expect(result.notes).toEqual([EMPTY_NOTE]);
  });

  it("should handle numeric project ID", async () => {
    mockGenerateText.mockResolvedValue(mockAIResponse("", "date"));

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/*/issues/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("project")).toBe("123456");
          expect(url.searchParams.get("statsPeriod")).toBe("30d");
          return HttpResponse.json([]);
        },
      ),
    );

    await runSearch(
      {
        organizationSlug: "test-org",
        query: "all issues",
        sort: "date",
        projectSlugOrId: "123456",
        regionUrl: null,
        limit: 10,
        period: "30d",
        includeExplanation: false,
      },
      mockContext,
    );
  });

  it("should pass sort parameter to API", async () => {
    mockGenerateText.mockResolvedValue(mockAIResponse("", "freq"));

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/*/issues/",
        ({ request }) => {
          const url = new URL(request.url);
          const sort = url.searchParams.get("sort");
          expect(sort).toBe("freq");
          return HttpResponse.json([]);
        },
      ),
    );

    await runSearch(
      {
        organizationSlug: "test-org",
        query: "most frequent errors",
        sort: "date",
        projectSlugOrId: null,
        regionUrl: null,
        limit: 10,
        period: "30d",
        includeExplanation: false,
      },
      mockContext,
    );
  });

  it("should default to date sort when agent returns null", async () => {
    mockGenerateText.mockResolvedValue(mockAIResponse("", null));

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/*/issues/",
        ({ request }) => {
          const url = new URL(request.url);
          const sort = url.searchParams.get("sort");
          expect(sort).toBe("date");
          return HttpResponse.json([]);
        },
      ),
    );

    await runSearch(
      {
        organizationSlug: "test-org",
        query: "all issues",
        sort: "date",
        projectSlugOrId: null,
        regionUrl: null,
        limit: 10,
        period: "30d",
        includeExplanation: false,
      },
      mockContext,
    );
  });

  it("should respect custom limit parameter", async () => {
    mockGenerateText.mockResolvedValue(mockAIResponse());

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/*/issues/",
        ({ request }) => {
          const url = new URL(request.url);
          const limit = url.searchParams.get("limit");
          expect(limit).toBe("25");
          return HttpResponse.json([]);
        },
      ),
    );

    await runSearch(
      {
        organizationSlug: "test-org",
        query: "test",
        sort: "date",
        projectSlugOrId: null,
        regionUrl: null,
        limit: 25,
        period: "30d",
        includeExplanation: false,
      },
      mockContext,
    );
  });

  it("should include explanation when requested", async () => {
    mockGenerateText.mockResolvedValue(mockAIResponse("is:unresolved", "date"));

    mswServer.use(
      http.get("https://sentry.io/api/0/organizations/*/issues/", () => {
        return HttpResponse.json([]);
      }),
    );

    const result = await runSearch(
      {
        organizationSlug: "test-org",
        query: "unresolved issues",
        sort: "date",
        projectSlugOrId: null,
        regionUrl: null,
        limit: 10,
        period: "30d",
        includeExplanation: true,
      },
      mockContext,
    );

    expect(result.explanation).toBe("Test query translation");
    expect(result.executedSearch).toEqual({
      query: "is:unresolved",
      sort: "date",
      period: "30d",
      projectSlugOrId: null,
    });
  });

  it("should handle empty results", async () => {
    mockGenerateText.mockResolvedValue(mockAIResponse());

    mswServer.use(
      http.get("https://sentry.io/api/0/organizations/*/issues/", () => {
        return HttpResponse.json([]);
      }),
    );

    const result = await runSearch(
      {
        organizationSlug: "test-org",
        query: "nonexistent issues",
        sort: "date",
        projectSlugOrId: null,
        regionUrl: null,
        limit: 10,
        period: "30d",
        includeExplanation: false,
      },
      mockContext,
    );

    expect(result.issues).toEqual([]);
    expect(result.notes).toEqual([EMPTY_NOTE]);
  });

  it.each([
    [
      "top unresolved errors today",
      [
        "`query` was not translated from natural language because no embedded agent or Seer translation was available, so Sentry searched for it as literal text and found nothing. Retry with Sentry search syntax, such as `is:unresolved level:error`, and use `period` for the time range.",
        EMPTY_NOTE,
      ],
    ],
    ["is:unresolved level:error", [EMPTY_NOTE]],
    ["firstSeen:-24h userCount:>100", [EMPTY_NOTE]],
    ["TypeError", [EMPTY_NOTE]],
    ['"connection reset by peer"', [EMPTY_NOTE]],
  ])(
    "notes an untranslated natural-language query that finds nothing (no agent): %s",
    async (query, notes) => {
      process.env.OPENAI_API_KEY = "";
      process.env.ANTHROPIC_API_KEY = "";
      process.env.OPENROUTER_API_KEY = "";
      mswServer.use(
        http.get("https://sentry.io/api/0/organizations/*/issues/", () =>
          HttpResponse.json([]),
        ),
      );

      const result = await runSearch(
        {
          organizationSlug: "test-org",
          query,
          sort: "date",
          projectSlugOrId: null,
          regionUrl: null,
          limit: 10,
          period: "30d",
          includeExplanation: false,
        },
        mockContext,
      );

      expect(mockGenerateText).not.toHaveBeenCalled();
      expect(result.notes).toEqual(notes);
    },
  );

  it("should pass agent query directly to API", async () => {
    mockGenerateText.mockResolvedValue(
      mockAIResponse("is:unresolved level:error", "date"),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/*/issues/",
        ({ request }) => {
          const url = new URL(request.url);
          const query = url.searchParams.get("query");
          expect(query).toBe("is:unresolved level:error");
          return HttpResponse.json([]);
        },
      ),
    );

    await runSearch(
      {
        organizationSlug: "test-org",
        query: "unresolved errors",
        sort: "date",
        projectSlugOrId: null,
        regionUrl: null,
        limit: 10,
        period: "30d",
        includeExplanation: false,
      },
      mockContext,
    );
  });

  it("should handle all sort options", async () => {
    const sortOptions: Array<"date" | "freq" | "new" | "user" | "recommended"> =
      ["date", "freq", "new", "user", "recommended"];

    for (const sortOption of sortOptions) {
      mockGenerateText.mockResolvedValue(mockAIResponse("", sortOption));

      mswServer.use(
        http.get(
          "https://sentry.io/api/0/organizations/*/issues/",
          ({ request }) => {
            const url = new URL(request.url);
            const sort = url.searchParams.get("sort");
            expect(sort).toBe(sortOption);
            return HttpResponse.json([]);
          },
        ),
      );

      await runSearch(
        {
          organizationSlug: "test-org",
          query: "test",
          sort: "date",
          projectSlugOrId: null,
          regionUrl: null,
          limit: 10,
          period: "30d",
          includeExplanation: false,
        },
        mockContext,
      );
    }
  });

  it("maps issue fields without the upstream passthrough", async () => {
    mockGenerateText.mockResolvedValue(mockAIResponse("", "date"));

    mswServer.use(
      http.get("https://sentry.io/api/0/organizations/*/issues/", () => {
        return HttpResponse.json([
          {
            id: "123",
            shortId: "PROJ-123",
            title: "Test Error",
            status: "unresolved",
            count: "100",
            userCount: 50,
            level: "error",
            firstSeen: "2025-01-15T10:00:00Z",
            lastSeen: "2025-01-15T12:00:00Z",
            permalink: "https://sentry.io/issues/123/",
            project: {
              id: "456",
              slug: "test-project",
              name: "Test Project",
            },
            culprit: "test.function",
          },
        ]);
      }),
    );

    const result = await runSearch(
      {
        organizationSlug: "test-org",
        query: "all issues",
        sort: "date",
        projectSlugOrId: null,
        regionUrl: null,
        limit: 10,
        period: "30d",
        includeExplanation: false,
      },
      mockContext,
    );

    expect(result.query).toBe("all issues");
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      shortId: "PROJ-123",
      title: "Test Error",
      status: "unresolved",
      occurrences: 100,
      usersImpacted: 50,
    });
    expect(result.issues[0]).not.toHaveProperty("level");
  });

  it("rewrites unsupported OR and parentheses before calling the API (no agent)", async () => {
    process.env.OPENAI_API_KEY = "";
    process.env.ANTHROPIC_API_KEY = "";
    process.env.OPENROUTER_API_KEY = "";

    let sentQuery: string | null = null;
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/*/issues/",
        ({ request }) => {
          sentQuery = new URL(request.url).searchParams.get("query");
          return HttpResponse.json([]);
        },
      ),
    );

    const result = await runSearch(
      {
        organizationSlug: "test-org",
        query: "is:unresolved (is:regressed OR is:escalating)",
        sort: "date",
        projectSlugOrId: null,
        regionUrl: null,
        limit: 10,
        period: "30d",
        includeExplanation: false,
      },
      mockContext,
    );

    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(sentQuery).toBe("is:unresolved substatus:[regressed,escalating]");
    expect(result.executedSearch.query).toBe(
      "is:unresolved substatus:[regressed,escalating]",
    );
    expect(result.notes[0]).toContain(
      "Ran `is:unresolved substatus:[regressed,escalating]`.",
    );
  });

  it("rejects agent output that issue search can't express", async () => {
    mockGenerateText.mockResolvedValue(
      mockAIResponse("level:error OR assigned:me", "date"),
    );

    const listIssues = vi.fn(() => HttpResponse.json([]));
    mswServer.use(
      http.get("https://sentry.io/api/0/organizations/*/issues/", listIssues),
    );

    await expect(
      searchIssues.handler(
        {
          organizationSlug: "test-org",
          query: "errors or anything assigned to me",
          sort: "date",
          projectSlugOrId: null,
          regionUrl: null,
          limit: 10,
          period: "30d",
          includeExplanation: false,
        },
        mockContext,
      ),
    ).rejects.toMatchObject({
      name: "UserInputError",
      message: expect.stringContaining(
        "Sentry query: level:error OR assigned:me",
      ),
    });
    expect(listIssues).not.toHaveBeenCalled();
  });

  it("should validate project slug format", async () => {
    await expect(
      searchIssues.handler(
        {
          organizationSlug: "test-org",
          query: "test",
          sort: "date",
          projectSlugOrId: "invalid@slug",
          regionUrl: null,
          limit: 10,
          period: "30d",
          includeExplanation: false,
        },
        mockContext,
      ),
    ).rejects.toThrow();
  });

  it("should handle API errors gracefully", async () => {
    mockGenerateText.mockResolvedValue(mockAIResponse());

    mswServer.use(
      http.get("https://sentry.io/api/0/organizations/*/issues/", () => {
        return HttpResponse.json(
          { detail: "Organization not found" },
          { status: 404 },
        );
      }),
    );

    await expect(
      searchIssues.handler(
        {
          organizationSlug: "nonexistent-org",
          query: "test",
          sort: "date",
          projectSlugOrId: null,
          regionUrl: null,
          limit: 10,
          period: "30d",
          includeExplanation: false,
        },
        mockContext,
      ),
    ).rejects.toThrow();
  });
  describe("with Seer", () => {
    const seerParams = {
      organizationSlug: "test-org",
      query: "my unresolved issues from the last day",
      sort: "date" as const,
      projectSlugOrId: "123",
      regionUrl: null,
      limit: 10,
      period: "30d" as const,
      includeExplanation: true,
    };
    const seerQuery = {
      query: "is:unresolved assigned_or_suggested:me",
      sort: "freq",
      group_by: [],
      visualization: [],
      mode: "",
      stats_period: "24h",
      start: null,
      end: null,
    };
    const mockSeerStart = vi.fn(async ({ request }: { request: Request }) => {
      expect(await request.json()).toEqual({
        project_ids: [123],
        natural_language_query: seerParams.query,
        strategy: "Issues",
      });
      return HttpResponse.json({ run_id: 1, sentry_run_id: "run-uuid" });
    });
    const mockSeerState = (response: Record<string, unknown>) =>
      http.get(
        "https://sentry.io/api/0/organizations/test-org/search-agent/state/run-uuid/",
        () =>
          HttpResponse.json({
            session: { status: "completed", final_response: response },
            sentry_run_id: "run-uuid",
          }),
      );
    const issueRequests: URL[] = [];

    beforeEach(() => {
      mockSeerStart.mockClear();
      issueRequests.length = 0;
      mswServer.use(
        http.post(
          "https://sentry.io/api/0/organizations/test-org/search-agent/start/",
          mockSeerStart,
        ),
        http.get(
          "https://sentry.io/api/0/organizations/*/issues/",
          ({ request }) => {
            issueRequests.push(new URL(request.url));
            return HttpResponse.json([]);
          },
        ),
      );
    });

    it("translates natural language with Seer's Issues strategy", async () => {
      mswServer.use(
        mockOrganization(SEER_FEATURES),
        mockSeerState({ responses: [seerQuery], unsupported_reason: null }),
      );

      const result = await runSearch(seerParams, mockContext);

      expect(mockSeerStart).toHaveBeenCalledTimes(1);
      expect(mockGenerateText).not.toHaveBeenCalled();
      expect(
        issueRequests.map((url) => Object.fromEntries(url.searchParams)),
      ).toEqual([
        expect.objectContaining({
          query: "is:unresolved assigned_or_suggested:me",
          sort: "freq",
          statsPeriod: "24h",
          project: "123",
        }),
      ]);
      expect(result.explanation).toBe("Translated by Seer's search agent.");
      expect(result.executedSearch).toMatchObject({
        sort: "freq",
        period: "24h",
      });
    });

    it("keeps the requested sort and period when Seer returns neither", async () => {
      mswServer.use(
        mockOrganization(SEER_FEATURES),
        mockSeerState({
          responses: [{ ...seerQuery, sort: "trends", stats_period: "" }],
        }),
      );

      await runSearch(seerParams, mockContext);

      expect(issueRequests[0]?.searchParams.get("sort")).toBe("date");
      expect(issueRequests[0]?.searchParams.get("statsPeriod")).toBe("30d");
    });

    it("falls back to the agent when Seer returns an absolute time range", async () => {
      mockGenerateText.mockResolvedValue(
        mockAIResponse("is:unresolved", "date"),
      );
      mswServer.use(
        mockOrganization(SEER_FEATURES),
        mockSeerState({
          responses: [
            {
              ...seerQuery,
              stats_period: "",
              start: "2026-01-01T00:00:00",
              end: "2026-01-02T00:00:00",
            },
          ],
        }),
      );

      await runSearch(seerParams, mockContext);

      expect(mockSeerStart).toHaveBeenCalled();
      expect(mockGenerateText).toHaveBeenCalled();
      expect(issueRequests[0]?.searchParams.get("query")).toBe("is:unresolved");
    });

    it.each([
      ["the rollout flag is off", ["gen-ai-issues-search"], {}],
      ["issues search is off", ["mcp-search-events-seer-translate"], {}],
      ["AI features are hidden", SEER_FEATURES, { hideAiFeatures: true }],
    ])("falls back to the agent when %s", async (_name, features, options) => {
      mockGenerateText.mockResolvedValue(
        mockAIResponse("is:unresolved", "date"),
      );
      mswServer.use(mockOrganization(features, options));

      await runSearch(seerParams, mockContext);

      expect(mockSeerStart).not.toHaveBeenCalled();
      expect(mockGenerateText).toHaveBeenCalled();
      expect(issueRequests[0]?.searchParams.get("query")).toBe("is:unresolved");
    });

    it("falls back to the agent when Seer returns 403", async () => {
      mockGenerateText.mockResolvedValue(
        mockAIResponse("is:unresolved", "date"),
      );
      mswServer.use(
        mockOrganization(SEER_FEATURES),
        http.get(
          "https://sentry.io/api/0/organizations/test-org/search-agent/state/run-uuid/",
          () => HttpResponse.json({ detail: "Forbidden" }, { status: 403 }),
        ),
      );

      await runSearch(seerParams, mockContext);

      expect(mockSeerStart).toHaveBeenCalled();
      expect(mockGenerateText).toHaveBeenCalled();
      expect(issueRequests[0]?.searchParams.get("query")).toBe("is:unresolved");
    });

    it.each(["is:unresolved", "firstSeen:-24h", "userCount:>100"])(
      "skips Seer for Sentry search syntax %s",
      async (query) => {
        mockGenerateText.mockResolvedValue(mockAIResponse(query, "date"));
        mswServer.use(mockOrganization(SEER_FEATURES));

        await runSearch({ ...seerParams, query }, mockContext);

        expect(mockSeerStart).not.toHaveBeenCalled();
      },
    );
  });
});
