/**
 * Conversations API Tests
 *
 * Tests for `listConversations` and `getConversationSpans` in
 * src/lib/api/conversations.ts, covering:
 * - listConversations sends correct params
 * - listConversations parses link header for pagination
 * - getConversationSpans parses the details envelope and extracts spans
 * - getConversationSpans paginates through multiple pages
 * - getConversationSpans returns truncated=true when pagination limit reached
 * - getConversationSpans returns truncated=false when all pages fetched
 *
 * Mocks fetch at the global level like other API test files (traces, replays).
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  getConversationSpans,
  listConversations,
} from "../../../src/lib/api/conversations.js";
import { MAX_PAGINATION_PAGES } from "../../../src/lib/api/infrastructure.js";
import { mockFetch, useTestConfigDir } from "../../helpers.js";

// ============================================================================
// Helpers
// ============================================================================

const ORG = "test-org";

/** Helper to mock fetch with a single OK response */
function mockOk(
  body: unknown,
  headers: Record<string, string> = {}
): { getCapturedUrl: () => string; getCapturedMethod: () => string } {
  let capturedUrl = "";
  let capturedMethod = "";

  globalThis.fetch = mockFetch(async (input, init) => {
    const req = new Request(input!, init);
    capturedUrl = req.url;
    capturedMethod = req.method;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json", ...headers },
    });
  });

  return {
    getCapturedUrl: () => capturedUrl,
    getCapturedMethod: () => capturedMethod,
  };
}

/**
 * Helper to mock sequential fetch responses for multi-page tests.
 * Each call to fetch returns the next response in the queue.
 */
function mockSequential(
  responses: Array<{ body: unknown; headers?: Record<string, string> }>
): { getCapturedUrls: () => string[] } {
  const capturedUrls: string[] = [];
  let callIndex = 0;

  globalThis.fetch = mockFetch(async (input, init) => {
    const req = new Request(input!, init);
    capturedUrls.push(req.url);

    const resp = responses[callIndex]!;
    callIndex += 1;

    return new Response(JSON.stringify(resp.body), {
      status: 200,
      headers: { "Content-Type": "application/json", ...resp.headers },
    });
  });

  return { getCapturedUrls: () => capturedUrls };
}

/** Build a Link header with next cursor */
function linkHeader(cursor: string, results = "true"): Record<string, string> {
  return {
    Link: `<https://sentry.io/api/0/next/>; rel="next"; results="${results}"; cursor="${cursor}"`,
  };
}

// ============================================================================
// Setup
// ============================================================================

useTestConfigDir("conversations-api-test-");

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ============================================================================
// listConversations
// ============================================================================

