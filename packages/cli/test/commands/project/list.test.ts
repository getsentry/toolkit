/**
 * Unit Tests for Project List Command
 *
 * Tests the exported helper functions and handler functions.
 * Handlers are tested with fetch mocking for API isolation.
 */

// biome-ignore-all lint/suspicious/noMisplacedAssertion: Property tests use expect() inside fast-check callbacks.

import {
  array,
  constantFrom,
  assert as fcAssert,
  property,
  tuple,
} from "fast-check";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  buildContextKey,
  displayProjectTable,
  fetchAllOrgProjects,
  fetchOrgProjects,
  fetchOrgProjectsSafe,
  filterByPlatform,
  handleAutoDetect,
  handleExplicit,
  handleOrgAll,
  handleProjectSearch,
  PAGINATION_KEY,
} from "../../../src/commands/project/list.js";
import type { ParsedOrgProject } from "../../../src/lib/arg-parsing.js";
import { DEFAULT_SENTRY_URL } from "../../../src/lib/constants.js";
import { clearAuth, setAuthToken } from "../../../src/lib/db/auth.js";
import { setDefaultOrganization } from "../../../src/lib/db/defaults.js";
import {
  advancePaginationState,
  getPaginationState,
  resolveCursor,
} from "../../../src/lib/db/pagination.js";
import { setOrgRegion } from "../../../src/lib/db/regions.js";
import {
  AuthError,
  ResolutionError,
  ValidationError,
} from "../../../src/lib/errors.js";
import type { SentryProject } from "../../../src/types/index.js";
import { useTestConfigDir } from "../../helpers.js";
import { DEFAULT_NUM_RUNS } from "../../model-based/helpers.js";

useTestConfigDir("test-project-list-", { isolateProjectRoot: true });

/** Create a minimal project for testing */
function makeProject(
  overrides: Partial<SentryProject> & { orgSlug?: string } = {}
): SentryProject & { orgSlug?: string } {
  return {
    id: "1",
    slug: "test-project",
    name: "Test Project",
    platform: "javascript",
    dateCreated: "2024-01-01T00:00:00Z",
    status: "active",
    ...overrides,
  };
}

// Arbitraries

const slugArb = array(
  constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")),
  {
    minLength: 1,
    maxLength: 12,
  }
).map((chars) => chars.join(""));

const platformArb = constantFrom(
  "javascript",
  "python",
  "go",
  "java",
  "ruby",
  "php",
  "javascript-react",
  "python-django"
);

// Tests

