import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { mswServer } from "@sentry/mcp-server-mocks";
import searchAIConversations from "./search-agent-conversations";
import { getServerContext } from "../../test-setup";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content";

const baseConversation = {
  conversationId: "conv-123",
  title: "Checkout worker timeouts",
  flow: ["triage-agent"],
  errors: 1,
  llmCalls: 2,
  toolCalls: 1,
  totalTokens: 1200,
  totalCost: 0.6260719999999997,
  startTimestamp: 1713805400000,
  endTimestamp: 1713805415000,
  traceCount: 1,
  traceIds: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  firstInput: "What failed in checkout?",
  lastOutput: "The checkout worker is timing out.",
  user: {
    id: "1",
    email: "dev@example.com",
    username: "dev",
    ip_address: "127.0.0.1",
    backendOnlyField: "do-not-leak",
  },
  toolNames: ["search_events"],
  toolErrors: 1,
};

const longConversation = {
  ...baseConversation,
  conversationId: "conv-long",
  traceCount: 4,
  traceIds: [
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "cccccccccccccccccccccccccccccccc",
    "dddddddddddddddddddddddddddddddd",
  ],
  firstInput: `${"Investigate checkout failures. ".repeat(20)}Root cause?`,
  lastOutput: `${"The worker timed out while calling inventory. ".repeat(20)}Next step.`,
};

