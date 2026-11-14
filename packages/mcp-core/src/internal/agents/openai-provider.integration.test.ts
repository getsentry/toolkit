/**
 * Integration tests for OpenAI provider
 *
 * These tests verify that the OpenAI provider configuration works correctly
 * with the actual OpenAI API. They require OPENAI_API_KEY to be set.
 *
 * Unlike unit tests (which mock the AI SDK) and evals (which test tool prediction
 * but don't execute handlers), these tests actually call the embedded agents
 * with real OpenAI API calls while mocking Sentry API responses.
 *
 * This catches issues like:
 * - #623: structuredOutputs causing validation errors with nullable fields
 * - 405 errors from unsupported parameters (reasoningEffort)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { searchIssuesAgent } from "../../tools/support/search-issues/agent";
import { SentryApiService } from "../../api-client";
import { setAgentProvider } from "./provider-factory";

// Mock Sentry API server - intercepts Sentry calls but bypasses OpenAI
const mswServer = setupServer(
  // Mock the issue search fields endpoint (called by issueFields tool)
  http.get("https://sentry.io/api/0/organizations/*/issues/", () => {
    return HttpResponse.json([]);
  }),
  // Mock the tags endpoint for field discovery
  http.get("https://sentry.io/api/0/organizations/*/tags/", () => {
    return HttpResponse.json([
      { key: "environment", name: "Environment" },
      { key: "level", name: "Level" },
      { key: "release", name: "Release" },
      { key: "browser", name: "Browser" },
    ]);
  }),
  // Mock whoami endpoint (called by whoami tool)
  http.get("https://sentry.io/api/0/users/me/", () => {
    return HttpResponse.json({
      id: "12345",
      email: "test@example.com",
      name: "Test User",
    });
  }),
);

describe("OpenAI Provider Integration", () => {
  const hasOpenAIKey = Boolean(process.env["OPENAI_API_KEY"]);

  beforeAll(() => {
    if (hasOpenAIKey) {
      // Explicitly set OpenAI provider to ensure we test OpenAI even if
      // ANTHROPIC_API_KEY is also set (auto-detect prefers Anthropic)
      setAgentProvider("openai");
      mswServer.listen({ onUnhandledRequest: "bypass" });
    }
  });

  afterAll(() => {
    if (hasOpenAIKey) {
      setAgentProvider(undefined); // Reset for other tests
      mswServer.close();
    }
  });

  it.skipIf(!hasOpenAIKey)(
    "searchIssuesAgent translates natural language to Sentry query",
    { timeout: 60000 },
    async () => {
      // This tests the actual code path that broke in #623 and with gateway 405s
      // - Uses the real searchIssuesAgent (not mocked)
      // - Calls real OpenAI API
      // - Mocks only the Sentry API responses

      const apiService = new SentryApiService({
        accessToken: "test-token",
        host: "sentry.io",
      });

      const { result } = await searchIssuesAgent({
        query: "unresolved errors in production from the last week",
        organizationSlug: "test-org",
        apiService,
      });

      // Verify the agent returned a valid structured response
      expect(result).toBeDefined();
      expect(typeof result.query).toBe("string");
      expect(typeof result.explanation).toBe("string");

      // The query should contain relevant Sentry search syntax
      // (exact output varies, but should be parseable)
      expect(result.query.length).toBeGreaterThan(0);

      // sort can be null or one of the valid values
      expect(
        result.sort === null ||
          ["date", "freq", "new", "user", "recommended"].includes(result.sort),
      ).toBe(true);
    },
  );

  it.skipIf(!hasOpenAIKey)(
    "searchIssuesAgent handles nullable sort field correctly",
    { timeout: 60000 },
    async () => {
      // Specifically test that nullable fields work (the #623 issue)
      const apiService = new SentryApiService({
        accessToken: "test-token",
        host: "sentry.io",
      });

      const { result } = await searchIssuesAgent({
        query: "all issues", // Vague query where sort preference is unclear
        organizationSlug: "test-org",
        apiService,
      });

      // Should succeed without "required field" validation errors
      expect(result).toBeDefined();
      // sort being null is valid and tests the nullable field handling
      expect(
        result.sort === null ||
          ["date", "freq", "new", "user", "recommended"].includes(result.sort),
      ).toBe(true);
    },
  );
});