describe("listConversations", () => {
  test("hits /organizations/{org}/agents/conversations/ with GET", async () => {
    const { getCapturedUrl, getCapturedMethod } = mockOk([]);

    await listConversations(ORG);

    expect(getCapturedMethod()).toBe("GET");
    expect(getCapturedUrl()).toContain(
      `/api/0/organizations/${ORG}/agents/conversations/`
    );
  });

  test("sends per_page=10 by default", async () => {
    const { getCapturedUrl } = mockOk([]);

    await listConversations(ORG);

    expect(getCapturedUrl()).toContain("per_page=10");
  });

  test("passes custom limit as per_page", async () => {
    const { getCapturedUrl } = mockOk([]);

    await listConversations(ORG, { limit: 50 });

    expect(getCapturedUrl()).toContain("per_page=50");
  });

  test("passes query param", async () => {
    const { getCapturedUrl } = mockOk([]);

    await listConversations(ORG, { query: "has:errors" });

    expect(decodeURIComponent(getCapturedUrl())).toContain("query=has:errors");
  });

  test("passes statsPeriod param", async () => {
    const { getCapturedUrl } = mockOk([]);

    await listConversations(ORG, { statsPeriod: "24h" });

    expect(getCapturedUrl()).toContain("statsPeriod=24h");
  });

  test("passes start and end params", async () => {
    const { getCapturedUrl } = mockOk([]);

    await listConversations(ORG, {
      start: "2024-01-01T00:00:00",
      end: "2024-01-31T23:59:59",
    });

    const url = getCapturedUrl();
    expect(url).toContain("start=");
    expect(url).toContain("end=");
  });

  test("passes cursor param", async () => {
    const { getCapturedUrl } = mockOk([]);

    await listConversations(ORG, { cursor: "1735689600000:0:0" });

    expect(getCapturedUrl()).toContain(
      `cursor=${encodeURIComponent("1735689600000:0:0")}`
    );
  });

  test("passes project param", async () => {
    const { getCapturedUrl } = mockOk([]);

    await listConversations(ORG, { project: "my-project" });

    expect(getCapturedUrl()).toContain("project=my-project");
  });

  test("does not include undefined optional params", async () => {
    const { getCapturedUrl } = mockOk([]);

    await listConversations(ORG, { limit: 10 });

    const url = getCapturedUrl();
    expect(url).not.toContain("query=");
    expect(url).not.toContain("statsPeriod=");
    expect(url).not.toContain("start=");
    expect(url).not.toContain("end=");
    expect(url).not.toContain("cursor=");
    expect(url).not.toContain("project=");
  });

  test("parses link header for next cursor", async () => {
    mockOk([], linkHeader("1735689600000:0:0"));

    const result = await listConversations(ORG);

    expect(result.nextCursor).toBe("1735689600000:0:0");
  });

  test("returns undefined nextCursor when no more pages", async () => {
    mockOk([]);

    const result = await listConversations(ORG);

    expect(result.nextCursor).toBeUndefined();
  });

  test("returns data from response", async () => {
    const conversations = [
      {
        conversationId: "conv-abc",
        webUrl:
          "https://sentry.io/organizations/test-org/explore/agents/conversations/conv-abc/",
        flow: [],
        errors: 0,
        llmCalls: 1,
        toolCalls: 0,
        totalTokens: 100,
        totalCost: 0,
        startTimestamp: 1_716_500_000,
        endTimestamp: 1_716_500_060,
        traceCount: 1,
        traceIds: [],
        firstInput: "hello",
        lastOutput: "hi",
        toolNames: [],
        toolErrors: 0,
      },
    ];
    mockOk(conversations);

    const result = await listConversations(ORG);

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      conversationId: "conv-abc",
      webUrl:
        "https://sentry.io/organizations/test-org/explore/agents/conversations/conv-abc/",
    });
  });

  test("caps per_page at API_MAX_PER_PAGE when limit exceeds it", async () => {
    const { getCapturedUrl } = mockOk([]);

    await listConversations(ORG, { limit: 200 });

    expect(getCapturedUrl()).toContain("per_page=100");
    expect(getCapturedUrl()).not.toContain("per_page=200");
  });

  test("accumulates results across pages when limit > API_MAX_PER_PAGE", async () => {
    const item = (id: string) => ({
      conversationId: id,
      flow: [],
      errors: 0,
      llmCalls: 0,
      toolCalls: 0,
      totalTokens: 0,
      totalCost: 0,
      startTimestamp: 1_716_500_000,
      endTimestamp: 1_716_500_060,
      traceCount: 0,
      traceIds: [],
      firstInput: "",
      lastOutput: "",
      toolNames: [],
      toolErrors: 0,
    });

    const { getCapturedUrls } = mockSequential([
      { body: [item("c1")], headers: linkHeader("cursor1") },
      { body: [item("c2")], headers: linkHeader("cursor2", "false") },
    ]);

    const result = await listConversations(ORG, { limit: 200 });

    expect(result.data).toHaveLength(2);
    expect(result.data.map((c) => c.conversationId)).toEqual(["c1", "c2"]);
    expect(getCapturedUrls()[0]).toContain("per_page=100");
  });
});

// ============================================================================
// getConversationSpans
// ============================================================================

