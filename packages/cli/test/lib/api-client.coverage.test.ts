/**
 * API Client Coverage Tests
 *
 * Comprehensive tests for all domain modules under src/lib/api/ to
 * reach 80%+ line coverage on each module. Follows the same mock
 * pattern as api-client.seer.test.ts.
 */

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as Sentry from "@sentry/node-core/light";
import { number, object, string } from "valibot";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resolveEventInOrg } from "../../src/lib/api/events.js";
import { unwrapResult } from "../../src/lib/api/infrastructure.js";
import {
  API_MAX_PER_PAGE,
  addMemberToTeam,
  apiRequest,
  apiRequestToRegion,
  createProject,
  createProjectWithAutoTeam,
  createTeam,
  getCurrentUser,
  getDetailedTrace,
  getEvent,
  getIssue,
  getIssueByShortId,
  getIssueInOrg,
  getLatestEvent,
  getLogs,
  getProjectKeys,
  listEventAttachments,
  listIssuesAllPages,
  listLogs,
  listProjects,
  listProjectsAllPages,
  listProjectsPaginated,
  listProjectTeams,
  listRepositories,
  listRepositoriesPaginated,
  listTeams,
  listTeamsPaginated,
  listTraceLogs,
  listTransactions,
  MEMBER_PROJECT_CREATION_DISABLED_DETAIL,
  rawApiRequest,
  tryGetPrimaryDsn,
  updateIssueStatus,
} from "../../src/lib/api-client.js";
import { setAuthToken } from "../../src/lib/db/auth.js";
import { setOrgRegion } from "../../src/lib/db/regions.js";
import { ApiError, AuthError } from "../../src/lib/errors.js";
import { mockFetch, useTestConfigDir } from "../helpers.js";

// --- Shared test setup ---

useTestConfigDir("test-api-coverage-");
let originalFetch: typeof globalThis.fetch;

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  await setAuthToken("test-token");
  setOrgRegion("test-org", "https://sentry.io");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// --- Helpers ---

/** Build a mock issue response */
function mockIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "12345",
    shortId: "TEST-1",
    title: "Test Issue",
    status: "unresolved",
    level: "error",
    permalink: "https://sentry.io/organizations/test-org/issues/12345/",
    ...overrides,
  };
}

/** Build a mock project response */
function mockProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "1",
    slug: "test-project",
    name: "Test Project",
    ...overrides,
  };
}

/** Build a mock team response */
function mockTeam(overrides: Record<string, unknown> = {}) {
  return {
    id: "1",
    slug: "test-team",
    name: "Test Team",
    ...overrides,
  };
}

/** Create a Link header for pagination */
function linkHeader(cursor: string, hasResults: boolean): string {
  return `<https://sentry.io/api/0/next/>; rel="next"; results="${hasResults}"; cursor="${cursor}"`;
}

// =============================================================================
// issues.ts
// =============================================================================

