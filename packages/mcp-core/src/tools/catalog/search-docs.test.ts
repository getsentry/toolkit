import { describe, expect, it, vi } from "vitest";
import { ApiRateLimitError, ApiServerError } from "../../api-client/index";
import type { ServerContext } from "../../types";
import searchDocs, { searchDocsOutputSchema } from "./search-docs.js";

const baseContext: ServerContext = {
  constraints: {
    organizationSlug: null,
  },
  accessToken: "access-token",
  userId: "1",
  mcpUrl: "https://mcp.sentry.dev",
};

function mockSearchResponse(body: unknown) {
  return vi.spyOn(global, "fetch").mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => body,
  } as Response);
}

function searchResult(index: number) {
  return {
    id: `platforms/python/page-${index}.md`,
    url: `https://docs.sentry.io/platforms/python/page-${index}`,
    snippet: `Snippet ${index}`,
    relevance: 0.9 - index / 100,
  };
}

describe("search_docs", () => {
  // Note: Query validation (empty, too short, too long) is now handled by Zod schema
  // These validation tests are no longer needed as they test framework behavior, not our tool logic

  it("searches across all docs when guide is omitted", async () => {
    const mockFetch = vi.spyOn(global, "fetch");

    const result = await searchDocs.handler(
      {
        query: "How do I configure rate limiting?",
        maxResults: 5,
      },
      baseContext,
    );
    expect(mockFetch).toHaveBeenCalledWith(
      "https://mcp.sentry.dev/api/search",
      expect.objectContaining({
        body: JSON.stringify({
          query: "How do I configure rate limiting?",
          maxResults: 5,
        }),
      }),
    );
    // The search route rejects `guide: null` (#788), so omit the key.
    const requestBody = JSON.parse(
      mockFetch.mock.calls[0]?.[1]?.body as string,
    ) as Record<string, unknown>;
    expect(requestBody).not.toHaveProperty("guide");
    searchDocsOutputSchema.parse(result.structuredContent);
    expect(result.structuredContent).toMatchInlineSnapshot(`
      {
        "guide": null,
        "query": "How do I configure rate limiting?",
        "results": [
          {
            "path": "product/rate-limiting.md",
            "relevance": 0.95,
            "snippet": "Learn how to configure rate limiting in Sentry to prevent quota exhaustion and control event ingestion.",
            "url": "https://docs.sentry.io/product/rate-limiting",
          },
          {
            "path": "product/accounts/quotas/spike-protection.md",
            "relevance": 0.87,
            "snippet": "Spike protection helps prevent unexpected spikes in event volume from consuming your quota.",
            "url": "https://docs.sentry.io/product/accounts/quotas/spike-protection",
          },
        ],
        "suggestedActions": [
          {
            "arguments": {
              "path": "product/rate-limiting.md",
            },
            "reason": "Results are snippets; fetch the full page for the top match.",
            "toolName": "get_doc",
            "type": "tool_call",
          },
        ],
      }
    `);
  });

  it("includes guide in output and request", async () => {
    const mockFetch = vi.spyOn(global, "fetch");

    const result = await searchDocs.handler(
      {
        query: "test query",
        maxResults: 5,
        guide: "javascript/nextjs",
      },
      baseContext,
    );

    searchDocsOutputSchema.parse(result.structuredContent);
    expect(result.structuredContent.guide).toBe("javascript/nextjs");
    expect(result.structuredContent.results[0]?.path).toBe(
      "platforms/javascript/guides/nextjs.md",
    );
    expect(mockFetch).toHaveBeenCalledWith(
      "https://mcp.sentry.dev/api/search",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: "test query",
          maxResults: 5,
          guide: "javascript/nextjs",
        }),
      }),
    );
  });

  it("keeps snippets for the first three results only", async () => {
    mockSearchResponse({
      query: "test query",
      results: [0, 1, 2, 3, 4].map(searchResult),
    });

    const result = await searchDocs.handler(
      { query: "test query", maxResults: 5 },
      baseContext,
    );

    searchDocsOutputSchema.parse(result.structuredContent);
    expect(
      result.structuredContent.results.map((item) => item.snippet),
    ).toEqual(["Snippet 0", "Snippet 1", "Snippet 2", null, null]);
  });

  it("maps only documented result fields", async () => {
    mockSearchResponse({
      query: "test query",
      results: [{ ...searchResult(0), score: 0.9, attributes: { a: 1 } }],
    });

    const result = await searchDocs.handler(
      { query: "test query", maxResults: 3 },
      baseContext,
    );

    expect(Object.keys(result.structuredContent)).toEqual([
      "query",
      "guide",
      "results",
      "suggestedActions",
    ]);
    expect(Object.keys(result.structuredContent.results[0] ?? {})).toEqual([
      "path",
      "url",
      "relevance",
      "snippet",
    ]);
  });

  it("suggests get_doc for the first result with a path", async () => {
    mockSearchResponse({
      query: "test query",
      results: [{ ...searchResult(0), id: "", url: "" }, searchResult(1)],
    });

    const result = await searchDocs.handler(
      { query: "test query", maxResults: 3 },
      baseContext,
    );

    expect(result.structuredContent.suggestedActions).toEqual([
      expect.objectContaining({
        toolName: "get_doc",
        arguments: { path: "platforms/python/page-1.md" },
      }),
    ]);
  });

  it("returns empty results without a follow-up action", async () => {
    mockSearchResponse({ query: "nothing matches", results: [] });

    const result = await searchDocs.handler(
      { query: "nothing matches", maxResults: 3 },
      baseContext,
    );

    searchDocsOutputSchema.parse(result.structuredContent);
    expect(result.structuredContent).toEqual({
      query: "nothing matches",
      guide: null,
      results: [],
      suggestedActions: [],
    });
  });

  it("omits the get_doc action when get_doc is unavailable", async () => {
    const result = await searchDocs.handler(
      { query: "test query", maxResults: 3 },
      { ...baseContext, availableToolNames: new Set(["search_docs"]) },
    );

    expect(result.structuredContent.results.length).toBeGreaterThan(0);
    expect(result.structuredContent.suggestedActions).toEqual([]);
  });

  it("throws a server error when a success response reports an error", async () => {
    mockSearchResponse({ query: "test query", results: [], error: "boom" });

    const promise = searchDocs.handler(
      { query: "test query", maxResults: 3 },
      baseContext,
    );

    await expect(promise).rejects.toBeInstanceOf(ApiServerError);
    await expect(promise).rejects.toThrow("boom");
  });

  it("handles API errors", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => ({ error: "Internal server error" }),
    } as Response);

    const promise = searchDocs.handler(
      {
        query: "test query",
        maxResults: 3,
      },
      baseContext,
    );

    await expect(promise).rejects.toBeInstanceOf(ApiServerError);
    await expect(promise).rejects.toThrow("Internal server error");
  });

  it("types rate limit responses", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ error: "Rate limit exceeded." }),
    } as Response);

    await expect(
      searchDocs.handler({ query: "test query", maxResults: 3 }, baseContext),
    ).rejects.toBeInstanceOf(ApiRateLimitError);
  });

  it("handles timeout errors", async () => {
    // Mock fetch to simulate a timeout by throwing an AbortError
    vi.spyOn(global, "fetch").mockImplementationOnce(() => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      return Promise.reject(error);
    });

    await expect(
      searchDocs.handler(
        {
          query: "test query",
          maxResults: 3,
        },
        baseContext,
      ),
    ).rejects.toThrow("Request timeout after 15000ms");
  });
});