describe("buildContextKey", () => {
  const host = "https://sentry.io";

  test("org-all mode produces host:<url>|type:org:<slug>", () => {
    fcAssert(
      property(slugArb, (org) => {
        const parsed: ParsedOrgProject = { type: "org-all", org };
        const key = buildContextKey(parsed, {}, host);
        expect(key).toBe(`host:${host}|type:org:${org}`);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("auto-detect mode produces host + type:auto", () => {
    const parsed: ParsedOrgProject = { type: "auto-detect" };
    expect(buildContextKey(parsed, {}, host)).toBe(`host:${host}|type:auto`);
  });

  test("explicit mode produces host + type:explicit:<org>/<project>", () => {
    fcAssert(
      property(tuple(slugArb, slugArb), ([org, project]) => {
        const parsed: ParsedOrgProject = { type: "explicit", org, project };
        const key = buildContextKey(parsed, {}, host);
        expect(key).toBe(`host:${host}|type:explicit:${org}/${project}`);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("project-search mode produces host + type:search:<slug>", () => {
    fcAssert(
      property(slugArb, (projectSlug) => {
        const parsed: ParsedOrgProject = {
          type: "project-search",
          projectSlug,
        };
        const key = buildContextKey(parsed, {}, host);
        expect(key).toBe(`host:${host}|type:search:${projectSlug}`);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("platform flag is appended with pipe separator", () => {
    fcAssert(
      property(tuple(slugArb, platformArb), ([org, platform]) => {
        const parsed: ParsedOrgProject = { type: "org-all", org };
        const key = buildContextKey(parsed, { platform }, host);
        expect(key).toBe(`host:${host}|type:org:${org}|platform:${platform}`);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("different hosts produce different keys for same org", () => {
    fcAssert(
      property(slugArb, (org) => {
        const parsed: ParsedOrgProject = { type: "org-all", org };
        const saas = buildContextKey(parsed, {}, "https://sentry.io");
        const selfHosted = buildContextKey(
          parsed,
          {},
          "https://sentry.example.com"
        );
        expect(saas).not.toBe(selfHosted);
        expect(saas).toStartWith("host:https://sentry.io|");
        expect(selfHosted).toStartWith("host:https://sentry.example.com|");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("filterByPlatform", () => {
  test("no platform returns all projects", () => {
    const projects = [
      makeProject({ platform: "javascript" }),
      makeProject({ platform: "python" }),
    ];
    expect(filterByPlatform(projects)).toHaveLength(2);
    expect(filterByPlatform(projects, undefined)).toHaveLength(2);
  });

  test("case-insensitive partial match", () => {
    const projects = [
      makeProject({ slug: "web", platform: "javascript-react" }),
      makeProject({ slug: "api", platform: "python-django" }),
      makeProject({ slug: "cli", platform: "javascript" }),
    ];

    // Partial match
    expect(filterByPlatform(projects, "javascript")).toHaveLength(2);
    expect(filterByPlatform(projects, "python")).toHaveLength(1);

    // Case-insensitive
    expect(filterByPlatform(projects, "JAVASCRIPT")).toHaveLength(2);
    expect(filterByPlatform(projects, "Python")).toHaveLength(1);
  });

  test("no match returns empty array", () => {
    const projects = [makeProject({ platform: "javascript" })];
    expect(filterByPlatform(projects, "rust")).toHaveLength(0);
  });

  test("null platform in project is not matched", () => {
    const projects = [makeProject({ platform: null as unknown as string })];
    expect(filterByPlatform(projects, "javascript")).toHaveLength(0);
  });

  test("property: filtering is idempotent", () => {
    fcAssert(
      property(platformArb, (platform) => {
        const projects = [
          makeProject({ slug: "a", platform: "javascript-react" }),
          makeProject({ slug: "b", platform: "python-django" }),
          makeProject({ slug: "c", platform: "go" }),
        ];
        const once = filterByPlatform(projects, platform);
        const twice = filterByPlatform(once, platform);
        expect(twice).toEqual(once);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("property: filtered result is subset of input", () => {
    fcAssert(
      property(platformArb, (platform) => {
        const projects = [
          makeProject({ slug: "a", platform: "javascript" }),
          makeProject({ slug: "b", platform: "python" }),
          makeProject({ slug: "c", platform: "go" }),
        ];
        const filtered = filterByPlatform(projects, platform);
        expect(filtered.length).toBeLessThanOrEqual(projects.length);
        for (const p of filtered) {
          expect(projects).toContain(p);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("resolveCursor", () => {
  test("undefined cursor returns undefined with direction 'first'", () => {
    const result = resolveCursor(undefined, PAGINATION_KEY, "org:sentry");
    expect(result.cursor).toBeUndefined();
    expect(result.direction).toBe("first");
  });

  test("explicit cursor value is passed through with direction 'next'", () => {
    const result = resolveCursor(
      "1735689600000:100:0",
      PAGINATION_KEY,
      "org:sentry"
    );
    expect(result.cursor).toBe("1735689600000:100:0");
    expect(result.direction).toBe("next");
  });

  test("'next' with no saved state throws ValidationError", () => {
    expect(() => resolveCursor("next", PAGINATION_KEY, "org:sentry")).toThrow(
      ValidationError
    );
    expect(() => resolveCursor("next", PAGINATION_KEY, "org:sentry")).toThrow(
      /No next page/
    );
  });

  test("'next' with saved state returns the next cursor", () => {
    const cursor = "1735689600000:100:0";
    const contextKey = "org:test-resolve";
    // Simulate having visited page 0 with a next cursor at index 1
    advancePaginationState(PAGINATION_KEY, contextKey, "next", cursor);

    // Now "next" should return that cursor (advancing from index 0 to 1)
    const result = resolveCursor("next", PAGINATION_KEY, contextKey);
    expect(result.cursor).toBe(cursor);
    expect(result.direction).toBe("next");
  });

  test("'prev' on first page throws ValidationError", () => {
    const contextKey = "org:test-prev-first";
    // Simulate being on the first page
    advancePaginationState(PAGINATION_KEY, contextKey, "next", "some-cursor");

    expect(() => resolveCursor("prev", PAGINATION_KEY, contextKey)).toThrow(
      ValidationError
    );
    expect(() => resolveCursor("prev", PAGINATION_KEY, contextKey)).toThrow(
      /first page/
    );
  });

  test("'first' returns undefined cursor with direction 'first'", () => {
    const result = resolveCursor("first", PAGINATION_KEY, "org:sentry");
    expect(result.cursor).toBeUndefined();
    expect(result.direction).toBe("first");
  });
});

// Handler tests with fetch mocking

let originalFetch: typeof globalThis.fetch;

/** Create a mock fetch for project API calls */
function mockProjectFetch(
  projects: SentryProject[],
  options: { hasMore?: boolean; nextCursor?: string } = {}
): typeof globalThis.fetch {
  const { hasMore = false, nextCursor } = options;
  // @ts-expect-error - partial mock
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = req.url;

    // getProject (single project fetch via /projects/{org}/{slug}/)
    if (url.match(/\/projects\/[^/]+\/[^/]+\//)) {
      if (projects.length > 0) {
        return new Response(JSON.stringify(projects[0]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    }

    // listProjects / listProjectsPaginated (via /organizations/{org}/projects/)
    if (url.includes("/projects/")) {
      const perPage = Number(new URL(url).searchParams.get("per_page") ?? "0");
      if (perPage > 100) {
        return new Response(JSON.stringify({ detail: "invalid per_page" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const linkParts: string[] = [
        `<${url}>; rel="previous"; results="false"; cursor="0:0:1"`,
      ];
      if (hasMore && nextCursor) {
        linkParts.push(
          `<${url}>; rel="next"; results="true"; cursor="${nextCursor}"`
        );
      } else {
        linkParts.push(`<${url}>; rel="next"; results="false"; cursor="0:0:0"`);
      }
      return new Response(JSON.stringify(projects), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          Link: linkParts.join(", "),
        },
      });
    }

    // listOrganizations
    if (
      url.includes("/organizations/") &&
      !url.includes("/projects/") &&
      !url.includes("/issues/")
    ) {
      return new Response(
        JSON.stringify([{ id: "1", slug: "test-org", name: "Test Org" }]),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    return new Response(JSON.stringify({ detail: "Not found" }), {
      status: 404,
    });
  };
}

const sampleProjects: SentryProject[] = [
  {
    id: "1",
    slug: "frontend",
    name: "Frontend",
    platform: "javascript",
    dateCreated: "2024-01-01T00:00:00Z",
    status: "active",
  },
  {
    id: "2",
    slug: "backend",
    name: "Backend",
    platform: "python",
    dateCreated: "2024-01-01T00:00:00Z",
    status: "active",
  },
];

describe("handleExplicit", () => {
  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    await setAuthToken("test-token");
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns single project", async () => {
    globalThis.fetch = mockProjectFetch(sampleProjects);

    const result = await handleExplicit("test-org", "frontend", {
      limit: 30,
      json: false,
      fresh: false,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.slug).toBe("frontend");
    expect(result.items[0]?.orgSlug).toBe("test-org");
  });

  test("not found returns empty with hint", async () => {
    globalThis.fetch = mockProjectFetch([]);

    const result = await handleExplicit("test-org", "nonexistent", {
      limit: 30,
      json: false,
      fresh: false,
    });

    expect(result.items).toHaveLength(0);
    expect(result.hint).toContain("No project");
    expect(result.hint).toContain("nonexistent");
    expect(result.hint).toContain("Tip:");
  });

  test("platform filter with no match returns empty with hint", async () => {
    globalThis.fetch = mockProjectFetch(sampleProjects);

    const result = await handleExplicit("test-org", "frontend", {
      limit: 30,
      json: false,
      platform: "ruby",
      fresh: false,
    });

    expect(result.items).toHaveLength(0);
    expect(result.hint).toContain("No project");
    expect(result.hint).toContain("platform");
  });

  test("platform filter match returns project", async () => {
    globalThis.fetch = mockProjectFetch(sampleProjects);

    const result = await handleExplicit("test-org", "frontend", {
      limit: 30,
      json: false,
      platform: "javascript",
      fresh: false,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.slug).toBe("frontend");
  });
});

describe("handleOrgAll", () => {
  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    await setAuthToken("test-token");
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns paginated project list", async () => {
    globalThis.fetch = mockProjectFetch(sampleProjects);

    const result = await handleOrgAll({
      org: "test-org",
      flags: { limit: 30, json: false, fresh: false },
      contextKey: "type:org:test-org",
      cursor: undefined,
      direction: "next",
    });

    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.slug).toBe("frontend");
    expect(result.items[1]?.slug).toBe("backend");
    expect(result.header).toContain("Showing 2 projects");
  });

  test("hasMore includes nextCursor in result", async () => {
    globalThis.fetch = mockProjectFetch(sampleProjects, {
      hasMore: true,
      nextCursor: "1735689600000:100:0",
    });

    const result = await handleOrgAll({
      org: "test-org",
      flags: { limit: 30, json: true, fresh: false },
      contextKey: "type:org:test-org",
      cursor: undefined,
      direction: "next",
    });

    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe("1735689600000:100:0");
    expect(result.items).toHaveLength(2);
  });

  test("no hasMore returns hasMore: false", async () => {
    globalThis.fetch = mockProjectFetch(sampleProjects);

    const result = await handleOrgAll({
      org: "test-org",
      flags: { limit: 30, json: true, fresh: false },
      contextKey: "type:org:test-org",
      cursor: undefined,
      direction: "next",
    });

    expect(result.hasMore).toBe(false);
    expect(result.items).toHaveLength(2);
  });

  test("hasMore advances pagination state with next cursor", async () => {
    globalThis.fetch = mockProjectFetch(sampleProjects, {
      hasMore: true,
      nextCursor: "1735689600000:100:0",
    });

    await handleOrgAll({
      org: "test-org",
      flags: { limit: 30, json: false, fresh: false },
      contextKey: "type:org:test-org",
      cursor: undefined,
      direction: "next",
    });

    const state = getPaginationState(PAGINATION_KEY, "type:org:test-org");
    expect(state).toBeDefined();
    expect(state!.stack).toContain("1735689600000:100:0");
  });

  test("no hasMore truncates pagination stack", async () => {
    // Seed some state first
    advancePaginationState(
      PAGINATION_KEY,
      "type:org:test-org",
      "next",
      "old-cursor"
    );

    globalThis.fetch = mockProjectFetch(sampleProjects);

    await handleOrgAll({
      org: "test-org",
      flags: { limit: 30, json: false, fresh: false },
      contextKey: "type:org:test-org",
      cursor: undefined,
      direction: "first",
    });

    const state = getPaginationState(PAGINATION_KEY, "type:org:test-org");
    // After fetching the first page with no nextCursor, stack should be [""]
    expect(state).toBeDefined();
    expect(state!.stack).toEqual([""]);
    expect(state!.index).toBe(0);
  });

  test("empty page with hasMore suggests next page", async () => {
    globalThis.fetch = mockProjectFetch([], {
      hasMore: true,
      nextCursor: "1735689600000:100:0",
    });

    const result = await handleOrgAll({
      org: "test-org",
      flags: { limit: 30, json: false, platform: "rust", fresh: false },
      contextKey: "type:org:test-org",
      cursor: undefined,
      direction: "next",
    });

    expect(result.items).toHaveLength(0);
    expect(result.hint).toContain("projects on this page");
    expect(result.hint).toContain("-c next");
    expect(result.hint).toContain("--platform rust");
  });

  test("empty page without hasMore shows no projects", async () => {
    globalThis.fetch = mockProjectFetch([]);

    const result = await handleOrgAll({
      org: "test-org",
      flags: { limit: 30, json: false, fresh: false },
      contextKey: "type:org:test-org",
      cursor: undefined,
      direction: "next",
    });

    expect(result.items).toHaveLength(0);
    expect(result.hint).toContain("No projects found");
  });

  test("empty page without hasMore and platform filter shows platform message", async () => {
    globalThis.fetch = mockProjectFetch([]);

    const result = await handleOrgAll({
      org: "test-org",
      flags: { limit: 30, json: false, platform: "rust", fresh: false },
      contextKey: "type:org:test-org",
      cursor: undefined,
      direction: "next",
    });

    expect(result.hint).toContain("matching platform 'rust'");
    expect(result.hint).not.toContain("No projects found in organization");
  });

  test("hasMore shows next page hint", async () => {
    globalThis.fetch = mockProjectFetch(sampleProjects, {
      hasMore: true,
      nextCursor: "1735689600000:100:0",
    });

    const result = await handleOrgAll({
      org: "test-org",
      flags: { limit: 30, json: false, fresh: false },
      contextKey: "type:org:test-org",
      cursor: undefined,
      direction: "next",
    });

    expect(result.header).toContain("more available");
    expect(result.header).toContain("-c next");
    expect(result.hint).not.toContain("--platform");
  });

  test("hasMore with platform includes --platform in header", async () => {
    globalThis.fetch = mockProjectFetch(sampleProjects, {
      hasMore: true,
      nextCursor: "1735689600000:100:0",
    });

    const result = await handleOrgAll({
      org: "test-org",
      flags: { limit: 30, json: false, platform: "python", fresh: false },
      contextKey: "type:org:test-org:platform:python",
      cursor: undefined,
      direction: "next",
    });

    expect(result.header).toContain("--platform python");
    expect(result.header).toContain("-c next");
  });

  test("auto-paginates --limit above API per_page cap without sending per_page>100", async () => {
    const total = 250;
    const pool = Array.from({ length: total }, (_, i) =>
      makeProject({
        id: String(i + 1),
        slug: `proj-${i}`,
        name: `Project ${i}`,
      })
    );
    const perPageValues: number[] = [];

    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const parsed = new URL(req.url);
      if (!parsed.pathname.includes("/projects/")) {
        return new Response(JSON.stringify({ detail: "Not found" }), {
          status: 404,
        });
      }

      const perPage = Number(parsed.searchParams.get("per_page") ?? "0");
      perPageValues.push(perPage);
      expect(perPage).toBeGreaterThan(0);
      expect(perPage).toBeLessThanOrEqual(100);

      const cursor = parsed.searchParams.get("cursor");
      const offset = cursor ? Number(cursor) : 0;
      const page = pool.slice(offset, offset + perPage);
      const nextOffset = offset + page.length;
      const hasMore = nextOffset < total;
      const linkParts = [
        `<${parsed.href}>; rel="previous"; results="false"; cursor="0:0:1"`,
        hasMore
          ? `<${parsed.href}>; rel="next"; results="true"; cursor="${nextOffset}"`
          : `<${parsed.href}>; rel="next"; results="false"; cursor="0:0:0"`,
      ];
      return new Response(JSON.stringify(page), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          Link: linkParts.join(", "),
        },
      });
    };

    const result = await handleOrgAll({
      org: "test-org",
      flags: { limit: 200, json: true, fresh: false },
      contextKey: "type:org:test-org",
      cursor: undefined,
      direction: "next",
    });

    expect(result.items).toHaveLength(200);
    expect(result.items[0]?.slug).toBe("proj-0");
    expect(result.items[199]?.slug).toBe("proj-199");
    expect(perPageValues).toEqual([100, 100]);
    expect(result.hasMore).toBe(true);
  });
});

describe("handleProjectSearch", () => {
  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    await setAuthToken("test-token");
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("finds project across orgs", async () => {
    globalThis.fetch = mockProjectFetch(sampleProjects);

    const result = await handleProjectSearch("frontend", {
      limit: 30,
      json: false,
      fresh: false,
    });

    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0]?.slug).toBe("frontend");
  });

  test("not found throws ResolutionError", async () => {
    // Mock returning orgs but 404 for project lookups
    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;

      if (url.includes("/organizations/") && !url.includes("/projects/")) {
        return new Response(
          JSON.stringify([{ id: "1", slug: "test-org", name: "Test Org" }]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      // getProject (SDK getProject) hits /projects/{org}/{slug}/
      // Return 404 to simulate project not found
      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    await expect(
      handleProjectSearch("nonexistent", {
        limit: 30,
        json: false,
        fresh: false,
      })
    ).rejects.toThrow(ResolutionError);
  });

  test("not found with --json returns empty items", async () => {
    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;

      if (url.includes("/organizations/") && !url.includes("/projects/")) {
        return new Response(
          JSON.stringify([{ id: "1", slug: "test-org", name: "Test Org" }]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    // With --json, project-search returns empty array instead of throwing
    const result = await handleProjectSearch("nonexistent", {
      limit: 30,
      json: true,
      fresh: false,
    });
    expect(result.items).toEqual([]);
  });

  test("multiple results returns items", async () => {
    globalThis.fetch = mockProjectFetch([...sampleProjects, ...sampleProjects]);

    const result = await handleProjectSearch("frontend", {
      limit: 30,
      json: false,
      fresh: false,
    });

    expect(result.items.length).toBeGreaterThan(0);
  });

  test("found but filtered by platform returns hint with platform message", async () => {
    globalThis.fetch = mockProjectFetch(sampleProjects);

    const result = await handleProjectSearch("frontend", {
      limit: 30,
      json: false,
      platform: "rust",
      fresh: false,
    });

    expect(result.items).toHaveLength(0);
    expect(result.hint).toContain("matching platform 'rust'");
  });

  test("scopedOrg only returns the matched project from that org, not a same-slug project elsewhere", async () => {
    setOrgRegion("org-a", DEFAULT_SENTRY_URL);
    setOrgRegion("org-b", DEFAULT_SENTRY_URL);

    // listOrganizations returns two orgs; each has a 'frontend' project. The
    // bare-slug lookup fans out across both. With scopedOrg=org-a the result
    // must only contain org-a's project, never org-b's.
    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;

      // getProject — /projects/{org}/{slug}/
      const projMatch = url.match(/\/projects\/([^/]+)\/frontend\//);
      if (projMatch) {
        return new Response(
          JSON.stringify({
            id: projMatch[1] === "org-a" ? "1" : "2",
            slug: "frontend",
            name: "Frontend",
            platform: "javascript",
            dateCreated: "2024-01-01T00:00:00Z",
            status: "active",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // listOrganizations
      if (
        url.includes("/organizations/") &&
        !url.includes("/projects/") &&
        !url.includes("/issues/")
      ) {
        return new Response(
          JSON.stringify([
            { id: "10", slug: "org-a", name: "Org A" },
            { id: "20", slug: "org-b", name: "Org B" },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    const result = await handleProjectSearch(
      "frontend",
      { limit: 30, json: false, fresh: false },
      { scopedOrg: "org-a" }
    );

    expect(result.items.every((i) => i.orgSlug === "org-a")).toBe(true);
    expect(result.items.some((i) => i.orgSlug === "org-b")).toBe(false);
  });

  test("respects --limit flag", async () => {
    setOrgRegion("org-a", DEFAULT_SENTRY_URL);
    setOrgRegion("org-b", DEFAULT_SENTRY_URL);

    const project: SentryProject = {
      id: "1",
      slug: "frontend",
      name: "Frontend",
      platform: "javascript",
      dateCreated: "2024-01-01T00:00:00Z",
      status: "active",
    };

    // Mock that returns 2 orgs, each with the same project slug
    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;

      if (url.match(/\/projects\/[^/]+\/[^/]+\//)) {
        return new Response(JSON.stringify(project), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("/organizations/") && !url.includes("/projects/")) {
        return new Response(
          JSON.stringify([
            { id: "1", slug: "org-a", name: "Org A" },
            { id: "2", slug: "org-b", name: "Org B" },
          ]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    const result = await handleProjectSearch("frontend", {
      limit: 1,
      json: false,
      fresh: false,
    });

    expect(result.items).toHaveLength(1);
    expect(result.header).toContain("Showing 1 of 2 matches");
    expect(result.header).toContain("--limit");
  });

  test("--limit also applies to result items", async () => {
    setOrgRegion("org-a", DEFAULT_SENTRY_URL);
    setOrgRegion("org-b", DEFAULT_SENTRY_URL);

    const project: SentryProject = {
      id: "1",
      slug: "frontend",
      name: "Frontend",
      platform: "javascript",
      dateCreated: "2024-01-01T00:00:00Z",
      status: "active",
    };

    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;

      if (url.match(/\/projects\/[^/]+\/[^/]+\//)) {
        return new Response(JSON.stringify(project), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("/organizations/") && !url.includes("/projects/")) {
        return new Response(
          JSON.stringify([
            { id: "1", slug: "org-a", name: "Org A" },
            { id: "2", slug: "org-b", name: "Org B" },
          ]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    const result = await handleProjectSearch("frontend", {
      limit: 1,
      json: true,
      fresh: false,
    });

    expect(result.items).toHaveLength(1);
  });
});

// ─── displayProjectTable ────────────────────────────────────────

describe("displayProjectTable", () => {
  test("returns string with header and rows", () => {
    const projects = [
      makeProject({
        slug: "web",
        name: "Web App",
        platform: "javascript",
        orgSlug: "acme",
      }),
      makeProject({
        slug: "api",
        name: "API",
        platform: "python",
        orgSlug: "acme",
      }),
    ];

    const text = displayProjectTable(projects);

    // Header row
    expect(text).toContain("ORG");
    expect(text).toContain("PROJECT");
    expect(text).toContain("NAME");
    expect(text).toContain("PLATFORM");

    // Data rows
    expect(text).toContain("web");
    expect(text).toContain("api");
    expect(text).toContain("Web App");
    expect(text).toContain("API");
  });

  test("handles single project", () => {
    const text = displayProjectTable([
      makeProject({ slug: "solo", orgSlug: "org" }),
    ]);
    expect(text).toContain("solo");
  });
});

// ─── fetchOrgProjects ───────────────────────────────────────────

describe("fetchOrgProjects", () => {
  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    await setAuthToken("test-token");
    setOrgRegion("myorg", DEFAULT_SENTRY_URL);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns projects with orgSlug attached", async () => {
    globalThis.fetch = mockProjectFetch(sampleProjects);
    const result = await fetchOrgProjects("myorg");

    expect(result).toHaveLength(2);
    for (const p of result) {
      expect(p.orgSlug).toBe("myorg");
    }
    expect(result[0].slug).toBe("frontend");
    expect(result[1].slug).toBe("backend");
  });

  test("returns empty array when org has no projects", async () => {
    globalThis.fetch = mockProjectFetch([]);
    const result = await fetchOrgProjects("myorg");
    expect(result).toHaveLength(0);
  });
});

describe("fetchOrgProjectsSafe", () => {
  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    await setAuthToken("test-token");
    setOrgRegion("myorg", DEFAULT_SENTRY_URL);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns projects on success", async () => {
    globalThis.fetch = mockProjectFetch(sampleProjects);
    const result = await fetchOrgProjectsSafe("myorg");
    expect(result).toHaveLength(2);
  });

  test("returns empty array on non-auth error", async () => {
    // @ts-expect-error - partial mock
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ detail: "Forbidden" }), {
        status: 403,
      });
    const result = await fetchOrgProjectsSafe("myorg");
    expect(result).toHaveLength(0);
  });

  test("propagates AuthError when not authenticated", async () => {
    // Clear auth token so the API client throws AuthError before making any request
    await clearAuth();

    const savedAuthToken = process.env.SENTRY_AUTH_TOKEN;
    delete process.env.SENTRY_AUTH_TOKEN;

    try {
      await expect(fetchOrgProjectsSafe("myorg")).rejects.toThrow(AuthError);
    } finally {
      if (savedAuthToken !== undefined) {
        process.env.SENTRY_AUTH_TOKEN = savedAuthToken;
      }
    }
  });
});

// ─── fetchAllOrgProjects ────────────────────────────────────────

describe("fetchAllOrgProjects", () => {
  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    await setAuthToken("test-token");
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("fetches projects from all orgs", async () => {
    globalThis.fetch = mockProjectFetch(sampleProjects);
    const result = await fetchAllOrgProjects();

    // mockProjectFetch returns 1 org (test-org) with sampleProjects
    expect(result).toHaveLength(2);
    for (const p of result) {
      expect(p.orgSlug).toBe("test-org");
    }
  });

  test("skips orgs with access errors", async () => {
    let callCount = 0;
    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;

      // listOrganizations
      if (url.includes("/organizations/") && !url.includes("/projects/")) {
        return new Response(
          JSON.stringify([
            { id: "1", slug: "org1", name: "Org 1" },
            { id: "2", slug: "org2", name: "Org 2" },
          ]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      // projects - first org succeeds, second fails with 403
      if (url.includes("/projects/")) {
        callCount += 1;
        if (callCount === 1) {
          return new Response(JSON.stringify(sampleProjects), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              Link: '<url>; rel="next"; results="false"; cursor="0:0:0"',
            },
          });
        }
        return new Response(JSON.stringify({ detail: "Forbidden" }), {
          status: 403,
        });
      }

      return new Response("Not found", { status: 404 });
    };

    setOrgRegion("org1", DEFAULT_SENTRY_URL);
    setOrgRegion("org2", DEFAULT_SENTRY_URL);

    const result = await fetchAllOrgProjects();
    // Only org1's projects should be returned
    expect(result).toHaveLength(2);
  });
});

// ─── handleAutoDetect ───────────────────────────────────────────

describe("handleAutoDetect", () => {
  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    await setAuthToken("test-token");
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns projects from all orgs when no default org", async () => {
    globalThis.fetch = mockProjectFetch(sampleProjects);

    const result = await handleAutoDetect("/tmp/test-project", {
      limit: 30,
      json: false,
      fresh: false,
    });

    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.slug).toBe("frontend");
    expect(result.items[1]?.slug).toBe("backend");
  });

  test("returns hasMore: false when all projects fit", async () => {
    globalThis.fetch = mockProjectFetch(sampleProjects);

    const result = await handleAutoDetect("/tmp/test-project", {
      limit: 30,
      json: true,
      fresh: false,
    });

    expect(result.items).toHaveLength(2);
    expect(result.hasMore).toBe(false);
  });

  test("empty results returns hint with no projects message", async () => {
    globalThis.fetch = mockProjectFetch([]);

    const result = await handleAutoDetect("/tmp/test-project", {
      limit: 30,
      json: false,
      fresh: false,
    });

    expect(result.items).toHaveLength(0);
    expect(result.hint).toContain("No projects found");
  });

  test("respects --limit flag and indicates truncation", async () => {
    const manyProjects = Array.from({ length: 5 }, (_, i) =>
      makeProject({ id: String(i), slug: `proj-${i}`, name: `Project ${i}` })
    );
    globalThis.fetch = mockProjectFetch(manyProjects);

    const result = await handleAutoDetect("/tmp/test-project", {
      limit: 2,
      json: true,
      fresh: false,
    });

    expect(result.items).toHaveLength(2);
    expect(result.hasMore).toBe(true);
    expect(result.jsonExtra).toBeDefined();
    expect((result.jsonExtra as Record<string, unknown>)?.hint).toBeString();
  });

  test("respects --platform flag", async () => {
    globalThis.fetch = mockProjectFetch(sampleProjects);

    const result = await handleAutoDetect("/tmp/test-project", {
      limit: 30,
      json: true,
      platform: "python",
      fresh: false,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.platform).toBe("python");
    expect(result.hasMore).toBe(false);
  });

  test("shows limit message when more projects exist", async () => {
    const manyProjects = Array.from({ length: 5 }, (_, i) =>
      makeProject({ id: String(i), slug: `proj-${i}`, name: `Project ${i}` })
    );
    globalThis.fetch = mockProjectFetch(manyProjects);

    const result = await handleAutoDetect("/tmp/test-project", {
      limit: 2,
      json: false,
      fresh: false,
    });

    expect(result.header).toContain("Showing 2 projects (more available)");
    expect(result.header).toContain("--limit");
  });

  test("fast path: uses single-page fetch for single org without platform filter", async () => {
    // Set default org to trigger single-org resolution
    setDefaultOrganization("test-org");
    globalThis.fetch = mockProjectFetch(sampleProjects);

    const result = await handleAutoDetect("/tmp/test-project", {
      limit: 30,
      json: true,
      fresh: false,
    });

    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.orgSlug).toBe("test-org");
    expect(result.hasMore).toBe(false);
  });

  test("fast path: shows truncation message when server has more results", async () => {
    setDefaultOrganization("test-org");
    globalThis.fetch = mockProjectFetch(sampleProjects, {
      hasMore: true,
      nextCursor: "1735689600000:0:0",
    });

    const result = await handleAutoDetect("/tmp/test-project", {
      limit: 30,
      json: false,
      fresh: false,
    });

    expect(result.header).toContain("Showing 2 projects (more available)");
    expect(result.header).toContain("sentry project list test-org/");
    expect(result.header).not.toContain("--limit");
  });

  test("fast path: includes hasMore and jsonExtra hint when server has more results", async () => {
    setDefaultOrganization("test-org");
    globalThis.fetch = mockProjectFetch(sampleProjects, {
      hasMore: true,
      nextCursor: "1735689600000:0:0",
    });

    const result = await handleAutoDetect("/tmp/test-project", {
      limit: 30,
      json: true,
      fresh: false,
    });

    expect(result.hasMore).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.jsonExtra).toBeDefined();
    const jsonHint = (result.jsonExtra as Record<string, unknown>)?.hint;
    expect(jsonHint).toContain("test-org/");
    expect(jsonHint).toContain("--json");
  });

  test("fast path: non-auth API errors return empty results instead of throwing", async () => {
    setDefaultOrganization("test-org");
    // Mock returns 403 for projects endpoint (stale org, no access)
    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes("/projects/")) {
        return new Response(JSON.stringify({ detail: "Forbidden" }), {
          status: 403,
        });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    };

    const result = await handleAutoDetect("/tmp/test-project", {
      limit: 30,
      json: true,
      fresh: false,
    });

    expect(result.items).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  test("fast path: AuthError still propagates", async () => {
    setDefaultOrganization("test-org");
    // Clear auth so getAuthToken() throws AuthError before any fetch
    await clearAuth();

    const savedAuthToken = process.env.SENTRY_AUTH_TOKEN;
    delete process.env.SENTRY_AUTH_TOKEN;

    try {
      await expect(
        handleAutoDetect("/tmp/test-project", {
          limit: 30,
          json: true,
          fresh: false,
        })
      ).rejects.toThrow(AuthError);
    } finally {
      if (savedAuthToken !== undefined) {
        process.env.SENTRY_AUTH_TOKEN = savedAuthToken;
      }
    }
  });

  test("slow path: uses full fetch when platform filter is active", async () => {
    // Set default org — but platform filter forces slow path
    setDefaultOrganization("test-org");
    globalThis.fetch = mockProjectFetch(sampleProjects);

    const result = await handleAutoDetect("/tmp/test-project", {
      limit: 30,
      json: true,
      platform: "python",
      fresh: false,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.platform).toBe("python");
    expect(result.hasMore).toBe(false);
  });
});