describe("issues.ts", () => {
  describe("getIssue", () => {
    test("fetches issue by numeric ID via legacy endpoint", async () => {
      const issue = mockIssue();
      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        expect(req.url).toContain("/api/0/issues/12345/");
        return new Response(JSON.stringify(issue), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const result = await getIssue("12345");
      expect(result.id).toBe("12345");
      expect(result.title).toBe("Test Issue");
    });

    test("passes collapse query params when provided", async () => {
      const issue = mockIssue();
      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        const url = new URL(req.url);
        expect(url.searchParams.getAll("collapse")).toEqual([
          "stats",
          "lifetime",
        ]);
        return new Response(JSON.stringify(issue), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      await getIssue("12345", { collapse: ["stats", "lifetime"] });
    });
  });

  describe("getIssueInOrg", () => {
    test("fetches issue scoped to organization", async () => {
      const issue = mockIssue();
      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        expect(req.url).toContain("/organizations/test-org/issues/12345/");
        return new Response(JSON.stringify(issue), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const result = await getIssueInOrg("test-org", "12345");
      expect(result.id).toBe("12345");
    });

    test("passes collapse query params when provided", async () => {
      const issue = mockIssue();
      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        const url = new URL(req.url);
        expect(url.pathname).toContain("/organizations/test-org/issues/12345/");
        expect(url.searchParams.getAll("collapse")).toEqual([
          "stats",
          "filtered",
        ]);
        return new Response(JSON.stringify(issue), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      await getIssueInOrg("test-org", "12345", {
        collapse: ["stats", "filtered"],
      });
    });
  });

  describe("getIssueByShortId", () => {
    test("resolves short ID to issue (uppercases input)", async () => {
      const issue = mockIssue({ shortId: "TEST-1" });
      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        expect(req.url).toContain("/shortids/TEST-1/");
        return new Response(JSON.stringify({ group: issue }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const result = await getIssueByShortId("test-org", "test-1");
      expect(result.shortId).toBe("TEST-1");
    });

    test("passes collapse query params when provided", async () => {
      const issue = mockIssue({ shortId: "TEST-1" });
      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        const url = new URL(req.url);
        expect(url.pathname).toContain("/shortids/TEST-1/");
        expect(url.searchParams.getAll("collapse")).toEqual([
          "stats",
          "lifetime",
          "filtered",
          "unhandled",
        ]);
        return new Response(JSON.stringify({ group: issue }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      await getIssueByShortId("test-org", "test-1", {
        collapse: ["stats", "lifetime", "filtered", "unhandled"],
      });
    });

    test("throws ApiError 404 when group is missing", async () => {
      globalThis.fetch = mockFetch(
        async () =>
          new Response(JSON.stringify({}), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
      );

      try {
        await getIssueByShortId("test-org", "test-1");
        expect(true).toBe(false); // Should not reach
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(404);
      }
    });

    test("enriches 404 errors with actionable hints", async () => {
      globalThis.fetch = mockFetch(
        async () =>
          new Response(JSON.stringify({ detail: "Not Found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          })
      );

      try {
        await getIssueByShortId("test-org", "CLI-G5");
        expect(true).toBe(false); // Should not reach
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        const apiErr = error as ApiError;
        expect(apiErr.status).toBe(404);
        expect(apiErr.message).toContain("CLI-G5");
        expect(apiErr.message).toContain("test-org");
      }
    });
  });

  describe("updateIssueStatus", () => {
    test("sends PUT request with status body", async () => {
      const issue = mockIssue({ status: "resolved" });
      let capturedBody: unknown;

      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        capturedBody = await req.json();
        expect(req.method).toBe("PUT");
        expect(req.url).toContain("/api/0/issues/12345/");
        return new Response(JSON.stringify(issue), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const result = await updateIssueStatus("12345", "resolved");
      expect(result.status).toBe("resolved");
      expect(capturedBody).toEqual({ status: "resolved" });
    });
  });

  describe("listIssuesAllPages", () => {
    test("returns single page when limit <= page size", async () => {
      const issues = [mockIssue({ id: "1" }), mockIssue({ id: "2" })];

      globalThis.fetch = mockFetch(
        async () =>
          new Response(JSON.stringify(issues), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              Link: linkHeader("cursor-abc", false),
            },
          })
      );

      const result = await listIssuesAllPages("test-org", "test-project", {
        limit: 10,
      });
      expect(result.issues).toHaveLength(2);
      // No more pages → nextCursor should be undefined
      expect(result.nextCursor).toBeUndefined();
    });

    test("follows cursor across multiple pages", async () => {
      let callCount = 0;

      globalThis.fetch = mockFetch(async (input, init) => {
        callCount += 1;
        const req = new Request(input!, init);
        const url = new URL(req.url);

        if (callCount === 1) {
          // First page: return items with cursor
          return new Response(
            JSON.stringify([mockIssue({ id: "1" }), mockIssue({ id: "2" })]),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                Link: linkHeader("page2-cursor", true),
              },
            }
          );
        }
        // Second page: return items without cursor
        expect(url.searchParams.get("cursor")).toBe("page2-cursor");
        return new Response(JSON.stringify([mockIssue({ id: "3" })]), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            Link: linkHeader("end", false),
          },
        });
      });

      const result = await listIssuesAllPages("test-org", "test-project", {
        limit: 200,
      });
      expect(result.issues).toHaveLength(3);
      expect(callCount).toBe(2);
    });

    test("trims when overshooting limit (no nextCursor)", async () => {
      // Return 5 items but we only want 3
      globalThis.fetch = mockFetch(
        async () =>
          new Response(
            JSON.stringify([
              mockIssue({ id: "1" }),
              mockIssue({ id: "2" }),
              mockIssue({ id: "3" }),
              mockIssue({ id: "4" }),
              mockIssue({ id: "5" }),
            ]),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                Link: linkHeader("next", true),
              },
            }
          )
      );

      const result = await listIssuesAllPages("test-org", "test-project", {
        limit: 3,
      });
      expect(result.issues).toHaveLength(3);
      // Trimmed — no nextCursor to prevent skipping
      expect(result.nextCursor).toBeUndefined();
    });

    test("throws when limit < 1", async () => {
      await expect(
        listIssuesAllPages("test-org", "test-project", { limit: 0 })
      ).rejects.toThrow("limit must be at least 1");
    });

    test("calls onPage callback after each page", async () => {
      const onPageCalls: [number, number][] = [];

      globalThis.fetch = mockFetch(
        async () =>
          new Response(
            JSON.stringify([mockIssue({ id: "1" }), mockIssue({ id: "2" })]),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                Link: linkHeader("end", false),
              },
            }
          )
      );

      await listIssuesAllPages("test-org", "test-project", {
        limit: 10,
        onPage: (fetched, limit) => {
          onPageCalls.push([fetched, limit]);
        },
      });

      expect(onPageCalls).toHaveLength(1);
      expect(onPageCalls[0]).toEqual([2, 10]);
    });

    test("returns nextCursor when last page has more results but limit reached", async () => {
      // Return exactly limit items with a next cursor
      globalThis.fetch = mockFetch(
        async () =>
          new Response(
            JSON.stringify([mockIssue({ id: "1" }), mockIssue({ id: "2" })]),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                Link: linkHeader("has-more", true),
              },
            }
          )
      );

      const result = await listIssuesAllPages("test-org", "test-project", {
        limit: 2,
      });
      expect(result.issues).toHaveLength(2);
      // Exactly at limit with more pages → keep nextCursor
      expect(result.nextCursor).toBe("has-more");
    });

    test("uses the remaining limit on the final page and preserves its cursor", async () => {
      const requestedLimits: string[] = [];
      let callCount = 0;

      globalThis.fetch = mockFetch(async (input, init) => {
        callCount += 1;
        const req = new Request(input!, init);
        const url = new URL(req.url);
        requestedLimits.push(url.searchParams.get("limit") ?? "");
        const count = callCount === 3 ? 50 : 100;
        const issues = Array.from({ length: count }, (_, index) =>
          mockIssue({ id: `${callCount}-${index}` })
        );
        return new Response(JSON.stringify(issues), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            Link: linkHeader(`cursor-${callCount + 1}`, true),
          },
        });
      });

      const result = await listIssuesAllPages("test-org", "test-project", {
        limit: 250,
      });

      expect(result.issues).toHaveLength(250);
      expect(requestedLimits).toEqual(["100", "100", "50"]);
      expect(result.nextCursor).toBe("cursor-4");
    });

    test("accepts startCursor option", async () => {
      let capturedUrl = "";

      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        capturedUrl = req.url;
        return new Response(JSON.stringify([mockIssue({ id: "1" })]), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        });
      });

      await listIssuesAllPages("test-org", "test-project", {
        limit: 10,
        startCursor: "start-here",
      });
      expect(capturedUrl).toContain("cursor=start-here");
    });
  });
});

// =============================================================================
// teams.ts
// =============================================================================