describe("getConversationSpans", () => {
  const CONV_ID = "conv-abc-123";

  /** Minimal valid span for schema validation */
  function makeSpan(id: string) {
    return {
      "gen_ai.conversation.id": CONV_ID,
      span_id: id,
      trace: "00112233445566778899aabbccddeeff",
      project: "my-project",
      "project.id": 42,
      "span.name": "gen_ai.invoke_agent",
      "span.status": "ok",
      "precise.start_ts": 1_716_500_000,
      "precise.finish_ts": 1_716_500_010,
      "gen_ai.operation.type": "ai_client",
    };
  }

  /** Details envelope returned by the conversation details endpoint. */
  function makeEnvelope(
    spans: ReturnType<typeof makeSpan>[],
    title: string | null = "Test conversation"
  ) {
    return {
      conversationId: CONV_ID,
      title,
      spans,
    };
  }

  test("hits /organizations/{org}/agents/conversations/{conversationId}/ with GET", async () => {
    const { getCapturedUrl, getCapturedMethod } = mockOk(makeEnvelope([]));

    await getConversationSpans(ORG, CONV_ID);

    expect(getCapturedMethod()).toBe("GET");
    expect(getCapturedUrl()).toContain(
      `/api/0/organizations/${ORG}/agents/conversations/${CONV_ID}/`
    );
  });

  test("sends default per_page=1000 and statsPeriod=30d", async () => {
    const { getCapturedUrl } = mockOk(makeEnvelope([]));

    await getConversationSpans(ORG, CONV_ID);

    const url = getCapturedUrl();
    expect(url).toContain("per_page=1000");
    expect(url).toContain("statsPeriod=30d");
  });

  test("returns spans from a single page envelope", async () => {
    const spans = [makeSpan("span-1-aabb1122")];
    mockOk(makeEnvelope(spans, "Refund flow"));

    const result = await getConversationSpans(ORG, CONV_ID);

    expect(result.spans).toHaveLength(1);
    expect(result.spans[0].span_id).toBe("span-1-aabb1122");
    expect(result.title).toBe("Refund flow");
    expect(result.truncated).toBe(false);
  });

  test("rejects a bare span array (pre-envelope response shape)", async () => {
    mockOk([makeSpan("span-1-aabb1122")]);

    await expect(getConversationSpans(ORG, CONV_ID)).rejects.toThrow(
      /Unexpected response format/
    );
  });

  test("paginates through multiple pages", async () => {
    const { getCapturedUrls } = mockSequential([
      {
        body: makeEnvelope([makeSpan("span-page-1-aa11")], "Multi-page"),
        headers: linkHeader("page-2-cursor"),
      },
      {
        body: makeEnvelope([makeSpan("span-page-2-bb22")], "Multi-page"),
        // No Link header → last page
      },
    ]);

    const result = await getConversationSpans(ORG, CONV_ID);

    expect(result.spans).toHaveLength(2);
    expect(result.spans[0].span_id).toBe("span-page-1-aa11");
    expect(result.spans[1].span_id).toBe("span-page-2-bb22");
    // Title is taken from the first page
    expect(result.title).toBe("Multi-page");
    expect(result.truncated).toBe(false);
    expect(getCapturedUrls()).toHaveLength(2);
    // Second request should include cursor
    expect(getCapturedUrls()[1]).toContain("cursor=page-2-cursor");
  });

  test("returns truncated=true when pagination limit reached", async () => {
    // Create responses that always have more pages
    const responses = Array.from({ length: MAX_PAGINATION_PAGES }, (_, i) => ({
      body: makeEnvelope([makeSpan(`span-${i}-aabb1122`)]),
      headers: linkHeader("always-more-cursor"),
    }));

    mockSequential(responses);

    const result = await getConversationSpans(ORG, CONV_ID);

    expect(result.truncated).toBe(true);
    expect(result.spans).toHaveLength(MAX_PAGINATION_PAGES);
  });

  test("returns truncated=false when all pages fetched before limit", async () => {
    mockOk(makeEnvelope([makeSpan("only-page-span1")], null));

    const result = await getConversationSpans(ORG, CONV_ID);

    expect(result.truncated).toBe(false);
    expect(result.title).toBeNull();
  });

  test("uses custom options when provided", async () => {
    const { getCapturedUrl } = mockOk(makeEnvelope([]));

    await getConversationSpans(ORG, CONV_ID, {
      statsPeriod: "7d",
      project: "my-project",
      perPage: 500,
    });

    const url = getCapturedUrl();
    expect(url).toContain("per_page=500");
    expect(url).toContain("statsPeriod=7d");
    expect(url).toContain("project=my-project");
  });

  test("encodes conversationId in URL", async () => {
    const specialId = "conv/with special";
    const { getCapturedUrl } = mockOk({
      conversationId: specialId,
      title: null,
      spans: [],
    });

    await getConversationSpans(ORG, specialId);

    expect(getCapturedUrl()).toContain(
      `/agents/conversations/${encodeURIComponent(specialId)}/`
    );
  });
});
