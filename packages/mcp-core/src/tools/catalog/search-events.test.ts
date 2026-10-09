import { mswServer } from "@sentry/mcp-server-mocks";
import { APICallError, generateText } from "ai";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UserInputError } from "../../errors";
import { runSearchEvents } from "../support/search-events/search";
import searchEvents from "./search-events";

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

describe("search_events", () => {
  const mockGenerateText = vi.mocked(generateText);

  // Helper to create AI response for different datasets
  const mockAIResponse = (
    dataset: "errors" | "logs" | "spans" | "metrics" | "profiles" | "replays",
    query = "test query",
    fields?: string[],
    errorMessage?: string,
    sort?: string,
    timeRange?: { statsPeriod: string } | { start: string; end: string },
    environment?: string | string[] | null,
  ) => {
    const defaultFields = {
      errors: ["issue", "title", "project", "timestamp", "level", "message"],
      logs: ["timestamp", "project", "message", "severity", "trace"],
      spans: [
        "span.op",
        "span.description",
        "span.duration",
        "transaction",
        "timestamp",
        "project",
      ],
      metrics: [
        "timestamp",
        "project",
        "metric.name",
        "metric.type",
        "metric.unit",
        "value",
        "trace",
      ],
      profiles: [
        "project",
        "profile.id",
        "timestamp",
        "transaction",
        "transaction.duration",
        "release",
        "trace",
      ],
      replays: [],
    };

    const defaultSorts = {
      errors: "-timestamp",
      logs: "-timestamp",
      spans: "-span.duration",
      metrics: "-timestamp",
      profiles: "-timestamp",
      replays: "-started_at",
    };

    const output = errorMessage
      ? { error: errorMessage }
      : {
          dataset,
          query,
          fields: fields ?? defaultFields[dataset],
          sort: sort ?? defaultSorts[dataset],
          environment: environment ?? null,
          timeRange: timeRange ?? null,
          explanation: "Test query translation",
        };

    return {
      text: JSON.stringify(output),
      experimental_output: output,
      finishReason: "stop" as const,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      warnings: [] as const,
    } as any;
  };

  const validEventsValidationResponse = {
    valid: true,
    projects: [],
    dataset: [],
    environment: [],
    field: [],
    query: { valid: true, error: null, fields: [] },
    orderby: [],
  };

  const mockValidEventsValidation = () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/:orgSlug/events/validate/",
        () => HttpResponse.json(validEventsValidationResponse),
      ),
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENROUTER_API_KEY = "";
    mockGenerateText.mockResolvedValue(mockAIResponse("errors"));
    mockValidEventsValidation();
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
        "https://sentry.io/api/0/organizations/test-org/events/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("dataset")).toBe("errors");
          expect(url.searchParams.get("query")).toBe("level:error");
          expect(url.searchParams.get("sort")).toBe("-timestamp");
          return HttpResponse.json({ data: [] });
        },
      ),
    );

    const result = await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        dataset: "errors",
        query: "level:error",
        fields: null,
        sort: null,
        period: "24h",
        limit: 10,
        includeExplanation: false,
      },
      {
        accessToken: "test-token",
        userId: "user-123",
        clientId: "client-123",
        grantedSkills: new Set(),
        constraints: {},
        sentryHost: "sentry.io",
      },
    );

    expect(result).toContain("No results found");
  });

  it("renders a timeseries when the agent returns timeSeries (per-hour)", async () => {
    const output = {
      dataset: "errors" as const,
      query: "",
      fields: [] as string[],
      sort: "-timestamp",
      environment: null,
      timeSeries: { yAxis: "count()", interval: "1h" },
      timeRange: { statsPeriod: "24h" },
      explanation: "Bucketed errors hourly",
    };
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify(output),
      experimental_output: output,
      finishReason: "stop" as const,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      warnings: [] as const,
    } as any);

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events-timeseries/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("yAxis")).toBe("count()");
          expect(url.searchParams.get("interval")).toBe("1h");
          expect(url.searchParams.get("dataset")).toBe("errors");
          return HttpResponse.json({
            timeSeries: [
              {
                yAxis: "count()",
                values: [
                  { timestamp: 1757548800000, value: 5, incomplete: false },
                  { timestamp: 1757552400000, value: 8, incomplete: false },
                  { timestamp: 1757556000000, value: 3, incomplete: false },
                ],
                meta: {
                  interval: 3600000,
                  valueType: "integer",
                  valueUnit: null,
                },
              },
            ],
          });
        },
      ),
    );

    const result = await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        dataset: "errors",
        query: "errors per hour",
        fields: null,
        sort: null,
        period: "24h",
        limit: 10,
        includeExplanation: false,
      },
      {
        accessToken: "test-token",
        userId: "user-123",
        clientId: "client-123",
        grantedSkills: new Set(),
        constraints: {},
        sentryHost: "sentry.io",
      },
    );

    expect(result).toContain("count() over time");
    expect(result).toContain("**Interval**: `1h`");
    expect(result).toContain("**Total**: 16");
    expect(result).toContain("**Peak**: 8");
    expect(result).toContain("| Time (UTC) | Value |");
  });

  it("omits Total for non-additive timeseries aggregates", async () => {
    const output = {
      dataset: "errors" as const,
      query: "",
      fields: [] as string[],
      sort: "-timestamp",
      environment: null,
      timeSeries: { yAxis: "count_unique(user)", interval: "1h" },
      timeRange: { statsPeriod: "24h" },
      explanation: "",
    };
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify(output),
      experimental_output: output,
      finishReason: "stop" as const,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      warnings: [] as const,
    } as any);

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events-timeseries/",
        () =>
          HttpResponse.json({
            timeSeries: [
              {
                yAxis: "count_unique(user)",
                values: [
                  { timestamp: 1757548800000, value: 5, incomplete: false },
                  { timestamp: 1757552400000, value: 8, incomplete: false },
                ],
                meta: {
                  interval: 3600000,
                  valueType: "integer",
                  valueUnit: null,
                },
              },
            ],
          }),
      ),
    );

    const result = await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        dataset: "errors",
        query: "unique users per hour",
        fields: null,
        sort: null,
        period: "24h",
        limit: 10,
        includeExplanation: false,
      },
      {
        accessToken: "test-token",
        userId: "user-123",
        clientId: "client-123",
        grantedSkills: new Set(),
        constraints: {},
        sentryHost: "sentry.io",
      },
    );

    expect(result).toContain("count_unique(user) over time");
    expect(result).not.toContain("**Total**");
    // Peak (the max bucket) is still meaningful for non-additive aggregates.
    expect(result).toContain("**Peak**: 8");
  });

  it("marks incomplete buckets and reports ingestion delay", async () => {
    const output = {
      dataset: "errors" as const,
      query: "",
      fields: [] as string[],
      sort: "-timestamp",
      environment: null,
      timeSeries: { yAxis: "count()", interval: "1h" },
      timeRange: { statsPeriod: "24h" },
      explanation: "",
    };
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify(output),
      experimental_output: output,
      finishReason: "stop" as const,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      warnings: [] as const,
    } as any);

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events-timeseries/",
        () =>
          HttpResponse.json({
            timeSeries: [
              {
                yAxis: "count()",
                values: [
                  {
                    timestamp: 1757548800000,
                    value: 10,
                    incomplete: true,
                    incompleteReason: "OUTSIDE_RETENTION",
                  },
                  { timestamp: 1757552400000, value: 8, incomplete: false },
                  {
                    timestamp: 1757556000000,
                    value: 9,
                    incomplete: true,
                    incompleteReason: "NOT_ELAPSED",
                  },
                ],
                meta: {
                  interval: 3600000,
                  valueType: "integer",
                  valueUnit: null,
                },
              },
            ],
            meta: {
              dataset: "errors",
              start: 1757462400000,
              end: 1757548800000,
              ingestion: {
                status: "healthy",
                delaySeconds: 95,
                completeThrough: 1757556600000,
              },
            },
          }),
      ),
    );

    const result = await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        dataset: "errors",
        query: "errors per hour",
        fields: null,
        sort: null,
        period: "24h",
        limit: 10,
        includeExplanation: false,
      },
      {
        accessToken: "test-token",
        userId: "user-123",
        clientId: "client-123",
        grantedSkills: new Set(),
        constraints: {},
        sentryHost: "sentry.io",
      },
    );

    // The still-filling bucket can't be the peak yet. The retention-partial
    // bucket is final, so it still counts and wins here.
    expect(result).toContain("**Peak**: 10 at 2025-09-11 00:00");
    expect(result).toContain("**Total**: 27 (so far)");
    expect(result).toContain("| 2025-09-11 00:00 | 10 † |");
    expect(result).toContain("| 2025-09-11 02:00 | 9 * |");
    expect(result).toContain("Incomplete bucket: data is still arriving");
    expect(result).toContain(
      "Partial bucket: it starts before the retention window",
    );
    expect(result).toContain(
      "**Ingestion**: healthy (~1m 35s behind, data complete through 2025-09-11 02:10 UTC)",
    );
  });

  it("omits the retention footnote when its buckets are cut from the table", async () => {
    const output = {
      dataset: "errors" as const,
      query: "",
      fields: [] as string[],
      sort: "-timestamp",
      environment: null,
      timeSeries: { yAxis: "count()", interval: "1d" },
      timeRange: { statsPeriod: "100d" },
      explanation: "",
    };
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify(output),
      experimental_output: output,
      finishReason: "stop" as const,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      warnings: [] as const,
    } as any);

    // 60 daily buckets: the first is outside retention, but only the latest
    // 48 rows are rendered, so no † row is visible.
    const day = 86400000;
    const values = Array.from({ length: 60 }, (_, i) => ({
      timestamp: 1752364800000 + i * day,
      value: i + 1,
      incomplete: i === 0,
      ...(i === 0 ? { incompleteReason: "OUTSIDE_RETENTION" } : {}),
    }));
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events-timeseries/",
        () =>
          HttpResponse.json({
            timeSeries: [{ yAxis: "count()", values, meta: { interval: day } }],
          }),
      ),
    );

    const result = await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        dataset: "errors",
        query: "errors per day",
        fields: null,
        sort: null,
        period: "100d",
        limit: 10,
        includeExplanation: false,
      },
      {
        accessToken: "test-token",
        userId: "user-123",
        clientId: "client-123",
        grantedSkills: new Set(),
        constraints: {},
        sentryHost: "sentry.io",
      },
    );

    expect(result).toContain("## Buckets (most recent 48 of 60)");
    expect(result).not.toContain("†");
    expect(result).not.toContain("so far");
  });

  it("should handle spans dataset queries", async () => {
    // Mock AI response for spans dataset
    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse("spans", 'span.op:"db.query"', [
        "span.op",
        "span.description",
        "span.duration",
      ]),
    );

    // Mock the Sentry API response
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("dataset")).toBe("spans");
          return HttpResponse.json({
            data: [
              {
                id: "span1",
                "span.op": "db.query",
                "span.description": "SELECT * FROM users",
                "span.duration": 1500,
              },
            ],
          });
        },
      ),
    );

    const result = await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query: "database queries",
        dataset: "errors",
        fields: null,
        sort: "-timestamp",
        period: "14d",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    expect(mockGenerateText).toHaveBeenCalled();
    expect(result).toContain("span1");
    expect(result).toContain("db.query");
  });

  it("should execute complete structured search requests without agent rewriting", async () => {
    const query =
      'transaction:"VPN connections" tags[type]:Unified tags[country]:CN';
    const fields = [
      "tags[type]",
      "tags[sequence]",
      "span.status",
      "tags[reason]",
      "count()",
    ];

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("dataset")).toBe("spans");
          expect(url.searchParams.get("query")).toBe(query);
          expect(url.searchParams.getAll("field")).toEqual(fields);
          expect(url.searchParams.get("sort")).toBe("-count()");
          expect(url.searchParams.get("statsPeriod")).toBe("7d");

          return HttpResponse.json({
            data: [
              {
                "tags[type]": "Unified",
                "tags[sequence]": "42",
                "span.status": "ok",
                "tags[reason]": "allowed",
                "count()": 3,
              },
            ],
          });
        },
      ),
    );

    const result = await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query,
        dataset: "spans",
        fields,
        sort: "-count()",
        period: "7d",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(result).toContain('"tags[type]": "Unified"');
    expect(result).toContain(
      '- Query: `transaction:"VPN connections" tags[type]:Unified tags[country]:CN`',
    );
    expect(result).toContain(
      "- Fields: `tags[type]`, `tags[sequence]`, `span.status`, `tags[reason]`, `count()`",
    );
  });

  it("flags an unknown environment even on the structured (non-agent) path", async () => {
    const query = 'transaction:"checkout" environment:nonexistent-xyz';
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/environments/",
        () =>
          HttpResponse.json([
            { id: "1", name: "production" },
            { id: "2", name: "development" },
          ]),
      ),
      http.get("https://sentry.io/api/0/organizations/test-org/events/", () =>
        HttpResponse.json({ data: [] }),
      ),
    );

    const result = await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query,
        dataset: "spans",
        fields: ["id", "timestamp"],
        sort: "-timestamp",
        period: "24h",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    // No agent runs, but the env typo in the query is still caught + surfaced.
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(result).toContain("not found in this organization");
    expect(result).toContain("nonexistent-xyz");
    expect(result).toContain("`production`");
  });

  it("should link directly to AI conversation details for a single conversation id filter", async () => {
    const query = 'gen_ai.conversation.id:"14365297"';

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("dataset")).toBe("spans");
          expect(url.searchParams.get("query")).toBe(query);

          return HttpResponse.json({
            data: [
              {
                id: "span1",
                "span.op": "ai.pipeline",
                "span.description": "AI conversation",
                "span.duration": 120,
              },
            ],
          });
        },
      ),
    );

    const result = await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query,
        dataset: "spans",
        fields: ["span.op", "span.description", "span.duration"],
        sort: "-span.duration",
        period: "14d",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    expect(result).toContain(
      "https://test-org.sentry.io/explore/conversations/14365297/",
    );
    expect(result).not.toContain("https://test-org.sentry.io/explore/traces/");
  });

  it("should append environment filters for structured trace searches", async () => {
    const query =
      'transaction:"VPN connections" message:"environment: prod" tags[type]:Unified tags[country]:CN';
    const fields = ["tags[type]", "count()"];

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("dataset")).toBe("spans");
          expect(url.searchParams.get("query")).toBe(
            `${query} environment:production`,
          );
          expect(url.searchParams.getAll("field")).toEqual(fields);

          return HttpResponse.json({
            data: [
              {
                "tags[type]": "Unified",
                "count()": 3,
              },
            ],
          });
        },
      ),
    );

    await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query,
        dataset: "spans",
        fields,
        sort: "-count()",
        period: "7d",
        environment: "production",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("should repair trace queries with natural language colon patterns", async () => {
    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse(
        "spans",
        'span.op:"http.client"',
        ["span.op", "span.duration"],
        undefined,
        "-span.duration",
        { statsPeriod: "24h" },
      ),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("dataset")).toBe("spans");
          expect(url.searchParams.get("query")).toBe('span.op:"http.client"');
          expect(url.searchParams.getAll("field")).toEqual([
            "span.op",
            "span.duration",
          ]);

          return HttpResponse.json({
            data: [
              {
                "span.op": "http.client",
                "span.duration": 123,
              },
            ],
          });
        },
      ),
    );

    await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query:
          "Find slow spans for http://example.com at 10:30. Note: failed requests",
        dataset: "spans",
        fields: ["span.op", "span.duration"],
        sort: "-span.duration",
        period: "24h",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    expect(mockGenerateText).toHaveBeenCalled();
  });

  it("should preserve structured query filters and explicit fields after agent repair", async () => {
    const query =
      'transaction:"VPN connections" tags[type]:Unified tags[country]:CN';
    const fields = ["tags[type]", "tags[sequence]", "count()"];

    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse(
        "spans",
        'transaction:"VPN connections" tags[country]:CN',
        ["span.status", "count()"],
        undefined,
        "-count()",
        { statsPeriod: "24h" },
      ),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("dataset")).toBe("spans");
          expect(url.searchParams.get("query")).toBe(query);
          expect(url.searchParams.getAll("field")).toEqual(fields);
          expect(url.searchParams.get("sort")).toBe("-count()");
          expect(url.searchParams.get("statsPeriod")).toBe("7d");

          return HttpResponse.json({
            data: [
              {
                "tags[type]": "Unified",
                "tags[sequence]": "42",
                "count()": 3,
              },
            ],
          });
        },
      ),
    );

    const result = await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query,
        dataset: "spans",
        fields,
        sort: null,
        period: "7d",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    expect(mockGenerateText).toHaveBeenCalled();
    expect(result).toContain('"tags[type]": "Unified"');
    expect(result).toContain('"tags[sequence]": "42"');
  });

  it("should include the sort field even when caller's explicit fields omit it", async () => {
    // Sentry rejects requests whose sort column isn't in the selected fields,
    // so the handler must append the sort field before issuing the request.
    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse(
        "errors",
        "level:error",
        ["title", "issue", "message", "timestamp"],
        undefined,
        "-timestamp",
      ),
    );

    let capturedFields: string[] | undefined;
    let capturedSort: string | null | undefined;

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/",
        ({ request }) => {
          const url = new URL(request.url);
          capturedFields = url.searchParams.getAll("field");
          capturedSort = url.searchParams.get("sort");
          return HttpResponse.json({ data: [] });
        },
      ),
    );

    await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query: "level:error",
        dataset: "errors",
        fields: ["title", "issue", "message"],
        sort: "-timestamp",
        period: "14d",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    expect(capturedSort).toBe("-timestamp");
    expect(capturedFields).toContain("timestamp");
  });

  it("should not append a non-aggregate sort to aggregate fields", async () => {
    // Adding a non-aggregate column to an aggregate query expands the
    // GROUP BY and silently corrupts the result, so leave the request
    // alone and let Sentry's 400 propagate.
    let capturedFields: string[] | undefined;
    let capturedSort: string | null | undefined;

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/",
        ({ request }) => {
          const url = new URL(request.url);
          capturedFields = url.searchParams.getAll("field");
          capturedSort = url.searchParams.get("sort");
          return HttpResponse.json({ data: [] });
        },
      ),
    );

    await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query: 'span.op:"db.query"',
        dataset: "spans",
        fields: ["span.op", "count()"],
        sort: "-timestamp",
        period: "7d",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(capturedSort).toBe("-timestamp");
    expect(capturedFields).toEqual(["span.op", "count()"]);
  });

  it("should append an aggregate sort that isn't already in fields", async () => {
    // Aggregate sort columns can safely be added to an aggregate query —
    // Sentry treats them as additional aggregations, not GROUP BY columns.
    let capturedFields: string[] | undefined;
    let capturedSort: string | null | undefined;

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/",
        ({ request }) => {
          const url = new URL(request.url);
          capturedFields = url.searchParams.getAll("field");
          capturedSort = url.searchParams.get("sort");
          return HttpResponse.json({ data: [] });
        },
      ),
    );

    await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query: 'span.op:"db.query"',
        dataset: "spans",
        fields: ["span.op", "count()"],
        sort: "-count_unique(user.id)",
        period: "7d",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(capturedSort).toBe("-count_unique(user.id)");
    expect(capturedFields).toEqual([
      "span.op",
      "count()",
      "count_unique(user.id)",
    ]);
  });

  it("should not duplicate environment filters after agent repair", async () => {
    const query =
      'transaction:"VPN connections" tags[type]:Unified tags[country]:CN';
    const repairedQuery = `${query} environment:production has:span.status`;
    const fields = ["tags[type]", "count()"];

    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse(
        "spans",
        repairedQuery,
        ["span.status", "count()"],
        undefined,
        "-count()",
        { statsPeriod: "24h" },
      ),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("dataset")).toBe("spans");
          expect(url.searchParams.get("query")).toBe(repairedQuery);
          expect(url.searchParams.getAll("field")).toEqual(fields);

          return HttpResponse.json({
            data: [
              {
                "tags[type]": "Unified",
                "count()": 3,
              },
            ],
          });
        },
      ),
    );

    await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query,
        dataset: "spans",
        fields,
        sort: null,
        period: "7d",
        environment: "production",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    expect(mockGenerateText).toHaveBeenCalled();
  });

  it("should accept repaired structured trace queries that preserve the original filters", async () => {
    const query =
      'transaction:"VPN connections" tags[type]:Unified tags[country]:CN';
    const repairedQuery = `${query} has:span.status`;
    const fields = ["tags[type]", "tags[sequence]", "count()"];

    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse(
        "spans",
        repairedQuery,
        ["span.status", "count()"],
        undefined,
        "-count()",
        { statsPeriod: "24h" },
      ),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("dataset")).toBe("spans");
          expect(url.searchParams.get("query")).toBe(repairedQuery);
          expect(url.searchParams.getAll("field")).toEqual(fields);

          return HttpResponse.json({
            data: [
              {
                "tags[type]": "Unified",
                "tags[sequence]": "42",
                "count()": 3,
              },
            ],
          });
        },
      ),
    );

    await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query,
        dataset: "spans",
        fields,
        sort: null,
        period: "7d",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    expect(mockGenerateText).toHaveBeenCalled();
  });

  it("should reject repaired structured trace queries with modified filter tokens", async () => {
    const query = "tags[sequence]:2 tags[type]:Unified";
    const fields = ["tags[type]", "tags[sequence]", "count()"];

    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse(
        "spans",
        "tags[sequence]:20 tags[type]:Unified has:span.status",
        ["span.status", "count()"],
        undefined,
        "-count()",
        { statsPeriod: "24h" },
      ),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("dataset")).toBe("spans");
          expect(url.searchParams.get("query")).toBe(query);
          expect(url.searchParams.getAll("field")).toEqual(fields);

          return HttpResponse.json({
            data: [
              {
                "tags[type]": "Unified",
                "tags[sequence]": "2",
                "count()": 1,
              },
            ],
          });
        },
      ),
    );

    await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query,
        dataset: "spans",
        fields,
        sort: null,
        period: "7d",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    expect(mockGenerateText).toHaveBeenCalled();
  });

  it("should reject repaired structured trace queries with modified quoted filter values", async () => {
    const query =
      'transaction:"VPN connections" tags[type]:Unified tags[country]:CN';
    const fields = ["tags[type]", "tags[sequence]", "count()"];

    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse(
        "spans",
        'transaction:"VPN adventures" connections" tags[type]:Unified tags[country]:CN has:span.status',
        ["span.status", "count()"],
        undefined,
        "-count()",
        { statsPeriod: "24h" },
      ),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("dataset")).toBe("spans");
          expect(url.searchParams.get("query")).toBe(query);
          expect(url.searchParams.getAll("field")).toEqual(fields);

          return HttpResponse.json({
            data: [
              {
                "tags[type]": "Unified",
                "tags[sequence]": "2",
                "count()": 1,
              },
            ],
          });
        },
      ),
    );

    await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query,
        dataset: "spans",
        fields,
        sort: null,
        period: "7d",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    expect(mockGenerateText).toHaveBeenCalled();
  });

  it("should handle metrics dataset queries", async () => {
    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse(
        "metrics",
        "",
        [
          "transaction",
          "p95(value,http.request.duration,distribution,millisecond)",
          "count(value,http.request.duration,distribution,millisecond)",
        ],
        undefined,
        "-p95(value,http.request.duration,distribution,millisecond)",
      ),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("dataset")).toBe("tracemetrics");
          expect(url.searchParams.get("sort")).toBe(
            "-p95(value,http.request.duration,distribution,millisecond)",
          );
          return HttpResponse.json({
            data: [
              {
                transaction: "GET /api/users",
                "p95(value,http.request.duration,distribution,millisecond)": 320,
                "count(value,http.request.duration,distribution,millisecond)": 42,
              },
            ],
          });
        },
      ),
    );

    const result = await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query: "slow request duration metrics",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    expect(result).toMatchInlineSnapshot(`
      "# Search Results for "slow request duration metrics"

      **Suggested presentation:** A compact table with grouping labels and units works well for these metric aggregates.

      ## Executed Search
      - Dataset: \`metrics\`
      - Query: \`(empty)\`
      - Fields: \`transaction\`, \`p95(value,http.request.duration,distribution,millisecond)\`, \`count(value,http.request.duration,distribution,millisecond)\`
      - Sort: \`-p95(value,http.request.duration,distribution,millisecond)\`
      - Time range: Last 14d

      **View these results in Sentry**:
      https://test-org.sentry.io/explore/metrics/?statsPeriod=14d&metric=%7B%22metric%22%3A%7B%22name%22%3A%22http.request.duration%22%2C%22type%22%3A%22distribution%22%2C%22unit%22%3A%22millisecond%22%7D%2C%22query%22%3A%22%22%2C%22aggregateFields%22%3A%5B%7B%22yAxes%22%3A%5B%22p95%28value%2Chttp.request.duration%2Cdistribution%2Cmillisecond%29%22%5D%7D%2C%7B%22yAxes%22%3A%5B%22count%28value%2Chttp.request.duration%2Cdistribution%2Cmillisecond%29%22%5D%7D%2C%7B%22groupBy%22%3A%22transaction%22%7D%5D%2C%22aggregateSortBys%22%3A%5B%7B%22field%22%3A%22p95%28value%2Chttp.request.duration%2Cdistribution%2Cmillisecond%29%22%2C%22kind%22%3A%22desc%22%7D%5D%2C%22mode%22%3A%22aggregate%22%7D
      Please tell the user this dashboard link is available if they want to open the results in Sentry.

      Found 1 aggregate result:

      \`\`\`json
      [
        {
          "transaction": "GET /api/users",
          "p95(value,http.request.duration,distribution,millisecond)": 320,
          "count(value,http.request.duration,distribution,millisecond)": 42
        }
      ]
      \`\`\`

      ## Next Steps

      - Open the Metrics page link above to refine the selected metric
      - Drill into a specific sample by opening its Trace URL or using \`get_sentry_resource\` with that trace ID
      - Metrics do not expose a standalone detail resource here; use the related trace for deeper inspection
      - Group by additional attributes to break down the metric further
      - Switch between samples and aggregates in Sentry for deeper analysis
      "
    `);
  });

  it("should request trace metric identity fields for metrics sample queries", async () => {
    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse(
        "metrics",
        "",
        ["timestamp", "value"],
        undefined,
        "-timestamp",
      ),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/",
        ({ request }) => {
          const url = new URL(request.url);

          expect(url.searchParams.getAll("field")).toEqual([
            "timestamp",
            "value",
            "metric.name",
            "metric.type",
            "metric.unit",
          ]);

          return HttpResponse.json({
            data: [
              {
                timestamp: "2026-04-13T14:19:18+00:00",
                value: 12.4,
                trace: "6a477f5b0f31ef7b6b9b5e1dea66c91d",
                "metric.name": "http.request.duration",
                "metric.type": "distribution",
                "metric.unit": "millisecond",
              },
            ],
          });
        },
      ),
    );

    const result = await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query: "recent metrics",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    expect(typeof result).toBe("string");
    if (typeof result !== "string") {
      throw new Error("Expected string result");
    }

    const urlMatch = result.match(/https:\/\/[^\n]+/);
    expect(urlMatch).not.toBeNull();

    const url = new URL(urlMatch![0]);
    const metricQuery = JSON.parse(url.searchParams.get("metric")!);

    expect(url.pathname).toBe("/explore/metrics/");
    expect(metricQuery.metric).toEqual({
      name: "http.request.duration",
      type: "distribution",
      unit: "millisecond",
    });
    expect(metricQuery.mode).toBe("samples");
    expect(metricQuery.aggregateFields).toEqual([{ yAxes: ["sum(value)"] }]);
  });

  it("should handle profiles dataset queries", async () => {
    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse(
        "profiles",
        "transaction:/api/users",
        [
          "project",
          "profile.id",
          "timestamp",
          "transaction",
          "transaction.duration",
          "release",
          "trace",
          "precise.start_ts",
          "precise.finish_ts",
        ],
        undefined,
        "-timestamp",
      ),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("dataset")).toBe("profiles");
          return HttpResponse.json({
            data: [
              {
                project: "backend",
                "profile.id": "cfe78a5c892d4a64a962d837673398d2",
                timestamp: "2025-01-15T10:00:00Z",
                transaction: "/api/users",
                "transaction.duration": 120000000,
                release: "backend@1.2.3",
                trace: "a4d1aae7216b47ff8117cf4e09ce9d0a",
                "precise.start_ts": "2025-01-15T10:00:00Z",
                "precise.finish_ts": "2025-01-15T10:00:00.120Z",
              },
            ],
          });
        },
      ),
    );

    const result = await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query: "recent profiles for /api/users",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    expect(result).toContain("https://test-org.sentry.io/explore/profiling/");
    expect(result).toContain(
      "https://test-org.sentry.io/explore/profiling/profile/backend/cfe78a5c892d4a64a962d837673398d2/flamegraph/",
    );
    expect(result).toContain("**transaction.duration**: 120ms");
  });

  it("should build continuous profile links when precise timestamps are exact strings", async () => {
    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse(
        "profiles",
        "transaction:/api/users",
        [
          "project",
          "profiler.id",
          "timestamp",
          "transaction",
          "transaction.duration",
          "trace",
          "precise.start_ts",
          "precise.finish_ts",
        ],
        undefined,
        "-timestamp",
      ),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("dataset")).toBe("profiles");
          return HttpResponse.json({
            data: [
              {
                project: "backend",
                "profiler.id": "7d0d8b4ef0c74b07a3d48886e9b198e5",
                timestamp: "2025-01-15T10:00:00Z",
                transaction: "/api/users",
                "transaction.duration": 120000000,
                trace: "a4d1aae7216b47ff8117cf4e09ce9d0a",
                "precise.start_ts": "1736935200000000000",
                "precise.finish_ts": "1736935200120000000",
              },
            ],
          });
        },
      ),
    );

    const result = await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query: "recent profiles for /api/users",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    expect(result).toContain(
      "https://test-org.sentry.io/explore/profiling/profile/backend/flamegraph/?profilerId=7d0d8b4ef0c74b07a3d48886e9b198e5&start=1736935200000000000&end=1736935200120000000",
    );
    expect(result).toContain("**transaction.duration**: 120ms");
  });

  it("should omit continuous profile links when precise timestamps are unsafe numbers", async () => {
    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse(
        "profiles",
        "transaction:/api/users",
        [
          "project",
          "profiler.id",
          "timestamp",
          "transaction",
          "transaction.duration",
          "trace",
          "precise.start_ts",
          "precise.finish_ts",
        ],
        undefined,
        "-timestamp",
      ),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("dataset")).toBe("profiles");
          return HttpResponse.json({
            data: [
              {
                project: "backend",
                "profiler.id": "7d0d8b4ef0c74b07a3d48886e9b198e5",
                timestamp: "2025-01-15T10:00:00Z",
                transaction: "/api/users",
                "transaction.duration": 120000000,
                trace: "a4d1aae7216b47ff8117cf4e09ce9d0a",
                "precise.start_ts": 1736935200000000000,
                "precise.finish_ts": 1736935200120000000,
              },
            ],
          });
        },
      ),
    );

    const result = await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query: "recent profiles for /api/users",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    expect(result).not.toContain(
      "**Profile URL**: https://test-org.sentry.io/explore/profiling/profile/backend/flamegraph/?profilerId=7d0d8b4ef0c74b07a3d48886e9b198e5",
    );
    expect(result).toContain("**transaction.duration**: 120ms");
  });

  it("should preserve grouped profile fields in the explorer URL", async () => {
    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse(
        "profiles",
        "",
        ["release", "count()"],
        undefined,
        "-count()",
      ),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("dataset")).toBe("profiles");
          return HttpResponse.json({
            data: [
              {
                release: "backend@1.2.3",
                "count()": 3,
              },
            ],
          });
        },
      ),
    );

    const result = await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query: "count profiles by release",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    expect(typeof result).toBe("string");
    if (typeof result !== "string") {
      throw new Error("Expected string result");
    }

    const urlMatch = result.match(/https:\/\/[^\n]+/);
    expect(urlMatch).not.toBeNull();

    const url = new URL(urlMatch![0]);

    expect(url.pathname).toBe("/explore/profiling/");
    expect(url.searchParams.get("sort")).toBe("-count()");
    expect(url.searchParams.getAll("field")).toEqual(["release", "count()"]);
  });

  it("should omit profile detail links when only project.name is selected", async () => {
    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse(
        "profiles",
        "transaction:/api/users",
        [
          "project.name",
          "profile.id",
          "timestamp",
          "transaction",
          "transaction.duration",
        ],
        undefined,
        "-timestamp",
      ),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("dataset")).toBe("profiles");
          return HttpResponse.json({
            data: [
              {
                "project.name": "Backend API",
                "profile.id": "cfe78a5c892d4a64a962d837673398d2",
                timestamp: "2025-01-15T10:00:00Z",
                transaction: "/api/users",
                "transaction.duration": 120000000,
              },
            ],
          });
        },
      ),
    );

    const result = await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query: "recent profiles for /api/users",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    expect(result).not.toContain("**Profile URL**:");
    expect(result).not.toContain("/profile/Backend API/");
    expect(result).toContain("**project.name**: Backend API");
  });

  it("should handle replay dataset queries through search_events", async () => {
    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse(
        "replays",
        "url:*checkout* count_errors:>0",
        [],
        undefined,
        "-count_errors",
        { statsPeriod: "24h" },
        ["production", "staging"],
      ),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/replays/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("query")).toBe(
            "url:*checkout* count_errors:>0",
          );
          expect(url.searchParams.get("sort")).toBe("-count_errors");
          expect(url.searchParams.getAll("environment")).toEqual([
            "production",
            "staging",
          ]);
          expect(url.searchParams.get("statsPeriod")).toBe("24h");
          return HttpResponse.json({
            data: [
              {
                id: "7e07485f12f9416b8b1426260799b51f",
                duration: 576,
                environment: "production",
                count_errors: 2,
                count_rage_clicks: 1,
                count_dead_clicks: 3,
                started_at: "2025-01-15T10:00:00Z",
                browser: { name: "Chrome", version: "131.0.0" },
                user: { display_name: "Jane Doe" },
                urls: ["/checkout", "/checkout/payment", "/checkout/confirm"],
                releases: ["frontend@1.2.3"],
                trace_ids: ["a4d1aae7216b47ff8117cf4e09ce9d0a"],
              },
            ],
          });
        },
      ),
    );

    const result = await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query: "production checkout replays with errors in the last day",
        limit: 10,
        includeExplanation: true,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    expect(result).toContain("https://test-org.sentry.io/explore/replays/");
    expect(result).toContain("environment=production&environment=staging");
    expect(result).toContain("Environment: production, staging");
    expect(result).toContain("Jane Doe");
    expect(result).toContain("2 errors");
  });

  it("should not add default period to replay absolute time ranges", async () => {
    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse(
        "replays",
        "url:*checkout*",
        [],
        undefined,
        "-started_at",
        {
          start: "2025-01-15T00:00:00Z",
          end: "2025-01-16T00:00:00Z",
        },
      ),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/replays/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("query")).toBe("url:*checkout*");
          expect(url.searchParams.get("sort")).toBe("-started_at");
          expect(url.searchParams.get("start")).toBe("2025-01-15T00:00:00Z");
          expect(url.searchParams.get("end")).toBe("2025-01-16T00:00:00Z");
          expect(url.searchParams.has("statsPeriod")).toBe(false);
          return HttpResponse.json({ data: [] });
        },
      ),
    );

    const result = await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query: "checkout replays yesterday",
        limit: 10,
        includeExplanation: true,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    expect(result).not.toContain("statsPeriod=14d");
    expect(result).toContain("2025-01-15");
    expect(result).toContain("2025-01-16");
  });

  it("should handle errors dataset queries", async () => {
    // Mock AI response for errors dataset
    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse("errors", "level:error", [
        "issue",
        "title",
        "level",
        "timestamp",
      ]),
    );

    // Mock the Sentry API response
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("dataset")).toBe("errors");
          expect(url.searchParams.getAll("field")).toEqual([
            "issue",
            "title",
            "level",
            "timestamp",
          ]);
          return HttpResponse.json({
            data: [
              {
                id: "error1",
                issue: "PROJ-123",
                title: "Database Connection Error",
                level: "error",
                timestamp: "2024-01-15T10:30:00Z",
              },
            ],
          });
        },
      ),
    );

    const result = await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query: "database errors",
        dataset: "errors",
        fields: null,
        sort: "-timestamp",
        period: "14d",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    expect(mockGenerateText).toHaveBeenCalled();
    expect(result).toContain("Database Connection Error");
    expect(result).toContain("PROJ-123");
  });

  it("includes user identity in default error search fields", async () => {
    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse("errors", "level:error", []),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("dataset")).toBe("errors");
          expect(url.searchParams.getAll("field")).toEqual(
            expect.arrayContaining(["user.email", "user.id"]),
          );
          return HttpResponse.json({
            data: [
              {
                id: "error1",
                issue: "PROJ-123",
                title: "Database Connection Error",
                "user.email": "dev@example.com",
                "user.id": "123",
              },
            ],
          });
        },
      ),
    );

    const result = await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query: "database errors",
        dataset: "errors",
        fields: null,
        sort: "-timestamp",
        period: "14d",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    expect(result).toContain("dev@example.com");
    expect(result).toContain("user.id");
  });

  it("should format object fields without [object Object] output", async () => {
    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse("errors", "issue:PROJ-123", [
        "title",
        "timestamp",
        "user",
        "tags",
      ]),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("dataset")).toBe("errors");
          return HttpResponse.json({
            data: [
              {
                id: "error1",
                title: "WatchdogTermination",
                timestamp: "2024-01-15T10:30:00Z",
                user: {
                  id: "user-123",
                  email: "foo@example.com",
                  ip_address: "10.0.0.1",
                },
                tags: [
                  { key: "os", value: "iOS 17" },
                  { key: "device", value: "iPhone15,3" },
                ],
              },
            ],
          });
        },
      ),
    );

    const result = await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query: "recent errors with user data",
        dataset: "errors",
        fields: null,
        sort: "-timestamp",
        period: "14d",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    expect(result).toContain("email=foo@example.com");
    expect(result).toContain("os=iOS 17");
    expect(result).not.toContain("[object Object]");
  });

  it("should render geo-only users without raw user JSON in error results", async () => {
    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse("errors", "issue:PROJ-123", [
        "title",
        "timestamp",
        "user",
      ]),
    );

    mswServer.use(
      http.get("https://sentry.io/api/0/organizations/test-org/events/", () => {
        return HttpResponse.json({
          data: [
            {
              id: "error1",
              title: "Geo-only User Error",
              timestamp: "2024-01-15T10:30:00Z",
              user: {
                geo: {
                  country_code: "US",
                  region: "United States",
                },
              },
            },
          ],
        });
      }),
    );

    const result = await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query: "recent errors with geo-only user data",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    expect(result).toContain("**user.geo**: US, United States");
    expect(result).not.toContain('**user**: {"geo"');
    expect(result).not.toContain("**user**:");
  });

  it("should render log user geo on a dedicated line", async () => {
    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse("logs", "user logs", [
        "timestamp",
        "message",
        "severity",
        "user",
      ]),
    );

    mswServer.use(
      http.get("https://sentry.io/api/0/organizations/test-org/events/", () => {
        return HttpResponse.json({
          data: [
            {
              timestamp: "2024-01-15T10:30:00Z",
              message: "User log message",
              severity: "info",
              user: {
                id: "user-123",
                geo: {
                  country_code: "US",
                  region: "United States",
                },
              },
            },
          ],
        });
      }),
    );

    const result = await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query: "logs with user geo",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    expect(result).toContain("- **user**: id=user-123");
    expect(result).toContain("- **user.geo**: US, United States");
    expect(result).not.toContain(
      "- **user**: id=user-123, geo=US, United States",
    );
  });

  it("should render span user geo on a dedicated line", async () => {
    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse("spans", "span users", [
        "span.description",
        "span.duration",
        "timestamp",
        "user",
      ]),
    );

    mswServer.use(
      http.get("https://sentry.io/api/0/organizations/test-org/events/", () => {
        return HttpResponse.json({
          data: [
            {
              id: "span1",
              "span.description": "SELECT * FROM users",
              "span.duration": 1500,
              timestamp: "2024-01-15T10:30:00Z",
              user: {
                id: "user-123",
                geo: {
                  country_code: "US",
                  region: "United States",
                },
              },
            },
          ],
        });
      }),
    );

    const result = await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query: "spans with user geo",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    expect(result).toContain("**user**: id=user-123");
    expect(result).toContain("**user.geo**: US, United States");
    expect(result).not.toContain(
      "**user**: id=user-123, geo=US, United States",
    );
  });

  it("should handle logs dataset queries", async () => {
    // Mock AI response for logs dataset
    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse("logs", "severity:error", [
        "timestamp",
        "message",
        "severity",
      ]),
    );

    // Mock the Sentry API response
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("dataset")).toBe("logs"); // API now accepts "logs" directly
          return HttpResponse.json({
            data: [
              {
                id: "log1",
                timestamp: "2024-01-15T10:30:00Z",
                message: "Connection failed to database",
                severity: "error",
              },
            ],
          });
        },
      ),
    );

    const result = await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query: "error logs",
        dataset: "errors",
        fields: null,
        sort: "-timestamp",
        period: "14d",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    expect(mockGenerateText).toHaveBeenCalled();
    expect(result).toContain("Connection failed to database");
    expect(result).toContain("🔴 [ERROR]");
  });

  it("should repair direct search params with the agent when available", async () => {
    let eventsRequestUrl: URL | undefined;

    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse("logs", "severity:error", [
        "timestamp",
        "message",
        "severity",
      ]),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/",
        ({ request }) => {
          eventsRequestUrl = new URL(request.url);
          return HttpResponse.json({
            data: [
              {
                id: "log1",
                timestamp: "2024-01-15T10:30:00Z",
                message: "Connection failed to database",
                severity: "error",
              },
            ],
          });
        },
      ),
    );

    const result = await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query: "severity:error",
        dataset: "errors",
        fields: ["timestamp", "message", "level"],
        sort: "-timestamp",
        period: "14d",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    // Assert behavior via Sentry API inputs + tool output, not agent prompt text.
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(eventsRequestUrl).toBeDefined();
    expect(eventsRequestUrl!.searchParams.get("dataset")).toBe("logs");
    expect(eventsRequestUrl!.searchParams.get("query")).toBe("severity:error");
    expect(eventsRequestUrl!.searchParams.getAll("field")).toEqual([
      "timestamp",
      "message",
      "severity",
    ]);
    expect(result).toContain("Connection failed to database");
  });

  it("should handle AI agent errors gracefully", async () => {
    // Mock AI response with error
    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse("errors", "", [], "Cannot parse this query"),
    );

    const promise = searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query: "some impossible query !@#$%",
        dataset: "errors",
        fields: null,
        sort: "-timestamp",
        period: "14d",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    await expect(promise).rejects.toThrow(UserInputError);
    await expect(promise).rejects.toThrow("Cannot parse this query");
  });

  it("should reject agent responses with empty sort", async () => {
    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse(
        "errors",
        "level:error",
        ["timestamp", "title"],
        undefined,
        "",
      ),
    );

    const promise = searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query: "recent errors",
        dataset: "errors",
        fields: null,
        sort: "-timestamp",
        period: "14d",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    await expect(promise).rejects.toThrow(UserInputError);
    await expect(promise).rejects.toThrow("missing required 'sort'");
  });

  it("should return UserInputError for time series queries", async () => {
    // Mock AI response with time series error
    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse(
        "errors",
        "",
        [],
        "Time series aggregations are not currently supported.",
      ),
    );

    const promise = searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query: "show me errors over time",
        dataset: "errors",
        fields: null,
        sort: "-timestamp",
        period: "14d",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    // Check that it throws UserInputError
    await expect(promise).rejects.toThrow(UserInputError);

    // Check that the error message contains the expected text
    await expect(promise).rejects.toThrow(
      "Time series aggregations are not currently supported",
    );
  });

  it("should handle API errors gracefully", async () => {
    // Mock successful AI response
    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse("errors", "level:error"),
    );

    // Mock API error
    mswServer.use(
      http.get("https://sentry.io/api/0/organizations/test-org/events/", () =>
        HttpResponse.json(
          { detail: "Organization not found" },
          { status: 404 },
        ),
      ),
    );

    await expect(
      searchEvents.handler(
        {
          organizationSlug: "test-org",
          regionUrl: null,
          projectSlug: null,
          query: "any query",
          dataset: "errors",
          fields: null,
          sort: "-timestamp",
          period: "14d",
          limit: 10,
          includeExplanation: false,
        },
        {
          constraints: {
            organizationSlug: null,
            regionUrl: null,
            projectSlug: null,
          },
          accessToken: "test-token",
          userId: "1",
        },
      ),
    ).rejects.toThrow();
  });

  it("should handle missing sort parameter", async () => {
    // Mock AI response missing sort parameter - schema.parse() will catch this
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify({
        dataset: "errors",
        query: "test",
        fields: ["title"],
      }),
      experimental_output: {
        dataset: "errors",
        query: "test",
        fields: ["title"],
        timeRange: null,
      },
    } as any);

    await expect(
      searchEvents.handler(
        {
          organizationSlug: "test-org",
          regionUrl: null,
          projectSlug: null,
          query: "any query",
          dataset: "errors",
          fields: null,
          sort: "-timestamp",
          period: "14d",
          limit: 10,
          includeExplanation: false,
        },
        {
          constraints: {
            organizationSlug: null,
            regionUrl: null,
            projectSlug: null,
          },
          accessToken: "test-token",
          userId: "1",
        },
      ),
    ).rejects.toThrow(UserInputError);
  });

  it("should handle agent self-correction when sort field not in fields array", async () => {
    // First call: Agent returns sort field not in fields (will fail validation)
    // Second call: Agent self-corrects by adding sort field to fields array
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify({
        dataset: "errors",
        query: "test",
        fields: ["title", "timestamp"], // Added timestamp after self-correction
        sort: "-timestamp",
      }),
      experimental_output: {
        dataset: "errors",
        query: "test",
        fields: ["title", "timestamp"],
        sort: "-timestamp",
        timeRange: null,
        explanation: "Self-corrected to include sort field in fields array",
      },
    } as any);

    // Mock the Sentry API response
    mswServer.use(
      http.get("https://sentry.io/api/0/organizations/test-org/events/", () => {
        return HttpResponse.json({
          data: [
            {
              id: "error1",
              title: "Test Error",
              timestamp: "2024-01-15T10:30:00Z",
            },
          ],
        });
      }),
    );

    const result = await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query: "recent errors",
        dataset: "errors",
        fields: null,
        sort: "-timestamp",
        period: "14d",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    // Verify the agent was called and result contains the data
    expect(mockGenerateText).toHaveBeenCalled();
    expect(result).toContain("Test Error");
  });

  it("should correctly handle user agent queries", async () => {
    // Mock AI response for user agent query in spans dataset
    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse(
        "spans",
        "has:gen_ai.tool.name AND has:user_agent.original",
        ["user_agent.original", "count()"],
        undefined,
        "-count()",
        { statsPeriod: "24h" },
      ),
    );

    // Mock the Sentry API response
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("dataset")).toBe("spans");
          expect(url.searchParams.get("query")).toBe(
            "has:gen_ai.tool.name AND has:user_agent.original",
          );
          expect(url.searchParams.get("sort")).toBe("-count()");
          expect(url.searchParams.get("statsPeriod")).toBe("24h");
          // Verify it's using user_agent.original, not user.id
          expect(url.searchParams.getAll("field")).toContain(
            "user_agent.original",
          );
          expect(url.searchParams.getAll("field")).toContain("count()");
          return HttpResponse.json({
            data: [
              {
                "user_agent.original":
                  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
                "count()": 150,
              },
              {
                "user_agent.original":
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "count()": 120,
              },
            ],
          });
        },
      ),
    );

    const result = await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        query: "which user agents have the most tool calls yesterday",
        dataset: "errors",
        fields: null,
        sort: "-timestamp",
        period: "14d",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    expect(mockGenerateText).toHaveBeenCalled();
    expect(result).toContain("Mozilla/5.0");
    expect(result).toContain("150");
    expect(result).toContain("120");
    // Should NOT contain user.id references
    expect(result).not.toContain("user.id");
  });

  it("should search events with direct query syntax (no agent)", async () => {
    process.env.OPENAI_API_KEY = "";
    process.env.ANTHROPIC_API_KEY = "";
    process.env.OPENROUTER_API_KEY = "";

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("dataset")).toBe("errors");
          expect(url.searchParams.get("query")).toBe("level:error");
          expect(url.searchParams.get("sort")).toBe("-timestamp");
          return HttpResponse.json({
            data: [
              {
                id: "error1",
                issue: "PROJ-123",
                title: "Database Error",
                level: "error",
                timestamp: "2024-01-15T10:30:00Z",
              },
            ],
          });
        },
      ),
    );

    const result = await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        dataset: "errors",
        query: "level:error",
        fields: ["issue", "title", "level", "timestamp"],
        sort: "-timestamp",
        period: "14d",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    // Should NOT have called the AI agent
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(result).toContain("Database Error");
  });

  it("uses one agent pass to complete incomplete requests before final validation", async () => {
    let eventsRequestUrl: URL | undefined;

    // Incomplete request (no fields/sort) forces the agent path. The agent is
    // expected to validateSearch internally; the handler only gates once.
    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse(
        "spans",
        "span.duration:>100 span.op:db",
        ["span.op", "span.duration"],
        undefined,
        "-span.duration",
        { statsPeriod: "7d" },
      ),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/validate/",
        () => HttpResponse.json(validEventsValidationResponse),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/",
        ({ request }) => {
          eventsRequestUrl = new URL(request.url);
          return HttpResponse.json({
            data: [
              {
                id: "span1",
                "span.op": "db",
                "span.duration": 42,
              },
            ],
          });
        },
      ),
    );

    const result = await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        dataset: "spans",
        query: "slow database queries",
        fields: null,
        sort: null,
        period: "24h",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(eventsRequestUrl).toBeDefined();
    expect(eventsRequestUrl!.searchParams.get("dataset")).toBe("spans");
    expect(eventsRequestUrl!.searchParams.get("query")).toBe(
      "span.duration:>100 span.op:db",
    );
    expect(eventsRequestUrl!.searchParams.getAll("field")).toEqual([
      "span.op",
      "span.duration",
    ]);
    expect(eventsRequestUrl!.searchParams.get("sort")).toBe("-span.duration");
    expect(eventsRequestUrl!.searchParams.get("statsPeriod")).toBe("7d");
    expect(result).toContain("span1");
  });

  it("fails complete structured requests honestly without an external repair loop", async () => {
    let validateCalls = 0;

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/validate/",
        () => {
          validateCalls += 1;
          return HttpResponse.json({
            valid: false,
            projects: [],
            dataset: [],
            environment: [],
            field: [
              {
                name: "spon.duration",
                valid: false,
                attrType: null,
                error: "Unknown attribute",
              },
            ],
            query: {
              valid: false,
              error: "Invalid syntax",
              fields: [
                {
                  name: "spon.duration",
                  valid: false,
                  attrType: null,
                  error: "Unknown attribute",
                },
              ],
            },
            orderby: [],
          });
        },
      ),
      http.get("https://sentry.io/api/0/organizations/test-org/events/", () => {
        throw new Error("searchEvents should not be called");
      }),
    );

    await expect(
      searchEvents.handler(
        {
          organizationSlug: "test-org",
          regionUrl: null,
          projectSlug: null,
          dataset: "spans",
          query: "spon.duration:>100",
          fields: ["spon.duration"],
          sort: "-spon.duration",
          period: "24h",
          limit: 10,
          includeExplanation: false,
        },
        {
          constraints: {
            organizationSlug: null,
            regionUrl: null,
            projectSlug: null,
          },
          accessToken: "test-token",
          userId: "1",
        },
      ),
    ).rejects.toThrow(/Search validation failed/);

    expect(validateCalls).toBe(1);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("rejects agent rewrites that downgrade structured filters to message full-text", async () => {
    // Tweet failure mode: agent rewrites conv_id:X -> message:"*X*". Keep the
    // structured filter and fail validation honestly instead of lucky hits.
    const validatedQueries: string[] = [];

    mockGenerateText.mockResolvedValue(
      mockAIResponse(
        "logs",
        'message:"*ZYGC-86ZR*"',
        ["timestamp", "message", "trace"],
        undefined,
        "-timestamp",
      ),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/validate/",
        ({ request }) => {
          const url = new URL(request.url);
          validatedQueries.push(url.searchParams.get("query") ?? "");
          return HttpResponse.json({
            valid: false,
            projects: [],
            dataset: [],
            environment: [],
            field: [],
            query: {
              valid: false,
              error: null,
              fields: [
                {
                  name: "conv_id",
                  valid: false,
                  attrType: null,
                  error: "Unknown attribute",
                },
              ],
            },
            orderby: [],
          });
        },
      ),
      http.get("https://sentry.io/api/0/organizations/test-org/events/", () => {
        throw new Error("searchEvents should not be called on downgrade");
      }),
    );

    await expect(
      searchEvents.handler(
        {
          organizationSlug: "test-org",
          regionUrl: null,
          projectSlug: null,
          dataset: "logs",
          query: "conv_id:ZYGC-86ZR",
          fields: null,
          sort: null,
          period: "24h",
          limit: 10,
          includeExplanation: false,
        },
        {
          constraints: {
            organizationSlug: null,
            regionUrl: null,
            projectSlug: null,
          },
          accessToken: "test-token",
          userId: "1",
        },
      ),
    ).rejects.toThrow(/Search validation failed/);

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    // Final validation must keep the structured filter, not the message rewrite.
    expect(validatedQueries.at(-1)).toBe("conv_id:ZYGC-86ZR");
    expect(validatedQueries.at(-1)).not.toContain("message:");
  });

  it("rejects partial full-text downgrades when a duplicate structured key remains", async () => {
    // Set-based key comparison would miss this: custom remains present after
    // custom:foo is dropped into message full-text.
    const validatedQueries: string[] = [];

    mockGenerateText.mockResolvedValue(
      mockAIResponse(
        "logs",
        'custom:bar message:"*foo*"',
        ["timestamp", "message", "trace"],
        undefined,
        "-timestamp",
      ),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/validate/",
        ({ request }) => {
          const url = new URL(request.url);
          validatedQueries.push(url.searchParams.get("query") ?? "");
          return HttpResponse.json({
            valid: false,
            projects: [],
            dataset: [],
            environment: [],
            field: [],
            query: {
              valid: false,
              error: null,
              fields: [
                {
                  name: "custom",
                  valid: false,
                  attrType: null,
                  error: "Unknown attribute",
                },
              ],
            },
            orderby: [],
          });
        },
      ),
      http.get("https://sentry.io/api/0/organizations/test-org/events/", () => {
        throw new Error("searchEvents should not be called on downgrade");
      }),
    );

    await expect(
      searchEvents.handler(
        {
          organizationSlug: "test-org",
          regionUrl: null,
          projectSlug: null,
          dataset: "logs",
          query: "custom:foo custom:bar",
          fields: null,
          sort: null,
          period: "24h",
          limit: 10,
          includeExplanation: false,
        },
        {
          constraints: {
            organizationSlug: null,
            regionUrl: null,
            projectSlug: null,
          },
          accessToken: "test-token",
          userId: "1",
        },
      ),
    ).rejects.toThrow(/Search validation failed/);

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(validatedQueries.at(-1)).toBe("custom:foo custom:bar");
    expect(validatedQueries.at(-1)).not.toContain("message:");
  });

  it("allows real attribute renames that are not full-text downgrades", async () => {
    let eventsRequestUrl: URL | undefined;

    // errors is not a trusted structured-trace dataset, so the handler uses the
    // downgrade guard only. A real rename must still execute.
    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse(
        "errors",
        "error.type:TimeoutError",
        ["issue", "title", "error.type", "timestamp"],
        undefined,
        "-timestamp",
      ),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/validate/",
        () => HttpResponse.json(validEventsValidationResponse),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/",
        ({ request }) => {
          eventsRequestUrl = new URL(request.url);
          return HttpResponse.json({
            data: [
              {
                id: "err1",
                issue: "PROJ-1",
                title: "TimeoutError",
                "error.type": "TimeoutError",
                timestamp: "2024-01-15T10:30:00Z",
              },
            ],
          });
        },
      ),
    );

    const result = await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        dataset: "errors",
        query: "eror.type:TimeoutError",
        fields: null,
        sort: null,
        period: "24h",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(eventsRequestUrl).toBeDefined();
    expect(eventsRequestUrl!.searchParams.get("dataset")).toBe("errors");
    expect(eventsRequestUrl!.searchParams.get("query")).toBe(
      "error.type:TimeoutError",
    );
    expect(eventsRequestUrl!.searchParams.getAll("field")).toEqual([
      "issue",
      "title",
      "error.type",
      "timestamp",
    ]);
    expect(result).toContain("TimeoutError");
  });

  it("keeps caller fields when the agent returns an empty fields array", async () => {
    let eventsRequestUrl: URL | undefined;

    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse(
        "spans",
        "span.duration:>100",
        [],
        undefined,
        "-span.duration",
      ),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/validate/",
        () => HttpResponse.json(validEventsValidationResponse),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/",
        ({ request }) => {
          eventsRequestUrl = new URL(request.url);
          return HttpResponse.json({
            data: [{ id: "span1", "span.duration": 42 }],
          });
        },
      ),
    );

    await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        dataset: "spans",
        query: "span.duration:>100",
        fields: ["span.duration"],
        sort: null,
        period: "24h",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    expect(eventsRequestUrl).toBeDefined();
    expect(eventsRequestUrl!.searchParams.getAll("field")).toEqual([
      "span.duration",
    ]);
  });

  it("merges agent environment into the events search query for non-replay datasets", async () => {
    let eventsRequestUrl: URL | undefined;
    let validationRequestUrl: URL | undefined;

    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse(
        "spans",
        "span.duration:>100",
        ["span.duration"],
        undefined,
        "-span.duration",
        undefined,
        "production",
      ),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/validate/",
        ({ request }) => {
          validationRequestUrl = new URL(request.url);
          return HttpResponse.json(validEventsValidationResponse);
        },
      ),
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/",
        ({ request }) => {
          eventsRequestUrl = new URL(request.url);
          return HttpResponse.json({
            data: [{ id: "span1", "span.duration": 42 }],
          });
        },
      ),
    );

    await searchEvents.handler(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        dataset: "spans",
        query: "span.duration:>100",
        fields: null,
        sort: null,
        period: "24h",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
    );

    expect(eventsRequestUrl).toBeDefined();
    expect(eventsRequestUrl!.searchParams.get("query")).toContain(
      "environment:production",
    );
    expect(validationRequestUrl!.searchParams.get("environment")).toBe(
      "production",
    );
  });

  it("does not call events when final validation fails", async () => {
    let validateCalls = 0;

    mockGenerateText.mockResolvedValue(
      mockAIResponse("spans", "tags[missing]:true", ["span.duration"]),
    );

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/validate/",
        () => {
          validateCalls += 1;
          return HttpResponse.json({
            valid: false,
            projects: [],
            dataset: [],
            environment: [],
            field: [],
            query: {
              valid: false,
              error: "Invalid syntax",
              fields: [
                {
                  name: "tags[missing]",
                  valid: false,
                  attrType: null,
                  error: "Unknown attribute",
                },
              ],
            },
            orderby: [],
          });
        },
      ),
      http.get("https://sentry.io/api/0/organizations/test-org/events/", () => {
        throw new Error("searchEvents should not be called");
      }),
    );

    await expect(
      searchEvents.handler(
        {
          organizationSlug: "test-org",
          regionUrl: null,
          projectSlug: null,
          dataset: "spans",
          query: "tags[missing]:true",
          fields: null,
          sort: null,
          period: "24h",
          limit: 10,
          includeExplanation: false,
        },
        {
          constraints: {
            organizationSlug: null,
            regionUrl: null,
            projectSlug: null,
          },
          accessToken: "test-token",
          userId: "1",
        },
      ),
    ).rejects.toThrow(/Search validation failed/);

    expect(validateCalls).toBe(1);
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  it("rejects search immediately when validation fails without an agent provider", async () => {
    process.env.OPENAI_API_KEY = "";
    process.env.ANTHROPIC_API_KEY = "";
    process.env.OPENROUTER_API_KEY = "";

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/validate/",
        () =>
          HttpResponse.json({
            valid: false,
            projects: [],
            dataset: [],
            environment: [],
            field: [
              {
                name: "spon.duration",
                valid: false,
                attrType: null,
                error: "Unknown attribute",
              },
            ],
            query: {
              valid: false,
              error: "Invalid syntax",
              fields: [
                {
                  name: "spon.duration",
                  valid: false,
                  attrType: null,
                  error: "Unknown attribute",
                },
              ],
            },
            orderby: [],
          }),
      ),
      http.get("https://sentry.io/api/0/organizations/test-org/events/", () => {
        throw new Error("searchEvents should not be called");
      }),
    );

    await expect(
      searchEvents.handler(
        {
          organizationSlug: "test-org",
          regionUrl: null,
          projectSlug: null,
          dataset: "spans",
          query: "spon.duration:>100",
          fields: ["spon.duration"],
          sort: "-spon.duration",
          period: "24h",
          limit: 10,
          includeExplanation: false,
        },
        {
          constraints: {
            organizationSlug: null,
            regionUrl: null,
            projectSlug: null,
          },
          accessToken: "test-token",
          userId: "1",
        },
      ),
    ).rejects.toThrow(/Search validation failed:/);

    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("keeps the caller's dataset when lockDataset is set", async () => {
    mockGenerateText.mockResolvedValueOnce(
      mockAIResponse("logs", "level:error"),
    );
    const requestedDatasets: Array<string | null> = [];
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/",
        ({ request }) => {
          requestedDatasets.push(
            new URL(request.url).searchParams.get("dataset"),
          );
          return HttpResponse.json({ data: [] });
        },
      ),
    );

    await runSearchEvents(
      {
        organizationSlug: "test-org",
        regionUrl: null,
        projectSlug: null,
        dataset: "errors",
        query: "how many errors today",
        limit: 10,
        includeExplanation: false,
      },
      {
        constraints: {
          organizationSlug: null,
          regionUrl: null,
          projectSlug: null,
        },
        accessToken: "test-token",
        userId: "1",
      },
      { lockDataset: true },
    );

    expect(requestedDatasets).toEqual(["errors"]);
    expect(JSON.stringify(mockGenerateText.mock.calls[0])).toContain(
      "The dataset is fixed to errors",
    );
  });

  describe("with Seer", () => {
    const seerParams = {
      organizationSlug: "test-org",
      regionUrl: null,
      projectSlug: "test-project",
      dataset: "spans" as const,
      query: "slowest http requests in the last day",
      fields: null,
      sort: null,
      period: undefined,
      limit: 10,
      includeExplanation: true,
    };
    const context = {
      constraints: {
        organizationSlug: null,
        regionUrl: null,
        projectSlug: null,
      },
      accessToken: "test-token",
      userId: "1",
    };
    const seerQuery = {
      query: "span.op:http.client",
      group_by: ["span.description"],
      visualization: [
        { chart_type: 1, y_axes: ["p95(span.duration)"], interval: null },
      ],
      sort: "-p95(span.duration)",
      stats_period: "24h",
      start: null,
      end: null,
      mode: "aggregates",
      result_count: 1,
      span_query: null,
      log_query: null,
      metric_query: null,
    };

    const mockOrganization = (
      features: string[],
      { hideAiFeatures = false } = {},
    ) =>
      http.get(
        "https://sentry.io/api/0/organizations/test-org/",
        ({ request }) =>
          HttpResponse.json({
            id: "1",
            slug: "test-org",
            name: "Test Org",
            // Sentry only serializes features when explicitly requested.
            ...(new URL(request.url).searchParams.get(
              "include_feature_flags",
            ) === "1"
              ? { features }
              : {}),
            hideAiFeatures,
          }),
      );
    const mockProject = http.get(
      "https://sentry.io/api/0/projects/test-org/test-project/",
      () => HttpResponse.json({ id: "42", slug: "test-project", name: "Test" }),
    );
    const mockSeerStart = vi.fn(async ({ request }: { request: Request }) => {
      expect(await request.json()).toEqual({
        project_ids: [42],
        natural_language_query: "slowest http requests in the last day",
        strategy: "Traces",
      });
      return HttpResponse.json({ run_id: 1, sentry_run_id: "run-uuid" });
    });
    const mockSeerState = (session: Record<string, unknown>) =>
      http.get(
        "https://sentry.io/api/0/organizations/test-org/search-agent/state/run-uuid/",
        () => HttpResponse.json({ session, sentry_run_id: "run-uuid" }),
      );

    beforeEach(() => {
      mockSeerStart.mockClear();
      mswServer.use(
        mockProject,
        http.post(
          "https://sentry.io/api/0/organizations/test-org/search-agent/start/",
          mockSeerStart,
        ),
      );
    });

    it("should translate natural language queries with Seer", async () => {
      mswServer.use(
        mockOrganization(["mcp-search-events-seer-translate"]),
        mockSeerState({
          status: "completed",
          final_response: { responses: [seerQuery], unsupported_reason: null },
        }),
        http.get(
          "https://sentry.io/api/0/organizations/test-org/events/",
          ({ request }) => {
            const url = new URL(request.url);
            expect(url.searchParams.get("dataset")).toBe("spans");
            expect(url.searchParams.get("query")).toBe("span.op:http.client");
            expect(url.searchParams.getAll("field")).toEqual([
              "span.description",
              "p95(span.duration)",
            ]);
            expect(url.searchParams.get("sort")).toBe("-p95(span.duration)");
            expect(url.searchParams.get("statsPeriod")).toBe("24h");
            return HttpResponse.json({
              data: [
                {
                  "span.description": "GET /api/users",
                  "p95(span.duration)": 1200,
                },
              ],
            });
          },
        ),
      );

      const result = await searchEvents.handler(seerParams, context);

      expect(mockSeerStart).toHaveBeenCalled();
      expect(mockGenerateText).not.toHaveBeenCalled();
      expect(result).toContain("GET /api/users");
      expect(result).toContain("Translated by Seer's search agent.");
    });

    it("should return a time series when Seer sets an interval", async () => {
      mswServer.use(
        mockOrganization(["mcp-search-events-seer-translate"]),
        mockSeerState({
          status: "completed",
          final_response: {
            responses: [
              {
                ...seerQuery,
                query: "",
                group_by: [],
                visualization: [
                  { chart_type: 1, y_axes: ["count()"], interval: "1d" },
                ],
                sort: "-count()",
                stats_period: "7d",
              },
            ],
            unsupported_reason: null,
          },
        }),
        http.get(
          "https://sentry.io/api/0/organizations/test-org/events-timeseries/",
          ({ request }) => {
            const url = new URL(request.url);
            expect(url.searchParams.get("yAxis")).toBe("count()");
            expect(url.searchParams.get("interval")).toBe("1d");
            expect(url.searchParams.get("dataset")).toBe("spans");
            expect(url.searchParams.get("statsPeriod")).toBe("7d");
            return HttpResponse.json({
              timeSeries: [
                {
                  yAxis: "count()",
                  values: [
                    { timestamp: 1757548800000, value: 5, incomplete: false },
                    { timestamp: 1757635200000, value: 8, incomplete: false },
                  ],
                  meta: { interval: 86400000 },
                },
              ],
            });
          },
        ),
      );

      const result = await searchEvents.handler(seerParams, context);

      expect(mockSeerStart).toHaveBeenCalled();
      expect(mockGenerateText).not.toHaveBeenCalled();
      expect(result).toContain("## count() over time");
      expect(result).toContain("- **Total**: 13");
      expect(result).not.toContain("**Warning:**");
    });

    it("should apply Seer's cross-event filters", async () => {
      mswServer.use(
        mockOrganization(["mcp-search-events-seer-translate"]),
        mockSeerState({
          status: "completed",
          final_response: {
            responses: [
              {
                ...seerQuery,
                span_query: "span.op:db",
                log_query: "severity:error",
              },
            ],
            unsupported_reason: null,
          },
        }),
        http.get(
          "https://sentry.io/api/0/organizations/test-org/events/",
          ({ request }) => {
            const url = new URL(request.url);
            expect(url.searchParams.get("spanQuery")).toBe("span.op:db");
            expect(url.searchParams.get("logQuery")).toBe("severity:error");
            expect(url.searchParams.has("metricQuery")).toBe(false);
            return HttpResponse.json({ data: [] });
          },
        ),
      );

      const result = await searchEvents.handler(seerParams, context);

      expect(result).toContain(
        "Only includes results whose trace also has matching spans `span.op:db`, logs `severity:error`.",
      );
      expect(result).not.toContain("**Warning:**");
    });

    it.each([false, undefined, true])(
      "warns about unapplied time-series filters with includeExplanation=%s",
      async (includeExplanation) => {
        mswServer.use(
          mockOrganization(["mcp-search-events-seer-translate"]),
          mockSeerState({
            status: "completed",
            final_response: {
              responses: [
                {
                  ...seerQuery,
                  group_by: [],
                  visualization: [
                    { chart_type: 1, y_axes: ["count()"], interval: "1h" },
                  ],
                  sort: "-count()",
                  span_query: "span.op:db",
                  log_query: "severity:error",
                  metric_query: "metric.name:requests",
                },
              ],
              unsupported_reason: null,
            },
          }),
          http.get(
            "https://sentry.io/api/0/organizations/test-org/events-timeseries/",
            ({ request }) => {
              const url = new URL(request.url);
              expect(url.searchParams.has("spanQuery")).toBe(false);
              expect(url.searchParams.has("logQuery")).toBe(false);
              expect(url.searchParams.has("metricQuery")).toBe(false);
              return HttpResponse.json({
                timeSeries: [
                  {
                    yAxis: "count()",
                    values: [
                      {
                        timestamp: 1757548800000,
                        value: 100,
                        incomplete: false,
                      },
                    ],
                    meta: { interval: 3600000 },
                  },
                ],
              });
            },
          ),
        );

        const result = await searchEvents.handler(
          {
            ...seerParams,
            includeExplanation:
              searchEvents.inputSchema.includeExplanation.parse(
                includeExplanation,
              ),
          },
          context,
        );

        const warning =
          "**Warning:** Time series results are unfiltered by the requested cross-event filters (spans `span.op:db`, logs `severity:error`, metrics `metric.name:requests`). Counts and other values may include events outside the requested subset.";
        expect(result.startsWith(`${warning}\n\n`)).toBe(true);
        expect(result.split(warning)).toHaveLength(2);
        expect(result.includes("Translated by Seer's search agent.")).toBe(
          includeExplanation === true,
        );
        expect(result).toContain("- **Total**: 100");
        if (includeExplanation === false) {
          expect(result).toMatchInlineSnapshot(`
            "**Warning:** Time series results are unfiltered by the requested cross-event filters (spans \`span.op:db\`, logs \`severity:error\`, metrics \`metric.name:requests\`). Counts and other values may include events outside the requested subset.

            # Search Results for "slowest http requests in the last day"

            ## count() over time
            - **Interval**: \`1h\`
            - **Time range**: Last 24h
            - **Total**: 100
            - **Peak**: 100 at 2025-09-11 00:00

            ## Buckets

            | Time (UTC) | Value |
            | --- | --- |
            | 2025-09-11 00:00 | 100 |

            **View these results in Sentry**:
            https://test-org.sentry.io/explore/traces/?query=span.op%3Ahttp.client&project=42&aggregateField=%7B%22yAxes%22%3A%5B%22count%28%29%22%5D%7D&mode=aggregate&sort=-count%28%29&statsPeriod=24h&table=span
            Please tell the user this dashboard link is available if they want to open the results in Sentry."
          `);
        }
      },
    );

    it("should keep a grouped Seer query with an interval as a table", async () => {
      mswServer.use(
        mockOrganization(["mcp-search-events-seer-translate"]),
        mockSeerState({
          status: "completed",
          final_response: {
            responses: [
              {
                ...seerQuery,
                visualization: [
                  {
                    chart_type: 1,
                    y_axes: ["p95(span.duration)"],
                    interval: "1h",
                  },
                ],
              },
            ],
            unsupported_reason: null,
          },
        }),
        http.get("https://sentry.io/api/0/organizations/test-org/events/", () =>
          HttpResponse.json({ data: [] }),
        ),
      );

      const result = await searchEvents.handler(seerParams, context);

      expect(result).not.toContain("over time");
    });

    it("should add an explicit environment to Seer's query", async () => {
      mswServer.use(
        mockOrganization(["mcp-search-events-seer-translate"]),
        mockSeerState({
          status: "completed",
          final_response: { responses: [seerQuery], unsupported_reason: null },
        }),
        http.get(
          "https://sentry.io/api/0/organizations/test-org/environments/",
          () => HttpResponse.json([{ id: "1", name: "production" }]),
        ),
        http.get(
          "https://sentry.io/api/0/organizations/test-org/events/",
          ({ request }) => {
            const url = new URL(request.url);
            expect(url.searchParams.get("query")).toBe(
              "span.op:http.client environment:production",
            );
            return HttpResponse.json({ data: [] });
          },
        ),
      );

      await searchEvents.handler(
        { ...seerParams, environment: "production" },
        context,
      );

      expect(mockSeerStart).toHaveBeenCalled();
      expect(mockGenerateText).not.toHaveBeenCalled();
    });

    it.each([
      ["suggest", context, true],
      [
        "not suggest in a project-scoped session",
        {
          ...context,
          constraints: { ...context.constraints, projectSlug: "test-project" },
        },
        false,
      ],
    ])(
      "should keep the requested project and %s Seer's wider scope",
      async (_, handlerContext, expectNote) => {
        mswServer.use(
          mockOrganization(["mcp-search-events-seer-translate"]),
          mockSeerState({
            status: "completed",
            final_response: {
              responses: [seerQuery],
              unsupported_reason: null,
              project_ids: [42, 43],
            },
          }),
          http.get(
            "https://sentry.io/api/0/organizations/test-org/events/",
            ({ request }) => {
              const url = new URL(request.url);
              expect(url.searchParams.getAll("project")).toEqual(["42"]);
              return HttpResponse.json({ data: [] });
            },
          ),
        );

        const result = await searchEvents.handler(seerParams, handlerContext);

        expect(mockSeerStart).toHaveBeenCalled();
        expect(
          result.includes("Seer suggested also searching project IDs 43"),
        ).toBe(expectNote);
      },
    );

    it("should keep the requested project when Seer does not broaden it", async () => {
      mswServer.use(
        mockOrganization(["mcp-search-events-seer-translate"]),
        mockSeerState({
          status: "completed",
          final_response: {
            responses: [seerQuery],
            unsupported_reason: null,
            project_ids: [42],
          },
        }),
        http.get(
          "https://sentry.io/api/0/organizations/test-org/events/",
          ({ request }) => {
            const url = new URL(request.url);
            expect(url.searchParams.getAll("project")).toEqual(["42"]);
            return HttpResponse.json({ data: [] });
          },
        ),
      );

      const result = await searchEvents.handler(seerParams, context);

      expect(mockSeerStart).toHaveBeenCalled();
      expect(result).not.toContain("Seer suggested also searching");
    });

    it("should search all accessible projects without a projectSlug", async () => {
      const mockAllProjectsStart = vi.fn(
        async ({ request }: { request: Request }) => {
          expect(await request.json()).toMatchObject({ project_ids: [-1] });
          return HttpResponse.json({ run_id: 1, sentry_run_id: "run-uuid" });
        },
      );
      mswServer.use(
        mockOrganization(["mcp-search-events-seer-translate"]),
        http.post(
          "https://sentry.io/api/0/organizations/test-org/search-agent/start/",
          mockAllProjectsStart,
        ),
        mockSeerState({
          status: "completed",
          final_response: { responses: [seerQuery], unsupported_reason: null },
        }),
        http.get(
          "https://sentry.io/api/0/organizations/test-org/environments/",
          ({ request }) => {
            expect(new URL(request.url).searchParams.get("project")).toBe("-1");
            return HttpResponse.json([{ id: "1", name: "production" }]);
          },
          { once: true },
        ),
        http.get(
          "https://sentry.io/api/0/organizations/test-org/events/validate/",
          ({ request }) => {
            expect(new URL(request.url).searchParams.get("project")).toBe("-1");
            return HttpResponse.json(validEventsValidationResponse);
          },
          { once: true },
        ),
        http.get(
          "https://sentry.io/api/0/organizations/test-org/events/",
          ({ request }) => {
            expect(new URL(request.url).searchParams.get("project")).toBe("-1");
            return HttpResponse.json({ data: [] });
          },
          { once: true },
        ),
      );

      const result = await searchEvents.handler(
        { ...seerParams, projectSlug: null, environment: "production" },
        context,
      );

      expect(mockAllProjectsStart).toHaveBeenCalled();
      expect(mockGenerateText).not.toHaveBeenCalled();
      expect(result).toContain("project=-1");
    });

    it("should keep Seer's all-project scope for time series", async () => {
      mswServer.use(
        mockOrganization(["mcp-search-events-seer-translate"]),
        http.post(
          "https://sentry.io/api/0/organizations/test-org/search-agent/start/",
          async ({ request }) => {
            expect(await request.json()).toMatchObject({ project_ids: [-1] });
            return HttpResponse.json({ run_id: 1, sentry_run_id: "run-uuid" });
          },
          { once: true },
        ),
        mockSeerState({
          status: "completed",
          final_response: {
            responses: [
              {
                ...seerQuery,
                group_by: [],
                visualization: [{ y_axes: ["count()"], interval: "1d" }],
              },
            ],
          },
        }),
        http.get(
          "https://sentry.io/api/0/organizations/test-org/events-timeseries/",
          ({ request }) => {
            expect(new URL(request.url).searchParams.get("project")).toBe("-1");
            return HttpResponse.json({ timeSeries: [] });
          },
          { once: true },
        ),
      );

      const result = await searchEvents.handler(
        { ...seerParams, projectSlug: null },
        context,
      );

      expect(result).toContain("project=-1");
    });

    it("should prefer an explicit period over Seer's time range", async () => {
      mswServer.use(
        mockOrganization(["mcp-search-events-seer-translate"]),
        mockSeerState({
          status: "completed",
          final_response: { responses: [seerQuery], unsupported_reason: null },
        }),
        http.get(
          "https://sentry.io/api/0/organizations/test-org/events/",
          ({ request }) => {
            const url = new URL(request.url);
            expect(url.searchParams.get("statsPeriod")).toBe("7d");
            return HttpResponse.json({ data: [] });
          },
        ),
      );

      await searchEvents.handler({ ...seerParams, period: "7d" }, context);

      expect(mockSeerStart).toHaveBeenCalled();
    });

    it("should not group by a non-aggregate Seer sort", async () => {
      mswServer.use(
        mockOrganization(["mcp-search-events-seer-translate"]),
        mockSeerState({
          status: "completed",
          final_response: {
            responses: [{ ...seerQuery, sort: "-timestamp" }],
            unsupported_reason: null,
          },
        }),
        http.get(
          "https://sentry.io/api/0/organizations/test-org/events/",
          ({ request }) => {
            const url = new URL(request.url);
            expect(url.searchParams.getAll("field")).toEqual([
              "span.description",
              "p95(span.duration)",
            ]);
            expect(url.searchParams.get("sort")).toBe("-p95(span.duration)");
            return HttpResponse.json({ data: [] });
          },
        ),
      );

      await searchEvents.handler(seerParams, context);

      expect(mockSeerStart).toHaveBeenCalled();
    });

    it.each([
      ["a structured query", { query: "span.op:http.client" }],
      ["explicit fields", { fields: ["span.description", "count()"] }],
      ["an explicit sort", { sort: "-count()" }],
    ])("should skip Seer for %s", async (_, overrides) => {
      mockGenerateText.mockResolvedValueOnce(
        mockAIResponse("spans", "span.op:http.client"),
      );
      mswServer.use(
        mockOrganization(["mcp-search-events-seer-translate"]),
        http.get("https://sentry.io/api/0/organizations/test-org/events/", () =>
          HttpResponse.json({ data: [] }),
        ),
      );

      await searchEvents.handler({ ...seerParams, ...overrides }, context);

      expect(mockSeerStart).not.toHaveBeenCalled();
      expect(mockGenerateText).toHaveBeenCalled();
    });

    it("should fall back to the agent when Seer is not enabled", async () => {
      mockGenerateText.mockResolvedValueOnce(
        mockAIResponse("spans", "span.op:http.client"),
      );
      mswServer.use(
        mockOrganization([]),
        http.get(
          "https://sentry.io/api/0/organizations/test-org/environments/",
          ({ request }) => {
            expect(new URL(request.url).searchParams.has("project")).toBe(
              false,
            );
            return HttpResponse.json([]);
          },
          { once: true },
        ),
        http.get(
          "https://sentry.io/api/0/organizations/test-org/events/validate/",
          ({ request }) => {
            expect(new URL(request.url).searchParams.has("project")).toBe(
              false,
            );
            return HttpResponse.json(validEventsValidationResponse);
          },
          { once: true },
        ),
        http.get(
          "https://sentry.io/api/0/organizations/test-org/events/",
          ({ request }) => {
            expect(new URL(request.url).searchParams.has("project")).toBe(
              false,
            );
            return HttpResponse.json({ data: [] });
          },
          { once: true },
        ),
      );

      await searchEvents.handler({ ...seerParams, projectSlug: null }, context);

      expect(mockSeerStart).not.toHaveBeenCalled();
      expect(mockGenerateText).toHaveBeenCalled();
    });

    it("should fall back to the agent when AI features are hidden", async () => {
      mockGenerateText.mockResolvedValueOnce(
        mockAIResponse("spans", "span.op:http.client"),
      );
      mswServer.use(
        mockOrganization(["mcp-search-events-seer-translate"], {
          hideAiFeatures: true,
        }),
        http.get("https://sentry.io/api/0/organizations/test-org/events/", () =>
          HttpResponse.json({ data: [] }),
        ),
      );

      await searchEvents.handler(seerParams, context);

      expect(mockSeerStart).not.toHaveBeenCalled();
      expect(mockGenerateText).toHaveBeenCalled();
    });

    it("should fall back to the agent when Seer cannot translate", async () => {
      mockGenerateText.mockResolvedValueOnce(
        mockAIResponse("spans", "span.op:http.client"),
      );
      mswServer.use(
        mockOrganization(["mcp-search-events-seer-translate"]),
        mockSeerState({ status: "error", unsupported_reason: "Unsupported" }),
        http.get("https://sentry.io/api/0/organizations/test-org/events/", () =>
          HttpResponse.json({ data: [] }),
        ),
      );

      await searchEvents.handler(seerParams, context);

      expect(mockSeerStart).toHaveBeenCalled();
      expect(mockGenerateText).toHaveBeenCalled();
    });

    it("should fall back to the agent when Seer returns 403", async () => {
      mockGenerateText.mockResolvedValueOnce(
        mockAIResponse("spans", "span.op:http.client"),
      );
      mswServer.use(
        mockOrganization(["mcp-search-events-seer-translate"]),
        http.post(
          "https://sentry.io/api/0/organizations/test-org/search-agent/start/",
          () =>
            HttpResponse.json(
              { detail: "Feature flag not enabled" },
              { status: 403 },
            ),
        ),
        http.get("https://sentry.io/api/0/organizations/test-org/events/", () =>
          HttpResponse.json({ data: [] }),
        ),
      );

      await searchEvents.handler(seerParams, context);

      expect(mockGenerateText).toHaveBeenCalled();
    });
  });
});
