import { issueFixture, mswServer } from "@sentry/mcp-server-mocks";
import { APICallError, generateText, RetryError } from "ai";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import searchIssues from "./search-issues";
import { prepareToolParams } from "../catalog-runtime/availability";
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

      const result = await searchIssues.handler(
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
      expect(result).toContain(
        "https://tenant.my.sentry.io/organizations/product-org/issues/?project=123&query=is%3Aunresolved",
      );
      expect(result).toContain(
        "[WEB-123](https://tenant.my.sentry.io/organizations/product-org/issues/WEB-123)",
      );
      expect(result).not.toContain("https://product-org.sentry.io");
    },
  );

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

    const result = await searchIssues.handler(
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

    expect(result).toMatchInlineSnapshot(`
      "# Search Results for "unresolved issues"

      **Suggested presentation:** Cards work well for these issues, with status, assignee, and issue ID links visible.

      **View these results in Sentry**:
      https://test-org.sentry.io/issues/?query=is%3Aunresolved
      Please tell the user this dashboard link is available if they want to open the results in Sentry.

      Found **1** issue:

      ## 1. [PROJ-123](https://test-org.sentry.io/issues/PROJ-123)

      **Test Error**

      - **Status**: unresolved
      - **Users**: 50
      - **Events**: 100
      - **First seen**: 2025-01-15
      - **Last seen**: 2025-01-15
      - **Culprit**: \`test.function\`

      ## Next Steps

      - Get more details about a specific issue: Use get_sentry_resource with the issue ID or issue URL
      - Update issue status: Use the Sentry tool \`update_issue\` to resolve or assign issues
      - View event counts: Use search_errors for aggregated statistics
      "
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

    const result = await searchIssues.handler(
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

    expect(result).toContain("No issues found");
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

    const result = await searchIssues.handler(
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

    expect(result).toContain("No issues found");
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

    const result = await searchIssues.handler(
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
    expect(result).toContain("PROJ-123");
    expect(result).toContain("Test Error");
  });

  it("omits update_issue guidance when update_issue is unavailable in the session", async () => {
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

    const result = await searchIssues.handler(
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

    expect(result).toContain("PROJ-123");
    expect(result).not.toContain("Update issue status");
    expect(result).not.toContain("update_issue");
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

    const result = await searchIssues.handler(
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
    expect(result).toContain("PROJ-123");
    expect(result).toContain("Needs Review");
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
        query: "all issues",
        sort: "date",
        projectSlugOrId: " MyProject ",
        regionUrl: null,
        limit: 10,
        period: "30d",
        includeExplanation: false,
      },
      context: mockContext,
    }) as Parameters<typeof searchIssues.handler>[0];

    const result = await searchIssues.handler(params, mockContext);

    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(result).toContain("No issues found");
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

    await searchIssues.handler(
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

    await searchIssues.handler(
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

    await searchIssues.handler(
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

    await searchIssues.handler(
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

    const result = await searchIssues.handler(
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

    expect(result).toContain("Query Translation");
    expect(result).toContain("Test query translation");
  });

  it("should handle empty results", async () => {
    mockGenerateText.mockResolvedValue(mockAIResponse());

    mswServer.use(
      http.get("https://sentry.io/api/0/organizations/*/issues/", () => {
        return HttpResponse.json([]);
      }),
    );

    const result = await searchIssues.handler(
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

    expect(result).toContain("No issues found");
  });

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

    await searchIssues.handler(
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

      await searchIssues.handler(
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

  it("should format issues with proper markdown", async () => {
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

    const result = await searchIssues.handler(
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

    expect(result).toContain("# Search Results");
    expect(result).toContain("PROJ-123");
    expect(result).toContain("Test Error");
    expect(result).toContain("unresolved");
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
});