describe("teams.ts", () => {
  describe("listTeams", () => {
    test("lists teams in organization", async () => {
      const teams = [mockTeam({ id: "1" }), mockTeam({ id: "2" })];

      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        expect(req.url).toContain("/organizations/test-org/teams/");
        return new Response(JSON.stringify(teams), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const result = await listTeams("test-org");
      expect(result).toHaveLength(2);
    });
  });

  describe("listProjectTeams", () => {
    test("lists teams for a specific project", async () => {
      const teams = [mockTeam()];

      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        expect(req.url).toContain("/projects/test-org/test-project/teams/");
        return new Response(JSON.stringify(teams), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const result = await listProjectTeams("test-org", "test-project");
      expect(result).toHaveLength(1);
      expect(result[0]!.slug).toBe("test-team");
    });
  });

  describe("createTeam", () => {
    test("creates team and adds current user as member", async () => {
      const team = mockTeam({ slug: "new-team" });
      const requestUrls: string[] = [];

      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        requestUrls.push(req.url);

        if (
          req.method === "POST" &&
          req.url.includes("/organizations/test-org/teams/")
        ) {
          return new Response(JSON.stringify(team), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (req.url.includes("/member")) {
          return new Response(JSON.stringify({}), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not found", { status: 404 });
      });

      const result = await createTeam("test-org", "new-team");
      expect(result.slug).toBe("new-team");
      // Should have made at least 2 calls (create + add member)
      expect(requestUrls.length).toBeGreaterThanOrEqual(2);
    });

    test("returns team even when member-add fails", async () => {
      const team = mockTeam({ slug: "new-team" });

      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);

        if (
          req.method === "POST" &&
          req.url.includes("/organizations/test-org/teams/")
        ) {
          return new Response(JSON.stringify(team), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          });
        }
        // addMemberToTeam fails
        return new Response(JSON.stringify({ detail: "Permission denied" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      });

      const result = await createTeam("test-org", "new-team");
      expect(result.slug).toBe("new-team");
    });
  });

  describe("addMemberToTeam", () => {
    test("adds member to team", async () => {
      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        expect(req.url).toContain("/members/me/teams/test-team/");
        expect(req.method).toBe("POST");
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      // Should not throw
      await addMemberToTeam("test-org", "test-team", "me");
    });
  });
});

// =============================================================================
// projects.ts
// =============================================================================

describe("projects.ts", () => {
  describe("listProjects", () => {
    test("returns all projects from single page", async () => {
      const projects = [mockProject({ id: "1" }), mockProject({ id: "2" })];

      globalThis.fetch = mockFetch(
        async () =>
          new Response(JSON.stringify(projects), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          })
      );

      const result = await listProjects("test-org");
      expect(result).toHaveLength(2);
    });

    test("auto-paginates through multiple pages", async () => {
      let callCount = 0;

      globalThis.fetch = mockFetch(async () => {
        callCount += 1;
        if (callCount === 1) {
          return new Response(JSON.stringify([mockProject({ id: "1" })]), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              Link: linkHeader("page2", true),
            },
          });
        }
        return new Response(JSON.stringify([mockProject({ id: "2" })]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const result = await listProjects("test-org");
      expect(result).toHaveLength(2);
      expect(callCount).toBe(2);
    });
  });

  describe("listProjectsPaginated", () => {
    test("returns single page with pagination metadata", async () => {
      const projects = [mockProject()];

      globalThis.fetch = mockFetch(
        async () =>
          new Response(JSON.stringify(projects), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              Link: linkHeader("next-cursor", true),
            },
          })
      );

      const result = await listProjectsPaginated("test-org");
      expect(result.data).toHaveLength(1);
      expect(result.nextCursor).toBe("next-cursor");
    });

    test("passes cursor and perPage options", async () => {
      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        const url = new URL(req.url);
        expect(url.searchParams.get("cursor")).toBe("my-cursor");
        expect(url.searchParams.get("per_page")).toBe("50");
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      await listProjectsPaginated("test-org", {
        cursor: "my-cursor",
        perPage: 50,
      });
    });

    test("caps perPage at API_MAX_PER_PAGE", async () => {
      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        const url = new URL(req.url);
        expect(url.searchParams.get("per_page")).toBe(String(API_MAX_PER_PAGE));
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      await listProjectsPaginated("test-org", { perPage: 500 });
    });
  });

  describe("listProjectsAllPages", () => {
    test("auto-paginates when limit exceeds API_MAX_PER_PAGE", async () => {
      const perPageValues: number[] = [];
      let callCount = 0;

      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        const url = new URL(req.url);
        const perPage = Number(url.searchParams.get("per_page"));
        perPageValues.push(perPage);
        callCount += 1;

        const page = Array.from({ length: API_MAX_PER_PAGE }, (_, i) =>
          mockProject({
            id: String((callCount - 1) * API_MAX_PER_PAGE + i + 1),
            slug: `proj-${(callCount - 1) * API_MAX_PER_PAGE + i}`,
          })
        );

        const hasMore = callCount === 1;
        return new Response(JSON.stringify(page), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            Link: linkHeader("page2", hasMore),
          },
        });
      });

      const result = await listProjectsAllPages("test-org", { limit: 200 });
      expect(result.data).toHaveLength(200);
      expect(callCount).toBe(2);
      expect(perPageValues).toEqual([API_MAX_PER_PAGE, API_MAX_PER_PAGE]);
      expect(result.nextCursor).toBeUndefined();
    });

    test("single request when limit fits in one API page", async () => {
      let callCount = 0;
      globalThis.fetch = mockFetch(async (input, init) => {
        callCount += 1;
        const req = new Request(input!, init);
        const url = new URL(req.url);
        expect(url.searchParams.get("per_page")).toBe("25");
        return new Response(JSON.stringify([mockProject()]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const result = await listProjectsAllPages("test-org", { limit: 25 });
      expect(result.data).toHaveLength(1);
      expect(callCount).toBe(1);
    });
  });

  describe("createProject", () => {
    test("creates project under team", async () => {
      const project = mockProject({ slug: "new-project" });

      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        expect(req.url).toContain("/teams/test-org/test-team/projects/");
        expect(req.method).toBe("POST");
        return new Response(JSON.stringify(project), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      });

      const result = await createProject("test-org", "test-team", {
        name: "New Project",
      });
      expect(result.slug).toBe("new-project");
    });
  });

  describe("createProjectWithAutoTeam", () => {
    const autoTeamProject = {
      id: "99",
      slug: "auto-proj",
      name: "Auto Project",
      platform: "node",
      dateCreated: "2026-01-01T00:00:00Z",
      team_slug: "team-testuser",
    };
    const dsnKeys = [
      {
        id: "k1",
        isActive: true,
        dsn: { public: "https://key@o1.ingest.sentry.io/99", secret: "" },
      },
    ];

    test("POSTs to /organizations/{org}/projects/ and returns project with DSN and team_slug", async () => {
      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        if (req.url.includes("/projects/") && req.method === "POST") {
          return new Response(JSON.stringify(autoTeamProject), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          });
        }
        // DSN key fetch
        return new Response(JSON.stringify(dsnKeys), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const result = await createProjectWithAutoTeam("test-org", {
        name: "Auto Project",
      });
      expect(result.project.slug).toBe("auto-proj");
      expect(result.team_slug).toBe("team-testuser");
      expect(result.dsn).toContain("key");
      expect(result.url).toContain("auto-proj");
    });

    test("propagates 403 when org has disabled member project creation", async () => {
      globalThis.fetch = mockFetch(
        async () =>
          new Response(
            JSON.stringify({ detail: MEMBER_PROJECT_CREATION_DISABLED_DETAIL }),
            { status: 403, headers: { "Content-Type": "application/json" } }
          )
      );

      await expect(
        createProjectWithAutoTeam("test-org", { name: "Blocked" })
      ).rejects.toMatchObject({ status: 403 });
    });

    test("returns dsn:null when DSN fetch fails", async () => {
      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        if (req.method === "POST") {
          return new Response(JSON.stringify(autoTeamProject), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const result = await createProjectWithAutoTeam("test-org", {
        name: "Auto Project",
      });
      expect(result.dsn).toBeNull();
    });
  });

  describe("getProjectKeys", () => {
    test("returns project client keys", async () => {
      const keys = [
        {
          id: "key-1",
          name: "Default",
          isActive: true,
          dsn: { public: "https://abc@sentry.io/1", secret: "secret" },
        },
      ];

      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        expect(req.url).toContain("/projects/test-org/test-project/keys/");
        expect(new URL(req.url).searchParams.get("status")).toBe("active");
        return new Response(JSON.stringify(keys), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const result = await getProjectKeys("test-org", "test-project", {
        status: "active",
      });
      expect(result).toHaveLength(1);
      expect(result[0]!.dsn.public).toBe("https://abc@sentry.io/1");
    });
  });

  describe("tryGetPrimaryDsn", () => {
    test("returns DSN of first active key", async () => {
      const keys = [
        {
          id: "key-1",
          name: "Default",
          isActive: true,
          dsn: { public: "https://abc@sentry.io/1", secret: "s" },
        },
        {
          id: "key-2",
          name: "Other",
          isActive: false,
          dsn: { public: "https://def@sentry.io/2", secret: "s" },
        },
      ];

      globalThis.fetch = mockFetch(
        async () =>
          new Response(JSON.stringify(keys), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
      );

      const dsn = await tryGetPrimaryDsn("test-org", "test-project");
      expect(dsn).toBe("https://abc@sentry.io/1");
    });

    test("returns first key DSN when no active key", async () => {
      const keys = [
        {
          id: "key-1",
          name: "Default",
          isActive: false,
          dsn: { public: "https://abc@sentry.io/1", secret: "s" },
        },
      ];

      globalThis.fetch = mockFetch(
        async () =>
          new Response(JSON.stringify(keys), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
      );

      const dsn = await tryGetPrimaryDsn("test-org", "test-project");
      expect(dsn).toBe("https://abc@sentry.io/1");
    });

    test("returns null when no keys", async () => {
      globalThis.fetch = mockFetch(
        async () =>
          new Response(JSON.stringify([]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
      );

      const dsn = await tryGetPrimaryDsn("test-org", "test-project");
      expect(dsn).toBeNull();
    });

    test("returns null on API error", async () => {
      globalThis.fetch = mockFetch(
        async () =>
          new Response(JSON.stringify({ detail: "Not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          })
      );

      const captureSpy = vi.spyOn(Sentry, "captureException");
      try {
        const dsn = await tryGetPrimaryDsn("test-org", "test-project");
        expect(dsn).toBeNull();
        // 404 is expected user/API noise — silenced, not an issue.
        expect(captureSpy).not.toHaveBeenCalled();
      } finally {
        captureSpy.mockRestore();
      }
    });

    test("reports unexpected DSN fetch failures to Sentry", async () => {
      globalThis.fetch = mockFetch(
        async () =>
          new Response(JSON.stringify({ detail: "Internal error" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          })
      );

      const captureSpy = vi.spyOn(Sentry, "captureException");
      const withScopeSpy = vi.spyOn(Sentry, "withScope");
      withScopeSpy.mockImplementation((fn: (scope: unknown) => void) => {
        fn({
          setTag() {
            /* noop */
          },
          setContext() {
            /* noop */
          },
          setFingerprint() {
            /* noop */
          },
        });
      });
      try {
        const dsn = await tryGetPrimaryDsn("test-org", "test-project");
        expect(dsn).toBeNull();
        expect(captureSpy).toHaveBeenCalledTimes(1);
      } finally {
        captureSpy.mockRestore();
        withScopeSpy.mockRestore();
      }
    });
  });
});

// =============================================================================
// users.ts
// =============================================================================

describe("users.ts", () => {
  describe("getCurrentUser", () => {
    test("fetches authenticated user from /auth/ endpoint", async () => {
      const user = {
        id: "123",
        name: "Test User",
        email: "test@example.com",
        username: "testuser",
      };

      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        expect(req.url).toContain("/api/0/auth/");
        return new Response(JSON.stringify(user), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const result = await getCurrentUser();
      expect(result.id).toBe("123");
      expect(result.name).toBe("Test User");
      expect(result.email).toBe("test@example.com");
    });

    test("validates against SentryUserSchema (rejects invalid)", async () => {
      // Missing required "id" field
      globalThis.fetch = mockFetch(
        async () =>
          new Response(JSON.stringify({ name: "no-id" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
      );

      await expect(getCurrentUser()).rejects.toThrow(ApiError);
    });
  });
});

// =============================================================================
// events.ts
// =============================================================================

describe("events.ts", () => {
  describe("getLatestEvent", () => {
    test("fetches latest event for an issue", async () => {
      const event = { eventID: "evt-abc", title: "Error" };

      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        expect(req.url).toContain("/organizations/test-org/issues/");
        expect(req.url).toContain("/events/latest/");
        return new Response(JSON.stringify(event), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const result = await getLatestEvent("test-org", "12345");
      expect(result.eventID).toBe("evt-abc");
    });
  });

  describe("getEvent", () => {
    test("fetches specific event by ID", async () => {
      const event = { eventID: "evt-abc" };

      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        expect(req.url).toContain(
          "/projects/test-org/test-project/events/evt-abc/"
        );
        return new Response(JSON.stringify(event), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const result = await getEvent("test-org", "test-project", "evt-abc");
      expect(result.eventID).toBe("evt-abc");
    });
  });

  describe("listEventAttachments", () => {
    test("returns attachment metadata from every API page", async () => {
      let requestCount = 0;
      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        const url = new URL(req.url);
        expect(url.pathname).toContain(
          "/projects/test-org/test-project/events/evt-abc/attachments/"
        );
        expect(url.searchParams.get("per_page")).toBe("100");

        requestCount += 1;
        const firstPage = url.searchParams.get("cursor") === null;
        if (firstPage) {
          return new Response(
            JSON.stringify([{ id: "attachment-1", name: "first.png" }]),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                Link: linkHeader("attachments-next", true),
              },
            }
          );
        }

        expect(url.searchParams.get("cursor")).toBe("attachments-next");
        return new Response(
          JSON.stringify([{ id: "attachment-2", name: "second.png" }]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      });

      const result = await listEventAttachments(
        "test-org",
        "test-project",
        "evt-abc"
      );

      expect(result.map((attachment) => attachment.id)).toEqual([
        "attachment-1",
        "attachment-2",
      ]);
      expect(requestCount).toBe(2);
    });
  });

  describe("resolveEventInOrg", () => {
    test("returns resolved event on success", async () => {
      const resolved = {
        organizationSlug: "test-org",
        projectSlug: "test-project",
        event: { eventID: "evt-abc" },
      };

      globalThis.fetch = mockFetch(
        async () =>
          new Response(JSON.stringify(resolved), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
      );

      const result = await resolveEventInOrg("test-org", "evt-abc");
      expect(result).not.toBeNull();
      expect(result!.org).toBe("test-org");
      expect(result!.project).toBe("test-project");
    });

    test("returns null on 404", async () => {
      globalThis.fetch = mockFetch(
        async () =>
          new Response(JSON.stringify({ detail: "Not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          })
      );

      const result = await resolveEventInOrg("test-org", "evt-abc");
      expect(result).toBeNull();
    });

    test("re-throws non-404 errors", async () => {
      globalThis.fetch = mockFetch(
        async () =>
          new Response(JSON.stringify({ detail: "Internal Server Error" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          })
      );

      await expect(resolveEventInOrg("test-org", "evt-abc")).rejects.toThrow();
    });
  });
});

// =============================================================================
// traces.ts
// =============================================================================

describe("traces.ts", () => {
  describe("getDetailedTrace", () => {
    test("fetches trace with correct params", async () => {
      const spans = [
        {
          span_id: "span-1",
          start_timestamp: 1_700_000_000,
          timestamp: 1_700_000_001,
        },
      ];

      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        expect(req.url).toContain(
          "/organizations/test-org/trace/abc123def456/"
        );
        const url = new URL(req.url);
        expect(url.searchParams.get("timestamp")).toBe("1700000000");
        expect(url.searchParams.get("limit")).toBe("10000");
        expect(url.searchParams.get("project")).toBe("-1");
        return new Response(JSON.stringify(spans), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const result = await getDetailedTrace("test-org", "abc123def456", {
        timestamp: 1_700_000_000,
      });
      expect(result).toHaveLength(1);
      expect(result[0]!.span_id).toBe("span-1");
    });
  });
});

// =============================================================================
// repositories.ts
// =============================================================================

describe("repositories.ts", () => {
  describe("listRepositories", () => {
    test("lists repositories in organization", async () => {
      const repos = [
        {
          id: "1",
          name: "getsentry/sentry",
          url: "https://github.com/getsentry/sentry",
          provider: { id: "github", name: "GitHub" },
          status: "active",
        },
      ];

      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        expect(req.url).toContain("/organizations/test-org/repos/");
        return new Response(JSON.stringify(repos), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const result = await listRepositories("test-org");
      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe("getsentry/sentry");
    });
  });

  describe("listAllRepositories", () => {
    test("walks pagination and concatenates pages", async () => {
      const pages: Array<Array<{ id: string; name: string }>> = [
        [
          { id: "1", name: "owner/repo-a" },
          { id: "2", name: "owner/repo-b" },
        ],
        [{ id: "3", name: "owner/repo-c" }],
      ];
      let callIdx = 0;

      globalThis.fetch = mockFetch(async () => {
        const page = pages[callIdx];
        callIdx += 1;
        const hasNext = callIdx < pages.length;
        const fullPage = page?.map((r) => ({
          ...r,
          url: `https://github.com/${r.name}`,
          provider: { id: "github", name: "GitHub" },
          status: "active",
        }));
        return new Response(JSON.stringify(fullPage), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            Link: hasNext
              ? '<https://sentry.io/next>; rel="next"; results="true"; cursor="c1"'
              : '<https://sentry.io/end>; rel="next"; results="false"; cursor=""',
          },
        });
      });

      // Dynamic import to avoid circular issue with already-imported listRepositories
      const { listAllRepositories } = await import(
        "../../src/lib/api/repositories.js"
      );
      const result = await listAllRepositories("test-org");
      expect(result).toHaveLength(3);
      expect(result.map((r) => r.name)).toEqual([
        "owner/repo-a",
        "owner/repo-b",
        "owner/repo-c",
      ]);
      expect(callIdx).toBe(2);
    });
  });
});

// =============================================================================
// logs.ts
// =============================================================================

describe("logs.ts", () => {
  describe("listLogs", () => {
    test("lists logs for a project slug", async () => {
      const logsResponse = {
        data: [
          {
            "sentry.item_id": "log-1",
            timestamp: "2024-01-01T00:00:00Z",
            timestamp_precise: 1_704_067_200_000_000_000,
            message: "Test log",
            severity: "info",
            trace: null,
          },
        ],
        meta: { fields: {} },
      };

      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        expect(req.url).toContain("/organizations/test-org/events/");
        const url = new URL(req.url);
        expect(url.searchParams.get("dataset")).toBe("logs");
        // With a slug, the query should include project:my-project
        expect(url.searchParams.get("query")).toContain("project:my-project");
        return new Response(JSON.stringify(logsResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const result = await listLogs("test-org", "my-project");
      expect(result).toHaveLength(1);
      expect(result[0]!["sentry.item_id"]).toBe("log-1");
    });

    test("uses numeric project ID via project param", async () => {
      const logsResponse = { data: [], meta: { fields: {} } };

      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        const url = new URL(req.url);
        // Numeric ID should be passed as project param, not in query
        expect(url.searchParams.get("project")).toBe("42");
        // No project: filter in query
        const query = url.searchParams.get("query");
        if (query) {
          expect(query).not.toContain("project:");
        }
        return new Response(JSON.stringify(logsResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      await listLogs("test-org", "42");
    });

    test("includes afterTimestamp filter in query", async () => {
      const logsResponse = { data: [], meta: {} };

      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        const url = new URL(req.url);
        const query = url.searchParams.get("query") ?? "";
        expect(query).toContain("timestamp_precise:>1700000000");
        return new Response(JSON.stringify(logsResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      await listLogs("test-org", "my-project", {
        afterTimestamp: 1_700_000_000,
      });
    });

    test("passes custom query and limit", async () => {
      const logsResponse = { data: [], meta: {} };

      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        const url = new URL(req.url);
        const query = url.searchParams.get("query") ?? "";
        expect(query).toContain("severity:error");
        expect(url.searchParams.get("per_page")).toBe("50");
        return new Response(JSON.stringify(logsResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      await listLogs("test-org", "my-project", {
        query: "severity:error",
        limit: 50,
      });
    });
  });
});

// =============================================================================
// infrastructure.ts
// =============================================================================

describe("infrastructure.ts", () => {
  describe("apiRequest", () => {
    test("makes GET request to default base URL", async () => {
      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        expect(req.url).toContain("/api/0/organizations/");
        expect(req.method).toBe("GET");
        return new Response(JSON.stringify([{ slug: "org1" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const result = await apiRequest<{ slug: string }[]>("/organizations/");
      expect(result).toHaveLength(1);
    });
  });

  describe("unwrapResult", () => {
    test("re-throws ApiError directly", () => {
      const apiError = new ApiError("test", 500, "detail");
      expect(() =>
        unwrapResult(
          { data: undefined, error: apiError } as {
            data: undefined;
            error: unknown;
          },
          "context"
        )
      ).toThrow(apiError);
    });

    test("re-throws AuthError directly", () => {
      const authError = new AuthError("expired");
      expect(() =>
        unwrapResult(
          { data: undefined, error: authError } as {
            data: undefined;
            error: unknown;
          },
          "context"
        )
      ).toThrow(authError);
    });

    test("returns data on success", () => {
      const result = unwrapResult(
        { data: { foo: "bar" }, error: undefined } as {
          data: { foo: string };
          error: undefined;
        },
        "context"
      );
      expect(result).toEqual({ foo: "bar" });
    });

    test("wraps unknown errors as ApiError via throwApiError", () => {
      // Create a mock result with a generic error and a response
      const result = {
        data: undefined,
        error: { detail: "Something went wrong" },
        response: new Response("", {
          status: 502,
          statusText: "Bad Gateway",
        }),
      };

      try {
        unwrapResult(
          result as { data: undefined; error: unknown },
          "Failed operation"
        );
        expect(true).toBe(false); // Should not reach
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        const apiErr = error as ApiError;
        expect(apiErr.status).toBe(502);
        expect(apiErr.message).toContain("Failed operation");
      }
    });
  });

  describe("apiRequestToRegion", () => {
    test("parses JSON error detail from non-ok response", async () => {
      globalThis.fetch = mockFetch(
        async () =>
          new Response(JSON.stringify({ detail: "Rate limited" }), {
            status: 429,
            statusText: "Too Many Requests",
            headers: { "Content-Type": "application/json" },
          })
      );

      try {
        await apiRequestToRegion("https://sentry.io", "/test/");
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        const apiErr = error as ApiError;
        expect(apiErr.status).toBe(429);
        expect(apiErr.detail).toBe("Rate limited");
      }
    });

    test("JSON-stringifies error body without detail field", async () => {
      globalThis.fetch = mockFetch(
        async () =>
          new Response(JSON.stringify({ code: "ERR", message: "Oops" }), {
            status: 400,
            statusText: "Bad Request",
            headers: { "Content-Type": "application/json" },
          })
      );

      try {
        await apiRequestToRegion("https://sentry.io", "/test/");
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        const apiErr = error as ApiError;
        expect(apiErr.status).toBe(400);
        // Should be JSON.stringify of the whole response
        expect(apiErr.detail).toContain("ERR");
        expect(apiErr.detail).toContain("Oops");
      }
    });

    test("uses text as detail when response is not JSON", async () => {
      globalThis.fetch = mockFetch(
        async () =>
          new Response("Internal Server Error", {
            status: 500,
            statusText: "Internal Server Error",
          })
      );

      try {
        await apiRequestToRegion("https://sentry.io", "/test/");
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        const apiErr = error as ApiError;
        expect(apiErr.status).toBe(500);
        expect(apiErr.detail).toBe("Internal Server Error");
      }
    });

    test("throws ApiError on schema validation failure", async () => {
      const schema = object({
        required_field: string(),
      });

      globalThis.fetch = mockFetch(
        async () =>
          new Response(JSON.stringify({ wrong_field: "value" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
      );

      try {
        await apiRequestToRegion("https://sentry.io", "/test/", { schema });
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        const apiErr = error as ApiError;
        expect(apiErr.message).toContain("Unexpected response format");
        expect(apiErr.status).toBe(200);
      }
    });

    test("returns validated data when schema passes", async () => {
      const schema = object({
        name: string(),
        count: number(),
      });

      globalThis.fetch = mockFetch(
        async () =>
          new Response(JSON.stringify({ name: "test", count: 42 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
      );

      const { data } = await apiRequestToRegion("https://sentry.io", "/test/", {
        schema,
      });
      expect(data).toEqual({ name: "test", count: 42 });
    });

    test("normalizes endpoint with leading slash", async () => {
      globalThis.fetch = mockFetch(async (input) => {
        const url = String(input instanceof Request ? input.url : input);
        // Should not have double /api/0//
        expect(url).not.toContain("/api/0//");
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      await apiRequestToRegion("https://sentry.io", "/test/");
    });

    test("handles endpoint without leading slash", async () => {
      globalThis.fetch = mockFetch(async (input) => {
        const url = String(input instanceof Request ? input.url : input);
        expect(url).toContain("/api/0/test/");
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      await apiRequestToRegion("https://sentry.io", "test/");
    });

    test("includes query params in URL", async () => {
      globalThis.fetch = mockFetch(async (input) => {
        const url = String(input instanceof Request ? input.url : input);
        expect(url).toContain("foo=bar");
        expect(url).toContain("num=42");
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      await apiRequestToRegion("https://sentry.io", "/test/", {
        params: { foo: "bar", num: 42 },
      });
    });

    test("sends request body as JSON", async () => {
      let capturedBody: unknown;

      globalThis.fetch = mockFetch(async (_input, init) => {
        if (init?.body) {
          capturedBody = JSON.parse(init.body as string);
        }
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      await apiRequestToRegion("https://sentry.io", "/test/", {
        method: "POST",
        body: { key: "value" },
      });
      expect(capturedBody).toEqual({ key: "value" });
    });

    test("falls back to statusText when response.text() throws", async () => {
      globalThis.fetch = mockFetch(async () => {
        // Create a response whose text() method throws
        const response = new Response(null, {
          status: 503,
          statusText: "Service Unavailable",
        });
        // Override text() to throw
        response.text = () => {
          throw new Error("stream error");
        };
        // Mark as not ok
        Object.defineProperty(response, "ok", { value: false });
        return response;
      });

      try {
        await apiRequestToRegion("https://sentry.io", "/test/");
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        const apiErr = error as ApiError;
        expect(apiErr.status).toBe(503);
        expect(apiErr.detail).toBe("Service Unavailable");
      }
    });
  });
});

// =============================================================================
// teams.ts — listTeamsPaginated
// =============================================================================

describe("teams.ts (paginated)", () => {
  describe("listTeamsPaginated", () => {
    test("returns single page with cursor", async () => {
      const teams = [mockTeam({ id: "1" }), mockTeam({ id: "2" })];

      globalThis.fetch = mockFetch(
        async () =>
          new Response(JSON.stringify(teams), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              Link: linkHeader("teams-next", true),
            },
          })
      );

      const result = await listTeamsPaginated("test-org");
      expect(result.data).toHaveLength(2);
      expect(result.nextCursor).toBe("teams-next");
    });

    test("passes cursor and perPage options", async () => {
      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        const url = new URL(req.url);
        expect(url.searchParams.get("cursor")).toBe("my-cursor");
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      await listTeamsPaginated("test-org", {
        cursor: "my-cursor",
        perPage: 50,
      });
    });
  });
});

// =============================================================================
// repositories.ts — listRepositoriesPaginated
// =============================================================================

describe("repositories.ts (paginated)", () => {
  describe("listRepositoriesPaginated", () => {
    test("returns single page with cursor", async () => {
      const repos = [
        {
          id: "1",
          name: "getsentry/sentry",
          url: "https://github.com/getsentry/sentry",
          provider: { id: "github", name: "GitHub" },
          status: "active",
        },
      ];

      globalThis.fetch = mockFetch(
        async () =>
          new Response(JSON.stringify(repos), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              Link: linkHeader("repos-next", true),
            },
          })
      );

      const result = await listRepositoriesPaginated("test-org");
      expect(result.data).toHaveLength(1);
      expect(result.nextCursor).toBe("repos-next");
    });

    test("passes cursor and perPage options", async () => {
      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        const url = new URL(req.url);
        expect(url.searchParams.get("cursor")).toBe("repo-cursor");
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      await listRepositoriesPaginated("test-org", {
        cursor: "repo-cursor",
        perPage: 25,
      });
    });
  });
});

// =============================================================================
// traces.ts — listTransactions
// =============================================================================

describe("traces.ts (transactions)", () => {
  describe("listTransactions", () => {
    test("lists transactions for a project slug", async () => {
      const txnResponse = {
        data: [
          {
            trace: "abc123",
            id: "evt-1",
            transaction: "GET /api/users",
            timestamp: "2024-01-01T00:00:00Z",
            "span.duration": 150,
            project: "test-project",
          },
        ],
        meta: { fields: {} },
      };

      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        const url = new URL(req.url);
        expect(url.pathname).toContain("/organizations/test-org/events/");
        expect(url.searchParams.get("dataset")).toBe("spans");
        expect(url.searchParams.get("query")).toContain("is_transaction:true");
        expect(url.searchParams.get("query")).toContain("project:test-project");
        return new Response(JSON.stringify(txnResponse), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            Link: linkHeader("txn-next", true),
          },
        });
      });

      const result = await listTransactions("test-org", "test-project");
      expect(result.data).toHaveLength(1);
      expect(result.data[0]!.transaction).toBe("GET /api/users");
      expect(result.nextCursor).toBe("txn-next");
    });

    test("uses numeric project ID via project param", async () => {
      const txnResponse = {
        data: [],
        meta: { fields: {} },
      };

      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        const url = new URL(req.url);
        expect(url.searchParams.get("project")).toBe("42");
        const query = url.searchParams.get("query");
        if (query) {
          expect(query).not.toContain("project:");
        }
        return new Response(JSON.stringify(txnResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      await listTransactions("test-org", "42");
    });

    test("passes sort and statsPeriod options", async () => {
      const txnResponse = { data: [], meta: {} };

      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        const url = new URL(req.url);
        expect(url.searchParams.get("sort")).toBe("-span.duration");
        expect(url.searchParams.get("statsPeriod")).toBe("24h");
        return new Response(JSON.stringify(txnResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      await listTransactions("test-org", "test-project", {
        sort: "duration",
        statsPeriod: "24h",
      });
    });

    test("uses -timestamp sort for date sort option", async () => {
      const txnResponse = { data: [], meta: {} };

      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        const url = new URL(req.url);
        expect(url.searchParams.get("sort")).toBe("-timestamp");
        return new Response(JSON.stringify(txnResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      await listTransactions("test-org", "test-project", { sort: "date" });
    });
  });
});

// =============================================================================
// logs.ts — getLogs and listTraceLogs
// =============================================================================

describe("logs.ts (detailed)", () => {
  describe("getLogs", () => {
    test("fetches single batch of log entries by ID", async () => {
      const logsResponse = {
        data: [
          {
            "sentry.item_id": "log-1",
            timestamp: "2024-01-01T00:00:00Z",
            timestamp_precise: 1_704_067_200_000_000_000,
            message: "Test log",
            severity: "info",
            trace: null,
          },
        ],
        meta: { fields: {} },
      };

      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        const url = new URL(req.url);
        const query = url.searchParams.get("query") ?? "";
        expect(query).toContain("sentry.item_id:[log-1]");
        expect(query).toContain("project:test-project");
        return new Response(JSON.stringify(logsResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const result = await getLogs("test-org", "test-project", ["log-1"]);
      expect(result).toHaveLength(1);
      expect(result[0]!["sentry.item_id"]).toBe("log-1");
    });

    test("splits into batches when over API_MAX_PER_PAGE", async () => {
      // Create 150 log IDs (more than API_MAX_PER_PAGE=100)
      const logIds = Array.from({ length: 150 }, (_, i) => `log-${i}`);
      let callCount = 0;

      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        const url = new URL(req.url);

        // The SDK uses /events/ endpoint for logs
        if (url.pathname.includes("/events/")) {
          callCount += 1;
          // Return a valid but empty batch
          return new Response(
            JSON.stringify({
              data: [
                {
                  "sentry.item_id": `batch-${callCount}`,
                  timestamp: "2024-01-01T00:00:00Z",
                  timestamp_precise: 1_704_067_200_000_000_000,
                  message: "test",
                },
              ],
              meta: { fields: {} },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });

      const result = await getLogs("test-org", "test-project", logIds);
      // Should have made 2 batch calls (100 + 50)
      expect(callCount).toBe(2);
      expect(result).toHaveLength(2);
    });
  });

  describe("listTraceLogs", () => {
    test("lists logs for a trace", async () => {
      const traceLogsResponse = {
        data: [
          {
            id: "tlog-1",
            "project.id": 1,
            trace: "abc123def456",
            severity: "info",
            timestamp: "2024-01-01T00:00:00Z",
            message: "Trace log entry",
          },
        ],
        meta: { fields: {} },
      };

      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        const url = new URL(req.url);
        expect(url.pathname).toContain("/organizations/test-org/trace-logs/");
        expect(url.searchParams.get("traceId")).toBe("abc123def456");
        expect(url.searchParams.get("statsPeriod")).toBe("14d");
        return new Response(JSON.stringify(traceLogsResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const result = await listTraceLogs("test-org", "abc123def456");
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe("tlog-1");
    });

    test("passes custom statsPeriod and limit", async () => {
      const traceLogsResponse = { data: [], meta: {} };

      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        const url = new URL(req.url);
        expect(url.searchParams.get("statsPeriod")).toBe("7d");
        expect(url.searchParams.get("per_page")).toBe("50");
        return new Response(JSON.stringify(traceLogsResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      await listTraceLogs("test-org", "abc123def456", {
        statsPeriod: "7d",
        limit: 50,
      });
    });

    test("passes custom query", async () => {
      const traceLogsResponse = { data: [], meta: {} };

      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        const url = new URL(req.url);
        expect(url.searchParams.get("query")).toBe("severity:error");
        return new Response(JSON.stringify(traceLogsResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      await listTraceLogs("test-org", "abc123def456", {
        query: "severity:error",
      });
    });
  });
});

// =============================================================================
// events.ts — findEventAcrossOrgs
// =============================================================================

describe("events.ts (findEventAcrossOrgs)", () => {
  test("finds event across multiple orgs", async () => {
    // This test needs both listOrganizations and resolveEventInOrg mocked.
    // listOrganizations uses /organizations/ (control silo, single call)
    // resolveEventInOrg uses /organizations/{org}/eventids/{event_id}/
    const resolved = {
      organizationSlug: "test-org",
      projectSlug: "test-project",
      event: { eventID: "evt-found" },
    };

    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);

      // listOrganizations → listOrganizationsPage (control silo)
      if (
        req.url.includes("/organizations/") &&
        !req.url.includes("eventids")
      ) {
        return new Response(
          JSON.stringify([{ id: "1", slug: "test-org", name: "Test Org" }]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
      // resolveOrganizationEventId
      if (req.url.includes("/eventids/")) {
        return new Response(JSON.stringify(resolved), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    });

    const { findEventAcrossOrgs } = await import("../../src/lib/api-client.js");
    const result = await findEventAcrossOrgs("evt-found");
    expect(result).not.toBeNull();
    expect(result!.org).toBe("test-org");
  });
});

// =============================================================================
// infrastructure.ts — rawApiRequest
// =============================================================================

describe("infrastructure.ts (rawApiRequest)", () => {
  describe("rawApiRequest", () => {
    test("makes GET request and returns status, headers, body", async () => {
      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        expect(req.method).toBe("GET");
        expect(req.url).toContain("/api/0/organizations/");
        return new Response(JSON.stringify({ data: "test" }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Custom": "value",
          },
        });
      });

      const result = await rawApiRequest("/organizations/");
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ data: "test" });
      expect(result.headers.get("X-Custom")).toBe("value");
    });

    test("returns non-JSON body as text", async () => {
      globalThis.fetch = mockFetch(
        async () =>
          new Response("plain text response", {
            status: 200,
            headers: { "Content-Type": "text/plain" },
          })
      );

      const result = await rawApiRequest("/test/");
      expect(result.body).toBe("plain text response");
    });

    test("does not throw on non-2xx responses", async () => {
      globalThis.fetch = mockFetch(
        async () =>
          new Response(JSON.stringify({ detail: "Not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          })
      );

      const result = await rawApiRequest("/test/");
      expect(result.status).toBe(404);
      expect(result.body).toEqual({ detail: "Not found" });
    });

    test("sends POST with JSON body and Content-Type", async () => {
      let capturedBody: unknown;
      let capturedContentType = "";

      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        capturedContentType = req.headers.get("Content-Type") ?? "";
        capturedBody = await req.json();
        return new Response(JSON.stringify({}), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      });

      await rawApiRequest("/test/", {
        method: "POST",
        body: { key: "value" },
      });
      expect(capturedBody).toEqual({ key: "value" });
      expect(capturedContentType).toBe("application/json");
    });

    test("sends string body without auto Content-Type", async () => {
      let capturedBody = "";

      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        capturedBody = await req.text();
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      await rawApiRequest("/test/", {
        method: "POST",
        body: "raw-string-body",
      });
      expect(capturedBody).toBe("raw-string-body");
    });

    test("includes custom headers", async () => {
      let capturedAccept = "";

      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        capturedAccept = req.headers.get("Accept") ?? "";
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      await rawApiRequest("/test/", {
        headers: { Accept: "text/csv" },
      });
      expect(capturedAccept).toBe("text/csv");
    });

    test("merges query params with an existing endpoint query", async () => {
      globalThis.fetch = mockFetch(async (input) => {
        const url = new URL(
          String(input instanceof Request ? input.url : input)
        );
        expect(url.searchParams.get("download")).toBe("1");
        expect(url.searchParams.get("per_page")).toBe("10");
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      await rawApiRequest("/test/?download=1", {
        params: { per_page: 10 },
      });
    });
  });
});

// =============================================================================
// infrastructure.ts — buildSearchParams and parseLinkHeader
// =============================================================================

describe("infrastructure.ts (helpers)", () => {
  describe("buildSearchParams", () => {
    // Import from infrastructure for direct testing
    test("returns undefined for undefined input", async () => {
      const { buildSearchParams } = await import(
        "../../src/lib/api/infrastructure.js"
      );
      expect(buildSearchParams(undefined)).toBeUndefined();
    });

    test("returns undefined for all-undefined values", async () => {
      const { buildSearchParams } = await import(
        "../../src/lib/api/infrastructure.js"
      );
      expect(buildSearchParams({ a: undefined, b: undefined })).toBeUndefined();
    });

    test("handles string, number, and boolean values", async () => {
      const { buildSearchParams } = await import(
        "../../src/lib/api/infrastructure.js"
      );
      const result = buildSearchParams({
        str: "hello",
        num: 42,
        flag: true,
      });
      expect(result).toBeDefined();
      expect(result!.get("str")).toBe("hello");
      expect(result!.get("num")).toBe("42");
      expect(result!.get("flag")).toBe("true");
    });

    test("handles string arrays (repeated keys)", async () => {
      const { buildSearchParams } = await import(
        "../../src/lib/api/infrastructure.js"
      );
      const result = buildSearchParams({ tags: ["a", "b", "c"] });
      expect(result).toBeDefined();
      expect(result!.getAll("tags")).toEqual(["a", "b", "c"]);
    });

    test("skips undefined values", async () => {
      const { buildSearchParams } = await import(
        "../../src/lib/api/infrastructure.js"
      );
      const result = buildSearchParams({
        present: "yes",
        missing: undefined,
      });
      expect(result).toBeDefined();
      expect(result!.get("present")).toBe("yes");
      expect(result!.has("missing")).toBe(false);
    });
  });

  describe("parseLinkHeader", () => {
    test("returns empty for null header", async () => {
      const { parseLinkHeader } = await import(
        "../../src/lib/api/infrastructure.js"
      );
      expect(parseLinkHeader(null)).toEqual({});
    });

    test("returns empty for empty string", async () => {
      const { parseLinkHeader } = await import(
        "../../src/lib/api/infrastructure.js"
      );
      expect(parseLinkHeader("")).toEqual({});
    });

    test("extracts next cursor when results=true", async () => {
      const { parseLinkHeader } = await import(
        "../../src/lib/api/infrastructure.js"
      );
      const header =
        '<https://sentry.io/api/0/next/>; rel="next"; results="true"; cursor="1735689600000:0:0"';
      expect(parseLinkHeader(header)).toEqual({
        nextCursor: "1735689600000:0:0",
      });
    });

    test("returns empty when results=false", async () => {
      const { parseLinkHeader } = await import(
        "../../src/lib/api/infrastructure.js"
      );
      const header =
        '<https://sentry.io/api/0/next/>; rel="next"; results="false"; cursor="abc"';
      expect(parseLinkHeader(header)).toEqual({});
    });

    test("handles multiple link entries", async () => {
      const { parseLinkHeader } = await import(
        "../../src/lib/api/infrastructure.js"
      );
      const header =
        '<url>; rel="previous"; results="false"; cursor="prev",' +
        '<url>; rel="next"; results="true"; cursor="next-val"';
      expect(parseLinkHeader(header)).toEqual({ nextCursor: "next-val" });
    });
  });
});
