import { mswServer } from "@sentry/mcp-server-mocks";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { SentryApiService } from "../../../api-client";
import {
  discoverDatasetFields,
  getCommonPatterns,
  getFieldExamples,
} from "./dataset-fields";

// Test the core logic functions directly without AI SDK complexity

describe("dataset-fields agent tool", () => {
  let apiService: SentryApiService;

  beforeEach(() => {
    apiService = new SentryApiService({
      accessToken: "test-token",
    });
  });

  describe("discoverDatasetFields", () => {
    it("should discover fields for search_issues dataset", async () => {
      // Mock the tags API response for issues
      mswServer.use(
        http.get(
          "https://sentry.io/api/0/organizations/sentry-mcp-evals/tags/",
          ({ request }) => {
            const url = new URL(request.url);
            expect(url.searchParams.get("dataset")).toBe("search_issues");
            expect(url.searchParams.get("project")).toBe("4509062593708032");
            expect(url.searchParams.get("statsPeriod")).toBe("14d");

            return HttpResponse.json([
              {
                key: "level",
                name: "Level",
                totalValues: 5,
                topValues: [
                  { key: "error", name: "error", value: "error", count: 42 },
                ],
              },
              {
                key: "is",
                name: "Status",
                totalValues: 3,
                topValues: [
                  {
                    key: "unresolved",
                    name: "unresolved",
                    value: "unresolved",
                    count: 15,
                  },
                ],
              },
              {
                key: "sentry:user", // Should be filtered out
                name: "User (Internal)",
                totalValues: 10,
              },
            ]);
          },
        ),
      );

      const result = await discoverDatasetFields(
        apiService,
        "sentry-mcp-evals",
        "search_issues",
        { projectId: "4509062593708032" },
      );

      expect(result.dataset).toBe("search_issues");
      expect(result.fields).toHaveLength(2); // sentry:user should be filtered out
      expect(result.fields[0]?.key).toBe("level");
      expect(result.fields[0]?.name).toBe("Level");
      expect(result.fields[0]?.totalValues).toBe(5);
      expect(result.fields[1]?.key).toBe("is");
      expect(result.commonPatterns).toContainEqual({
        pattern: "is:unresolved",
        description: "Open issues",
      });
    });

    it("should discover fields for events dataset (examples always included)", async () => {
      // Mock the tags API response for events
      mswServer.use(
        http.get(
          "https://sentry.io/api/0/organizations/sentry-mcp-evals/tags/",
          ({ request }) => {
            const url = new URL(request.url);
            expect(url.searchParams.get("dataset")).toBe("events");

            return HttpResponse.json([
              {
                key: "http.method",
                name: "HTTP Method",
                totalValues: 4,
              },
              {
                key: "environment",
                name: "Environment",
                totalValues: 3,
              },
            ]);
          },
        ),
      );

      const result = await discoverDatasetFields(
        apiService,
        "sentry-mcp-evals",
        "events",
        { projectId: "4509062593708032" },
      );

      expect(result.dataset).toBe("events");
      expect(result.fields).toHaveLength(2);
      expect(result.fields[0]?.key).toBe("http.method");
      expect(result.fields[0]?.examples).toEqual([
        "GET",
        "POST",
        "PUT",
        "DELETE",
      ]);
      expect(result.fields[1]?.key).toBe("environment");
      expect(result.fields[1]?.examples).toEqual([
        "production",
        "staging",
        "development",
      ]);
      expect(result.commonPatterns).toContainEqual({
        pattern: "level:error",
        description: "Error events",
      });
    });

    it("only returns replay fields and patterns reported by the tags api", async () => {
      mswServer.use(
        http.get(
          "https://sentry.io/api/0/organizations/sentry-mcp-evals/tags/",
          ({ request }) => {
            const url = new URL(request.url);
            expect(url.searchParams.get("dataset")).toBe("replays");

            return HttpResponse.json([
              {
                key: "count_screens",
                name: "Count Screens",
                totalValues: 7,
              },
              {
                key: "click.textContent",
                name: "Click Text Content",
                totalValues: 4,
              },
              {
                key: "viewed_by_me",
                name: "Viewed By Me",
                totalValues: 2,
              },
              {
                key: "user.segment",
                name: "User Segment",
                totalValues: 12,
              },
              {
                key: "browser",
                name: "Browser",
                totalValues: 4,
              },
              {
                key: "sentry:user",
                name: "Internal User",
                totalValues: 1,
              },
            ]);
          },
        ),
      );

      const result = await discoverDatasetFields(
        apiService,
        "sentry-mcp-evals",
        "replays",
      );

      const fields = new Map(result.fields.map((field) => [field.key, field]));

      expect(fields.get("count_screens")).toMatchObject({
        key: "count_screens",
        name: "Count Screens",
        totalValues: 7,
        examples: ["1", "3", "8"],
      });
      expect(fields.get("click.textContent")).toMatchObject({
        key: "click.textContent",
        name: "Click Text Content",
        totalValues: 4,
        examples: ["Save", "Complete Purchase"],
      });
      expect(fields.get("viewed_by_me")).toMatchObject({
        key: "viewed_by_me",
        totalValues: 2,
      });
      expect(fields.get("user.segment")).toMatchObject({
        key: "user.segment",
        name: "User Segment",
        totalValues: 12,
      });
      expect(fields.has("tap.message")).toBe(false);
      expect(fields.has("ota_updates.channel")).toBe(false);
      expect(fields.has("browser")).toBe(false);
      expect(fields.has("sentry:user")).toBe(false);
      expect(result.commonPatterns).toContainEqual({
        pattern: 'click.textContent:"Save"',
        description: "Replays where a Save button was clicked",
      });
      expect(result.commonPatterns).toContainEqual({
        pattern: "viewed_by_me:true",
        description: "Replays you have already viewed",
      });
      expect(result.commonPatterns).not.toContainEqual({
        pattern: "tap.message:*Checkout*",
        description: "Mobile replay screens related to checkout",
      });
      expect(result.commonPatterns).not.toContainEqual({
        pattern: "count_errors:>0",
        description: "Replays with associated errors",
      });
    });

    it("should handle API errors gracefully", async () => {
      // Mock API error
      mswServer.use(
        http.get(
          "https://sentry.io/api/0/organizations/sentry-mcp-evals/tags/",
          () =>
            HttpResponse.json(
              { detail: "Organization not found" },
              { status: 404 },
            ),
        ),
      );

      await expect(
        discoverDatasetFields(apiService, "sentry-mcp-evals", "errors"),
      ).rejects.toThrow();
    });

    it("should provide appropriate examples for each dataset type", async () => {
      mswServer.use(
        http.get(
          "https://sentry.io/api/0/organizations/sentry-mcp-evals/tags/",
          () =>
            HttpResponse.json([
              {
                key: "assigned_or_suggested",
                name: "Assigned",
                totalValues: 5,
              },
              { key: "is", name: "Status", totalValues: 3 },
            ]),
        ),
      );

      const issuesResult = await discoverDatasetFields(
        apiService,
        "sentry-mcp-evals",
        "search_issues",
      );

      expect(issuesResult.fields[0]?.examples).toEqual([
        "email@example.com",
        "team-slug",
        "me",
      ]);
      expect(issuesResult.fields[1]?.examples).toEqual([
        "unresolved",
        "resolved",
        "ignored",
        "for_review",
        "new",
        "regressed",
        "escalating",
      ]);

      // Test events examples

      mswServer.use(
        http.get(
          "https://sentry.io/api/0/organizations/sentry-mcp-evals/tags/",
          () =>
            HttpResponse.json([
              { key: "http.method", name: "HTTP Method", totalValues: 4 },
              { key: "db.system", name: "Database System", totalValues: 3 },
            ]),
        ),
      );

      const eventsResult = await discoverDatasetFields(
        apiService,
        "sentry-mcp-evals",
        "events",
      );

      expect(eventsResult.fields[0]?.examples).toEqual([
        "GET",
        "POST",
        "PUT",
        "DELETE",
      ]);
      expect(eventsResult.fields[1]?.examples).toEqual([
        "postgresql",
        "mysql",
        "redis",
      ]);
    });

    it("should provide correct common patterns for different datasets", async () => {
      // Mock minimal API response
      mswServer.use(
        http.get(
          "https://sentry.io/api/0/organizations/sentry-mcp-evals/tags/",
          () => HttpResponse.json([]),
        ),
      );

      // Test patterns are returned correctly for each dataset type
      const issuesResult = await discoverDatasetFields(
        apiService,
        "sentry-mcp-evals",
        "search_issues",
      );
      expect(issuesResult.commonPatterns).toEqual(
        expect.arrayContaining([
          { pattern: "is:unresolved", description: "Open issues" },
          {
            pattern: "firstSeen:-24h",
            description: "New issues from last 24 hours",
          },
        ]),
      );

      const eventsResult = await discoverDatasetFields(
        apiService,
        "sentry-mcp-evals",
        "events",
      );
      expect(eventsResult.commonPatterns).toEqual(
        expect.arrayContaining([
          { pattern: "level:error", description: "Error events" },
          { pattern: "has:http.method", description: "HTTP requests" },
        ]),
      );

      const replaysResult = await discoverDatasetFields(
        apiService,
        "sentry-mcp-evals",
        "replays",
      );

      expect(replaysResult.commonPatterns).toEqual([]);

      mswServer.use(
        http.get(
          "https://sentry.io/api/0/organizations/sentry-mcp-evals/tags/",
          () =>
            HttpResponse.json([
              {
                key: "count_errors",
                name: "Count Errors",
                totalValues: 5,
              },
              {
                key: "viewed_by_me",
                name: "Viewed By Me",
                totalValues: 2,
              },
            ]),
        ),
      );

      const replayResultWithIndexedFields = await discoverDatasetFields(
        apiService,
        "sentry-mcp-evals",
        "replays",
      );

      expect(replayResultWithIndexedFields.commonPatterns).toEqual(
        expect.arrayContaining([
          {
            pattern: "count_errors:>0",
            description: "Replays with associated errors",
          },
          {
            pattern: "viewed_by_me:true",
            description: "Replays you have already viewed",
          },
        ]),
      );
    });
  });

  describe("getFieldExamples", () => {
    it("should return examples for search_issues fields", () => {
      expect(
        getFieldExamples("assigned_or_suggested", "search_issues"),
      ).toEqual(["email@example.com", "team-slug", "me"]);
      expect(getFieldExamples("is", "search_issues")).toEqual([
        "unresolved",
        "resolved",
        "ignored",
        "for_review",
        "new",
        "regressed",
        "escalating",
      ]);
    });

    it("should return examples for events fields", () => {
      expect(getFieldExamples("http.method", "events")).toEqual([
        "GET",
        "POST",
        "PUT",
        "DELETE",
      ]);
      expect(getFieldExamples("db.system", "events")).toEqual([
        "postgresql",
        "mysql",
        "redis",
      ]);
    });

    it("should return common examples for unknown fields", () => {
      expect(getFieldExamples("level", "search_issues")).toEqual([
        "error",
        "warning",
        "info",
        "debug",
        "fatal",
      ]);
      expect(getFieldExamples("count_errors", "replays")).toEqual([
        "0",
        "1",
        "5",
      ]);
      expect(getFieldExamples("click.textContent", "replays")).toEqual([
        "Save",
        "Complete Purchase",
      ]);
      expect(getFieldExamples("unknown", "search_issues")).toBeUndefined();
    });
  });

  describe("getCommonPatterns", () => {
    it("should return patterns for search_issues", () => {
      const patterns = getCommonPatterns("search_issues");
      expect(patterns).toContainEqual({
        pattern: "is:unresolved",
        description: "Open issues",
      });
      expect(patterns).toContainEqual({
        pattern: "firstSeen:-24h",
        description: "New issues from last 24 hours",
      });
    });

    it("should return patterns for events", () => {
      const patterns = getCommonPatterns("events");
      expect(patterns).toContainEqual({
        pattern: "level:error",
        description: "Error events",
      });
      expect(patterns).toContainEqual({
        pattern: "has:http.method",
        description: "HTTP requests",
      });
    });

    it("should return patterns for replays", () => {
      const patterns = getCommonPatterns("replays");
      expect(patterns).toContainEqual({
        pattern: "count_rage_clicks:>0",
        description: "Replays with rage clicks",
      });
      expect(patterns).toContainEqual({
        pattern: "url:*checkout*",
        description: "Replays that visited a checkout page",
      });
      expect(patterns).toContainEqual({
        pattern: 'click.textContent:"Save"',
        description: "Replays where a Save button was clicked",
      });
    });

    it("should return empty array for unknown datasets", () => {
      const patterns = getCommonPatterns("unknown");
      expect(patterns).toEqual([]);
    });
  });
});