describe("search_agent_conversations", () => {
  it("returns conversation-shaped search results", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/agents/conversations/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("query")).toBe("checkout");
          expect(url.searchParams.get("sort")).toBe(null);
          expect(url.searchParams.get("statsPeriod")).toBe("7d");
          expect(url.searchParams.get("per_page")).toBe("10");
          return HttpResponse.json([baseConversation]);
        },
      ),
    );

    const result = await searchAIConversations.handler(
      {
        organizationSlug: "test-org",
        query: "checkout",
        period: "7d",
        limit: 10,
      },
      getServerContext(),
    );

    const structuredContent = getStructuredContent<{
      organizationSlug: string;
      searchUrl: string;
      count: number;
      conversations: Array<{
        conversationId: string;
        url: string;
        durationMs: number;
        user: Record<string, unknown> | null;
      }>;
    }>(result);

    expect(structuredContent.conversations[0]).not.toHaveProperty("firstInput");
    expect(structuredContent.conversations[0]).not.toHaveProperty("lastOutput");
    expect(structuredContent.conversations[0]).not.toHaveProperty("traceIds");
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "conversations": [
          {
            "aiCallCount": 2,
            "conversationId": "conv-123",
            "durationMs": 15000,
            "endTimestamp": 1713805415000,
            "errors": 1,
            "firstInputPreview": "What failed in checkout?",
            "flow": [
              "triage-agent",
            ],
            "lastOutputPreview": "The checkout worker is timing out.",
            "sampleTraceIds": [
              "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ],
            "startTimestamp": 1713805400000,
            "title": "Checkout worker timeouts",
            "toolCallCount": 1,
            "toolErrorCount": 1,
            "toolNames": [
              "search_events",
            ],
            "totalCost": "$0.626",
            "totalTokens": 1200,
            "traceCount": 1,
            "url": "https://test-org.sentry.io/explore/conversations/conv-123/",
            "user": {
              "email": "dev@example.com",
              "username": "dev",
            },
          },
        ],
        "count": 1,
        "nextCursor": null,
        "organizationSlug": "test-org",
        "searchUrl": "https://test-org.sentry.io/explore/conversations/?query=checkout&statsPeriod=7d",
      }
    `);
    assertStructuredOnlyResult(result);
    expect(structuredContent.conversations[0]?.user).not.toHaveProperty(
      "backendOnlyField",
    );
    expect(structuredContent.conversations[0]?.user).not.toHaveProperty("id");
    expect(structuredContent.conversations[0]?.user).not.toHaveProperty(
      "ip_address",
    );
  });

  it("uses the Agent Monitoring display rules for small and missing costs", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/agents/conversations/",
        () =>
          HttpResponse.json([
            {
              ...baseConversation,
              conversationId: "sub-cent",
              totalCost: 0.00333,
            },
            { ...baseConversation, conversationId: "missing", totalCost: 0 },
          ]),
      ),
    );

    const result = await searchAIConversations.handler(
      {
        organizationSlug: "test-org",
        period: "30d",
        limit: 10,
      },
      getServerContext(),
    );

    const structuredContent = getStructuredContent<{
      conversations: Array<{ totalCost: string }>;
    }>(result);

    expect(
      structuredContent.conversations.map(
        (conversation) => conversation.totalCost,
      ),
    ).toEqual(["<$0.01", "—"]);
  });

  it("keeps search results concise for large conversations", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/agents/conversations/",
        () => HttpResponse.json([longConversation]),
      ),
    );

    const result = await searchAIConversations.handler(
      {
        organizationSlug: "test-org",
        period: "30d",
        limit: 10,
      },
      getServerContext(),
    );

    const structuredContent = getStructuredContent<{
      conversations: Array<{
        firstInputPreview: string | null;
        lastOutputPreview: string | null;
        sampleTraceIds: string[];
      }>;
    }>(result);
    const conversation = structuredContent.conversations[0];

    expect(conversation.firstInputPreview).toHaveLength(240);
    expect(conversation.firstInputPreview?.endsWith("...")).toBe(true);
    expect(conversation.lastOutputPreview).toHaveLength(240);
    expect(conversation.lastOutputPreview?.endsWith("...")).toBe(true);
    expect(conversation.sampleTraceIds).toEqual([
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "cccccccccccccccccccccccccccccccc",
    ]);
  });

  it("defaults searches to the same 30d window as detail lookups", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/agents/conversations/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("statsPeriod")).toBe("30d");
          expect(url.searchParams.get("start")).toBe(null);
          expect(url.searchParams.get("end")).toBe(null);
          expect(url.searchParams.get("per_page")).toBe("10");
          return HttpResponse.json([]);
        },
      ),
    );

    const result = await searchAIConversations.handler(
      {
        organizationSlug: "test-org",
        period: "30d",
        limit: 10,
      },
      getServerContext(),
    );

    const structuredContent = getStructuredContent<{
      searchUrl: string;
    }>(result);

    assertStructuredOnlyResult(result);
    expect(structuredContent.searchUrl).toBe(
      "https://test-org.sentry.io/explore/conversations/?statsPeriod=30d",
    );
  });

  it("defaults to the configured search window when period is omitted", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/agents/conversations/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("statsPeriod")).toBe("30d");
          expect(url.searchParams.get("per_page")).toBe("10");
          return HttpResponse.json([]);
        },
      ),
    );

    const result = await searchAIConversations.handler(
      {
        organizationSlug: "test-org",
        period: "30d",
        limit: 10,
      },
      getServerContext(),
    );

    const structuredContent = getStructuredContent<{
      searchUrl: string;
    }>(result);

    expect(structuredContent.searchUrl).toBe(
      "https://test-org.sentry.io/explore/conversations/?statsPeriod=30d",
    );
  });

  it("passes filters, resolves project slugs, and returns pagination hints", async () => {
    const requestUrls: string[] = [];
    mswServer.use(
      http.get("https://sentry.io/api/0/projects/test-org/backend/", () =>
        HttpResponse.json({
          id: "4509109107622913",
          slug: "backend",
          name: "backend",
        }),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/test-org/agents/conversations/",
        ({ request }) => {
          requestUrls.push(request.url);
          return HttpResponse.json([], {
            headers: {
              Link: '<https://sentry.io/api/0/organizations/test-org/agents/conversations/?cursor=page-2>; rel="next"; results="true"; cursor="page-2"',
            },
          });
        },
      ),
    );

    const result = await searchAIConversations.handler(
      {
        organizationSlug: "test-org",
        query: "failed",
        project: "backend",
        environment: ["production", "staging"],
        period: "30d",
        start: "2026-06-01T00:00:00Z",
        end: "2026-06-02T00:00:00Z",
        cursor: "page-1",
        limit: 25,
      },
      getServerContext(),
    );

    const params = new URL(requestUrls[0]).searchParams;
    expect(params.get("query")).toBe("failed");
    expect(params.get("sort")).toBe(null);
    expect(params.getAll("project")).toEqual(["4509109107622913"]);
    expect(params.getAll("environment")).toEqual(["production", "staging"]);
    expect(params.get("statsPeriod")).toBe(null);
    expect(params.get("start")).toBe("2026-06-01T00:00:00Z");
    expect(params.get("end")).toBe("2026-06-02T00:00:00Z");
    expect(params.get("cursor")).toBe("page-1");
    expect(params.get("per_page")).toBe("25");
    const structuredContent = getStructuredContent<{
      count: number;
      nextCursor: string | null;
      conversations: unknown[];
    }>(result);

    assertStructuredOnlyResult(result);
    expect(structuredContent).toMatchObject({
      count: 0,
      nextCursor: "page-2",
      conversations: [],
    });
  });

  it("lets absolute time ranges override period", async () => {
    let requestUrl: string | undefined;
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/agents/conversations/",
        ({ request }) => {
          requestUrl = request.url;
          return HttpResponse.json([]);
        },
      ),
    );

    await searchAIConversations.handler(
      {
        organizationSlug: "test-org",
        period: "7d",
        start: "2026-06-01T00:00:00Z",
        end: "2026-06-02T00:00:00Z",
        limit: 10,
      },
      getServerContext(),
    );

    const params = new URL(requestUrl!).searchParams;
    expect(params.get("statsPeriod")).toBe(null);
    expect(params.get("start")).toBe("2026-06-01T00:00:00Z");
    expect(params.get("end")).toBe("2026-06-02T00:00:00Z");
  });

  it("rejects partial absolute time ranges", async () => {
    await expect(
      searchAIConversations.handler(
        {
          organizationSlug: "test-org",
          period: "30d",
          start: "2026-06-01T00:00:00Z",
          limit: 10,
        },
        getServerContext(),
      ),
    ).rejects.toThrow("`start` and `end` must be provided together.");
  });
});
