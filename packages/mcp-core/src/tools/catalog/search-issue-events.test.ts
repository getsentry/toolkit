import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { mswServer } from "@sentry/mcp-server-mocks";
import searchIssueEvents from "./search-issue-events";
import { APICallError, generateText } from "ai";
import { UserInputError } from "../../errors";
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

describe("search_issue_events", () => {
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
    fields?: string[],
    sort = "-timestamp",
    timeRange?: { statsPeriod: string } | { start: string; end: string } | null,
    errorMessage?: string,
  ) => {
    const defaultFields = [
      "id",
      "timestamp",
      "title",
      "message",
      "level",
      "environment",
      "release",
    ];

    const output = errorMessage
      ? { error: errorMessage }
      : {
          query,
          fields: fields || defaultFields,
          sort,
          timeRange: timeRange ?? null,
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

  it("should search events within a specific issue with issueId", async () => {
    mockGenerateText.mockResolvedValue(
      mockAIResponse("", ["id", "timestamp", "title"], "-timestamp"),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/*/issues/*/events/",
        ({ request }) => {
          const url = new URL(request.url);
          // Endpoint is already scoped to the issue, no issue: in query needed
          const query = url.searchParams.get("query");
          // Query param can be null or empty string when no filters
          expect(query === null || query === "").toBe(true);
          // Return array directly, not wrapped in {data: [...]}
          return HttpResponse.json([
            {
              id: "event1",
              timestamp: "2025-01-15T10:00:00Z",
              title: "Test Error",
            },
          ]);
        },
      ),
    );

    const result = await searchIssueEvents.handler(
      {
        organizationSlug: "test-org",
        issueId: "MCP-41",
        query: "from last hour",
        sort: "-timestamp",
        period: "14d",
        projectSlug: null,
        regionUrl: null,
        limit: 50,
        includeExplanation: false,
      },
      mockContext,
    );

    expect(result).toMatchInlineSnapshot(`
      "# Search Results for "Events in issue MCP-41: from last hour"

      **Suggested presentation:** Useful details to surface include severity, event IDs, and links.

      **View these results in Sentry**:
      https://test-org.sentry.io/explore/discover/homepage/?dataset=errors&queryDataset=error-events&query=issue%3AMCP-41&field=id&field=timestamp&field=title&sort=-timestamp&statsPeriod=14d&yAxis=count%28%29
      Please tell the user this dashboard link is available if they want to open the results in Sentry.

      Found 1 error:

      ## Test Error

      **title**: Test Error
      **timestamp**: 2025-01-15T10:00:00Z

      ## Next Steps

      - Get more details about a specific error: Use the Issue ID
      - View error groups: Navigate to the Issues page in Sentry
      - Set up alerts: Configure alert rules for these error patterns
      "
    `);
  });

  it("falls back to the original query when the AI provider is unavailable", async () => {
    mockGenerateText.mockRejectedValue(
      new APICallError({
        message: "AI provider unavailable",
        url: "https://openrouter.ai/api/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 503,
        isRetryable: true,
      }),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/*/issues/*/events/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("query")).toBe("environment:production");
          return HttpResponse.json([]);
        },
      ),
    );

    const result = await searchIssueEvents.handler(
      {
        organizationSlug: "test-org",
        issueId: "MCP-41",
        query: "environment:production",
        sort: "-timestamp",
        period: "7d",
        projectSlug: null,
        regionUrl: null,
        limit: 50,
        includeExplanation: false,
      },
      mockContext,
    );

    expect(result).toContain("No results found");
  });

  it("defaults empty-string sort during provider fallback", async () => {
    mockGenerateText.mockRejectedValue(
      new APICallError({
        message: "AI provider unavailable",
        url: "https://openrouter.ai/api/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 503,
        isRetryable: true,
      }),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/*/issues/*/events/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("query")).toBe("environment:production");
          return HttpResponse.json([]);
        },
      ),
    );

    const result = await searchIssueEvents.handler(
      {
        organizationSlug: "test-org",
        issueId: "MCP-41",
        query: "environment:production",
        sort: "",
        period: "7d",
        projectSlug: null,
        regionUrl: null,
        limit: 50,
        includeExplanation: false,
      },
      mockContext,
    );

    expect(result).toContain("No results found");
    expect(result).toContain("sort=-timestamp");
  });

  it("should include user geo details in formatted event output", async () => {
    mockGenerateText.mockResolvedValue(
      mockAIResponse("", ["id", "timestamp", "title", "user"], "-timestamp"),
    );

    mswServer.use(
      http.get("https://sentry.io/api/0/organizations/*/issues/*/events/", () =>
        HttpResponse.json([
          {
            id: "event1",
            timestamp: "2025-01-15T10:00:00Z",
            title: "Geo-tagged Error",
            user: {
              id: "3c7631c0121d40e79e2f992ff5cf7671",
              geo: {
                country_code: "US",
                region: "United States",
              },
            },
          },
        ]),
      ),
    );

    const result = await searchIssueEvents.handler(
      {
        organizationSlug: "test-org",
        issueId: "MCP-41",
        query: "events with user details",
        projectSlug: null,
        regionUrl: null,
        limit: 50,
        includeExplanation: false,
      },
      mockContext,
    );

    expect(result).toContain("**user**: id=3c7631c0121d40e79e2f992ff5cf7671");
    expect(result).toContain("**user.geo**: US, United States");
  });

  it("should render geo-only users without duplicating raw user JSON", async () => {
    mockGenerateText.mockResolvedValue(
      mockAIResponse("", ["id", "timestamp", "title", "user"], "-timestamp"),
    );

    mswServer.use(
      http.get("https://sentry.io/api/0/organizations/*/issues/*/events/", () =>
        HttpResponse.json([
          {
            id: "event1",
            timestamp: "2025-01-15T10:00:00Z",
            title: "Geo-only User Error",
            user: {
              geo: {
                country_code: "US",
                region: "United States",
              },
            },
          },
        ]),
      ),
    );

    const result = await searchIssueEvents.handler(
      {
        organizationSlug: "test-org",
        issueId: "MCP-41",
        query: "events with geo-only users",
        projectSlug: null,
        regionUrl: null,
        limit: 50,
        includeExplanation: false,
      },
      mockContext,
    );

    expect(result).not.toContain('**user**: {"geo"');
    expect(result).not.toContain("**user**:");
    expect(result).toContain("**user.geo**: US, United States");
  });

  it("should parse issueUrl and extract organization and issue ID", async () => {
    mockGenerateText.mockResolvedValue(mockAIResponse());

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/*/issues/*/events/",
        ({ request }) => {
          const url = new URL(request.url);
          // Endpoint is scoped to issue, query param can be null or empty
          const query = url.searchParams.get("query");
          expect(query === null || query === "").toBe(true);
          return HttpResponse.json([]);
        },
      ),
    );

    const result = await searchIssueEvents.handler(
      {
        organizationSlug: null,
        issueUrl: "https://sentry.io/organizations/my-org/issues/123/",
        query: "all events",
        sort: "-timestamp",
        period: "14d",
        projectSlug: null,
        regionUrl: null,
        limit: 50,
        includeExplanation: false,
      },
      mockContext,
    );

    expect(result).toContain("Events in issue 123");
  });

  it("rejects issues outside the active project constraint", async () => {
    await expect(
      searchIssueEvents.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          issueId: "CLOUDFLARE-MCP-41",
          query: "from last hour",
          projectSlug: null,
          regionUrl: null,
          limit: 50,
          includeExplanation: false,
        },
        {
          ...mockContext,
          constraints: {
            projectSlug: "frontend",
          },
        },
      ),
    ).rejects.toThrow(
      'Issue is outside the active project constraint. Expected project "frontend".',
    );
  });

  it("should pass user filters to the query parameter", async () => {
    mockGenerateText.mockResolvedValue(
      mockAIResponse(
        "environment:production release:v1.0",
        ["id", "timestamp", "environment", "release"],
        "-timestamp",
      ),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/*/issues/*/events/",
        ({ request }) => {
          const url = new URL(request.url);
          const query = url.searchParams.get("query");
          // Endpoint is scoped to issue, so only user filters in query
          expect(query).toBe("environment:production release:v1.0");
          return HttpResponse.json([]);
        },
      ),
    );

    await searchIssueEvents.handler(
      {
        organizationSlug: "test-org",
        issueId: "MCP-41",
        query: "production with release v1.0",
        sort: "-timestamp",
        period: "14d",
        projectSlug: null,
        regionUrl: null,
        limit: 50,
        includeExplanation: false,
      },
      mockContext,
    );
  });

  it("should handle time range with period", async () => {
    mockGenerateText.mockResolvedValue(
      mockAIResponse("", ["id", "timestamp", "title"], "-timestamp", {
        statsPeriod: "1h",
      }),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/*/issues/*/events/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("statsPeriod")).toBe("1h");
          return HttpResponse.json([]);
        },
      ),
    );

    await searchIssueEvents.handler(
      {
        organizationSlug: "test-org",
        issueId: "MCP-41",
        query: "from last hour",
        sort: "-timestamp",
        period: "14d",
        projectSlug: null,
        regionUrl: null,
        limit: 50,
        includeExplanation: false,
      },
      mockContext,
    );
  });

  it("should handle absolute time range", async () => {
    mockGenerateText.mockResolvedValue(
      mockAIResponse("", ["id", "timestamp", "title"], "-timestamp", {
        start: "2025-01-15T00:00:00Z",
        end: "2025-01-16T00:00:00Z",
      }),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/*/issues/*/events/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("start")).toBe("2025-01-15T00:00:00Z");
          expect(url.searchParams.get("end")).toBe("2025-01-16T00:00:00Z");
          return HttpResponse.json([]);
        },
      ),
    );

    await searchIssueEvents.handler(
      {
        organizationSlug: "test-org",
        issueId: "MCP-41",
        query: "from Jan 15 2025",
        sort: "-timestamp",
        period: "14d",
        projectSlug: null,
        regionUrl: null,
        limit: 50,
        includeExplanation: false,
      },
      mockContext,
    );
  });

  it("should use default 14d time window when no timeRange specified", async () => {
    mockGenerateText.mockResolvedValue(
      mockAIResponse("", ["id", "timestamp"], "-timestamp", null),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/*/issues/*/events/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("statsPeriod")).toBe("14d");
          return HttpResponse.json([]);
        },
      ),
    );

    await searchIssueEvents.handler(
      {
        organizationSlug: "test-org",
        issueId: "MCP-41",
        query: "all events",
        sort: "-timestamp",
        period: "14d",
        projectSlug: null,
        regionUrl: null,
        limit: 50,
        includeExplanation: false,
      },
      mockContext,
    );
  });

  it("should validate sort field is included in fields array", async () => {
    // Agent returns sort field not in fields array (validation should fail)
    mockGenerateText.mockResolvedValue(
      mockAIResponse("", ["id", "title"], "-timestamp"), // timestamp not in fields!
    );

    await expect(
      searchIssueEvents.handler(
        {
          organizationSlug: "test-org",
          issueId: "MCP-41",
          query: "test query",
          sort: "-timestamp",
          period: "14d",
          projectSlug: null,
          regionUrl: null,
          limit: 50,
          includeExplanation: false,
        },
        mockContext,
      ),
    ).rejects.toThrow();
  });

  it("should handle empty results", async () => {
    mockGenerateText.mockResolvedValue(mockAIResponse());

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/*/issues/*/events/",
        () => {
          return HttpResponse.json([]);
        },
      ),
    );

    const result = await searchIssueEvents.handler(
      {
        organizationSlug: "test-org",
        issueId: "MCP-41",
        query: "from last hour",
        sort: "-timestamp",
        period: "14d",
        projectSlug: null,
        regionUrl: null,
        limit: 50,
        includeExplanation: false,
      },
      mockContext,
    );

    expect(result).toContain("No results found");
  });

  it("should throw error when neither issueId nor issueUrl provided", async () => {
    await expect(
      searchIssueEvents.handler(
        {
          organizationSlug: "test-org",
          query: "test",
          sort: "-timestamp",
          period: "14d",
          projectSlug: null,
          regionUrl: null,
          limit: 50,
          includeExplanation: false,
        },
        mockContext,
      ),
    ).rejects.toThrow(UserInputError);
  });

  it("should throw error when issueId provided without organizationSlug", async () => {
    await expect(
      searchIssueEvents.handler(
        {
          organizationSlug: null,
          issueId: "MCP-41",
          query: "test",
          sort: "-timestamp",
          period: "14d",
          projectSlug: null,
          regionUrl: null,
          limit: 50,
          includeExplanation: false,
        },
        mockContext,
      ),
    ).rejects.toThrow(UserInputError);
  });

  it("should throw error for invalid issueUrl format", async () => {
    await expect(
      searchIssueEvents.handler(
        {
          organizationSlug: null,
          issueUrl: "https://invalid-url.com",
          query: "test",
          sort: "-timestamp",
          period: "14d",
          projectSlug: null,
          regionUrl: null,
          limit: 50,
          includeExplanation: false,
        },
        mockContext,
      ),
    ).rejects.toThrow(UserInputError);
  });

  it("should pass through agent query without modification", async () => {
    // Test that the query from the agent is passed directly to the API
    mockGenerateText.mockResolvedValue(
      mockAIResponse(
        "environment:production",
        ["id", "timestamp", "environment"],
        "-timestamp",
      ),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/*/issues/*/events/",
        ({ request }) => {
          const url = new URL(request.url);
          const query = url.searchParams.get("query");
          // No issue: prefix needed - endpoint handles it
          expect(query).toBe("environment:production");
          return HttpResponse.json([]);
        },
      ),
    );

    await searchIssueEvents.handler(
      {
        organizationSlug: "test-org",
        issueId: "MCP-41",
        query: "production events",
        sort: "-timestamp",
        period: "14d",
        projectSlug: null,
        regionUrl: null,
        limit: 50,
        includeExplanation: false,
      },
      mockContext,
    );
  });

  it("should respect custom limit parameter", async () => {
    mockGenerateText.mockResolvedValue(mockAIResponse());

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/*/issues/*/events/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("per_page")).toBe("25");
          return HttpResponse.json([]);
        },
      ),
    );

    await searchIssueEvents.handler(
      {
        organizationSlug: "test-org",
        issueId: "MCP-41",
        query: "test",
        sort: "-timestamp",
        period: "14d",
        projectSlug: null,
        regionUrl: null,
        limit: 25,
        includeExplanation: false,
      },
      mockContext,
    );
  });

  it("should include explanation when requested", async () => {
    mockGenerateText.mockResolvedValue(
      mockAIResponse(
        "environment:production",
        ["id", "timestamp"],
        "-timestamp",
        null,
      ),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/*/issues/*/events/",
        () => {
          return HttpResponse.json([]);
        },
      ),
    );

    const result = await searchIssueEvents.handler(
      {
        organizationSlug: "test-org",
        issueId: "MCP-41",
        query: "production events",
        sort: "-timestamp",
        period: "14d",
        projectSlug: null,
        regionUrl: null,
        limit: 50,
        includeExplanation: true,
      },
      mockContext,
    );

    expect(result).toContain("How I interpreted your query");
  });

  it("should parse alternative issueUrl format (subdomain)", async () => {
    mockGenerateText.mockResolvedValue(mockAIResponse());

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/*/issues/*/events/",
        ({ request }) => {
          const url = new URL(request.url);
          // Endpoint is scoped to issue, query param can be null or empty
          const query = url.searchParams.get("query");
          expect(query === null || query === "").toBe(true);
          return HttpResponse.json([]);
        },
      ),
    );

    await searchIssueEvents.handler(
      {
        organizationSlug: null,
        issueUrl: "https://my-org.sentry.io/issues/456/",
        query: "test",
        sort: "-timestamp",
        period: "14d",
        projectSlug: null,
        regionUrl: null,
        limit: 50,
        includeExplanation: false,
      },
      mockContext,
    );
  });

  it("should search events with direct query syntax (no agent)", async () => {
    process.env.OPENAI_API_KEY = "";
    process.env.ANTHROPIC_API_KEY = "";
    process.env.OPENROUTER_API_KEY = "";

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/*/issues/*/events/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("query")).toBe("environment:production");
          expect(url.searchParams.get("statsPeriod")).toBe("7d");
          return HttpResponse.json([
            {
              id: "event1",
              timestamp: "2025-01-15T10:00:00Z",
              title: "Test Error",
              message: "Something went wrong",
              level: "error",
              environment: "production",
              release: "v1.0",
              "user.display": "alice",
              trace: "abc123",
              url: "/api/endpoint",
            },
          ]);
        },
      ),
    );

    const result = await searchIssueEvents.handler(
      {
        organizationSlug: "test-org",
        issueId: "MCP-41",
        query: "environment:production",
        sort: "-timestamp",
        period: "7d",
        projectSlug: null,
        regionUrl: null,
        limit: 50,
        includeExplanation: false,
      },
      mockContext,
    );

    // Should NOT have called the AI agent
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(result).toContain("Events in issue MCP-41");
    expect(result).toContain("Test Error");
  });
});
