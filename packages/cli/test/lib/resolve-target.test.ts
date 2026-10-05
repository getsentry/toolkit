/**
 * Tests for resolve-target utilities
 *
 * Property-based and unit tests for pure functions in the resolve-target module.
 * Integration tests for async resolution functions are in e2e tests due to
 * the complexity of mocking module dependencies in Bun's test environment.
 */

import { array, constantFrom, assert as fcAssert, property } from "fast-check";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseOrgProjectArg } from "../../src/lib/arg-parsing.js";
import { DEFAULT_SENTRY_URL } from "../../src/lib/constants.js";
import { setAuthToken } from "../../src/lib/db/auth.js";
import { getDatabase } from "../../src/lib/db/index.js";
import {
  cacheProjectsForOrg,
  clearProjectCache,
  getCachedProjectBySlug,
  setCachedProject,
} from "../../src/lib/db/project-cache.js";
import { setOrgRegion, setOrgRegions } from "../../src/lib/db/regions.js";
import {
  ApiError,
  AuthError,
  ContextError,
  ResolutionError,
} from "../../src/lib/errors.js";
import {
  fetchProjectId,
  isValidDirNameForInference,
  type ResolvedTarget,
  resolveAllTargets,
  resolveLogProjectId,
  resolveOrg,
  resolveOrgAndProject,
  resolveOrgOptionalTarget,
  resolveOrgsForListing,
  resolveTargetSlugs,
  toNumericId,
  tryFuzzyProjectRecovery,
} from "../../src/lib/resolve-target.js";
import {
  disableResponseCache,
  resetCacheState,
} from "../../src/lib/response-cache.js";
import { resetAuthenticatedFetch } from "../../src/lib/sentry-client.js";
import { mockFetch, useTestConfigDir } from "../helpers.js";

// ============================================================================
// Arbitraries for Property-Based Testing
// ============================================================================

/** Characters valid in directory names (no leading dot) */
const dirNameChars = "abcdefghijklmnopqrstuvwxyz0123456789-_";

/** Generate valid directory names (2+ chars, alphanumeric with hyphens/underscores) */
const validDirNameArb = array(constantFrom(...dirNameChars.split("")), {
  minLength: 2,
  maxLength: 30,
}).map((chars) => chars.join(""));

/** Generate single characters */
const singleCharArb = constantFrom(...dirNameChars.split(""));

// ============================================================================
// Property Tests for isValidDirNameForInference
// ============================================================================

describe("property: isValidDirNameForInference", () => {
  test("rejects empty string", () => {
    expect(isValidDirNameForInference("")).toBe(false);
  });

  test("rejects single characters", () => {
    fcAssert(
      property(singleCharArb, (char) => {
        expect(isValidDirNameForInference(char)).toBe(false);
      }),
      { numRuns: 50 }
    );
  });

  test("rejects names starting with dot (hidden directories)", () => {
    fcAssert(
      property(validDirNameArb, (suffix) => {
        // .anything should be rejected - hidden directories are not valid
        const name = `.${suffix}`;
        expect(isValidDirNameForInference(name)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  test("accepts valid directory names (2+ chars, not starting with dot)", () => {
    fcAssert(
      property(validDirNameArb, (name) => {
        // Valid names with 2+ chars that don't start with dot should be accepted
        expect(isValidDirNameForInference(name)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });
});

// ============================================================================
// Example-Based Tests for Edge Cases and Documentation
// ============================================================================

describe("isValidDirNameForInference edge cases", () => {
  test("real-world valid names", () => {
    expect(isValidDirNameForInference("cli")).toBe(true);
    expect(isValidDirNameForInference("my-project")).toBe(true);
    expect(isValidDirNameForInference("sentry-cli")).toBe(true);
    expect(isValidDirNameForInference("frontend")).toBe(true);
    expect(isValidDirNameForInference("my_app")).toBe(true);
  });

  test("hidden directories are rejected", () => {
    expect(isValidDirNameForInference(".env")).toBe(false);
    expect(isValidDirNameForInference(".git")).toBe(false);
    expect(isValidDirNameForInference(".config")).toBe(false);
    expect(isValidDirNameForInference(".")).toBe(false);
    expect(isValidDirNameForInference("..")).toBe(false);
  });

  test("two-character names are the minimum", () => {
    expect(isValidDirNameForInference("ab")).toBe(true);
    expect(isValidDirNameForInference("a1")).toBe(true);
    expect(isValidDirNameForInference("--")).toBe(true);
  });
});

// ============================================================================
// toNumericId — pure function for ID coercion
// ============================================================================

describe("toNumericId", () => {
  test("returns undefined for undefined", () => {
    expect(toNumericId(undefined)).toBeUndefined();
  });

  test("returns undefined for null", () => {
    expect(toNumericId(null)).toBeUndefined();
  });

  test("converts string number to number", () => {
    expect(toNumericId("123")).toBe(123);
  });

  test("returns number as-is", () => {
    expect(toNumericId(123)).toBe(123);
  });

  test("returns undefined for string '0' (not a valid Sentry ID)", () => {
    expect(toNumericId("0")).toBeUndefined();
  });

  test("returns undefined for numeric 0 (not a valid Sentry ID)", () => {
    expect(toNumericId(0)).toBeUndefined();
  });

  test("returns undefined for negative numbers (not valid Sentry IDs)", () => {
    expect(toNumericId(-1)).toBeUndefined();
  });

  test("returns undefined for non-integer floats", () => {
    expect(toNumericId(1.5)).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(toNumericId("")).toBeUndefined();
  });

  test("returns undefined for non-numeric string", () => {
    expect(toNumericId("abc")).toBeUndefined();
  });

  test("returns undefined for negative numbers", () => {
    expect(toNumericId(-1)).toBeUndefined();
    expect(toNumericId("-5")).toBeUndefined();
  });

  test("returns undefined for Infinity", () => {
    expect(toNumericId(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(toNumericId(Number.NEGATIVE_INFINITY)).toBeUndefined();
    expect(toNumericId("Infinity")).toBeUndefined();
  });
});

// ============================================================================
// Environment Variable Resolution (SENTRY_ORG / SENTRY_PROJECT)
//
// These tests call the REAL resolve functions with env vars set.
// When both SENTRY_ORG and SENTRY_PROJECT are provided, the resolve
// functions short-circuit at step 2 and never reach DB/DSN/API calls,
// so no mocking is needed.
// ============================================================================

describe("Environment variable resolution (SENTRY_ORG / SENTRY_PROJECT)", () => {
  useTestConfigDir("test-resolve-target-");

  // Silence unmocked fetch calls from resolution cascade fall-through.
  // Tests that set valid env vars short-circuit before fetch; tests that
  // fall through (empty/whitespace env vars) trigger DSN detection and
  // directory inference which call the API. A silent 404 prevents preload
  // warnings while preserving the catch-and-continue behavior.
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify({ detail: "Not found" }), { status: 404 })
    );
    delete process.env.SENTRY_ORG;
    delete process.env.SENTRY_PROJECT;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.SENTRY_ORG;
    delete process.env.SENTRY_PROJECT;
  });

  // --- resolveOrg ---

  test("resolveOrg: returns org from SENTRY_ORG", async () => {
    process.env.SENTRY_ORG = "test-org";
    const result = await resolveOrg({ cwd: "/tmp" });
    expect(result?.org).toBe("test-org");
  });

  test("resolveOrg: SENTRY_PROJECT=org/project combo extracts org", async () => {
    process.env.SENTRY_PROJECT = "combo-org/combo-project";
    const result = await resolveOrg({ cwd: "/tmp" });
    expect(result?.org).toBe("combo-org");
  });

  test("resolveOrg: CLI flag takes priority over env var", async () => {
    process.env.SENTRY_ORG = "env-org";
    const result = await resolveOrg({ org: "flag-org", cwd: "/tmp" });
    expect(result?.org).toBe("flag-org");
  });

  // --- resolveOrgAndProject ---

  test("resolveOrgAndProject: returns from SENTRY_ORG + SENTRY_PROJECT", async () => {
    process.env.SENTRY_ORG = "test-org";
    process.env.SENTRY_PROJECT = "test-project";
    const result = await resolveOrgAndProject({ cwd: "/tmp" });
    expect(result?.org).toBe("test-org");
    expect(result?.project).toBe("test-project");
    expect(result?.detectedFrom).toContain("env var");
  });

  test("resolveOrgAndProject: SENTRY_PROJECT combo notation", async () => {
    process.env.SENTRY_PROJECT = "my-org/my-project";
    const result = await resolveOrgAndProject({ cwd: "/tmp" });
    expect(result?.org).toBe("my-org");
    expect(result?.project).toBe("my-project");
    expect(result?.detectedFrom).toContain("SENTRY_PROJECT");
  });

  test("resolveOrgAndProject: env vars override config defaults", async () => {
    process.env.SENTRY_ORG = "env-org";
    process.env.SENTRY_PROJECT = "env-project";
    const result = await resolveOrgAndProject({ cwd: "/tmp" });
    expect(result?.org).toBe("env-org");
    expect(result?.project).toBe("env-project");
  });

  test("resolveOrgAndProject: CLI flags override env vars", async () => {
    process.env.SENTRY_ORG = "env-org";
    process.env.SENTRY_PROJECT = "env-project";
    const result = await resolveOrgAndProject({
      org: "flag-org",
      project: "flag-project",
      cwd: "/tmp",
    });
    expect(result?.org).toBe("flag-org");
    expect(result?.project).toBe("flag-project");
    // Explicit path no longer fetches projectId
    expect(result?.projectId).toBeUndefined();
  });

  test("resolveOrgAndProject: ignores empty/whitespace-only values", async () => {
    process.env.SENTRY_ORG = "  ";
    process.env.SENTRY_PROJECT = "";
    // Both empty after trim — should not use env vars
    // This will fall through and return null since /tmp has no DSN
    const result = await resolveOrgAndProject({ cwd: "/tmp" });
    // Should return null or a result that's not from env vars
    if (result) {
      expect(result.detectedFrom ?? "").not.toContain("env var");
    }
  });

  test("resolveOrgAndProject: SENTRY_ORG alone not enough for org+project", async () => {
    process.env.SENTRY_ORG = "my-org";
    // No SENTRY_PROJECT — resolveFromEnvVars returns org-only
    // resolveOrgAndProject needs project, so env vars don't satisfy it
    const result = await resolveOrgAndProject({ cwd: "/tmp" });
    // If result exists (from DSN or dir inference), it should not claim env var source
    if (result) {
      expect(result.detectedFrom ?? "").not.toContain("SENTRY_ORG env var");
    }
  });

  test("resolveOrgAndProject: trailing slash in combo is ignored (no project)", async () => {
    process.env.SENTRY_PROJECT = "my-org/";
    process.env.SENTRY_ORG = "other-org";
    // Malformed combo — slash present but empty project
    // Should fall through; SENTRY_ORG provides org-only
    const result = await resolveOrgAndProject({ cwd: "/tmp" });
    // No project from env vars, so result should not have env-var detectedFrom
    if (result) {
      expect(result.project).not.toContain("/");
    }
  });

  // --- resolveAllTargets ---

  test("resolveAllTargets: returns target from SENTRY_ORG + SENTRY_PROJECT", async () => {
    process.env.SENTRY_ORG = "test-org";
    process.env.SENTRY_PROJECT = "test-project";
    const result = await resolveAllTargets({ cwd: "/tmp" });
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]?.org).toBe("test-org");
    expect(result.targets[0]?.project).toBe("test-project");
  });

  test("resolveAllTargets: env vars override config defaults", async () => {
    process.env.SENTRY_ORG = "env-org";
    process.env.SENTRY_PROJECT = "env-project";
    const result = await resolveAllTargets({ cwd: "/tmp" });
    expect(result.targets[0]?.org).toBe("env-org");
  });

  test("resolveAllTargets: CLI flags override env vars", async () => {
    process.env.SENTRY_ORG = "env-org";
    process.env.SENTRY_PROJECT = "env-project";
    const result = await resolveAllTargets({
      org: "flag-org",
      project: "flag-project",
      cwd: "/tmp",
    });
    expect(result.targets[0]?.org).toBe("flag-org");
    expect(result.targets[0]?.project).toBe("flag-project");
    // Explicit path no longer fetches projectId
    expect(result.targets[0]?.projectId).toBeUndefined();
  });

  // --- resolveOrgsForListing ---

  test("resolveOrgsForListing: returns org from env vars when no flag/defaults", async () => {
    process.env.SENTRY_ORG = "env-org";
    const result = await resolveOrgsForListing(undefined, "/tmp");
    expect(result.orgs).toContain("env-org");
  });
});

// ============================================================================
// fetchProjectId — async project ID lookup with error handling
// ============================================================================

describe("fetchProjectId", () => {
  useTestConfigDir("test-fetchProjectId-");

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns numeric project ID on success", async () => {
    await setAuthToken("test-token");
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input, init);
      if (req.url.includes("/api/0/projects/test-org/test-project/")) {
        return Response.json({ id: "456", slug: "test-project" });
      }
      return new Response("Not found", { status: 404 });
    });

    const result = await fetchProjectId("test-org", "test-project");
    expect(result).toBe(456);
  });

  test("throws ResolutionError on 404", async () => {
    await setAuthToken("test-token");
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify({ detail: "Not found" }), {
          status: 404,
        })
    );

    await expect(fetchProjectId("test-org", "test-project")).rejects.toThrow(
      ResolutionError
    );
  });

  test("includes similar project suggestions on 404 when projects exist", async () => {
    await setAuthToken("test-token");
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);

    // Mock: getProject returns 404, but listProjects returns available projects.
    // The two calls hit different URL patterns.
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input, init);
      const url = req.url;

      // listProjects → GET /api/0/organizations/<org>/projects/
      if (url.includes("/organizations/test-org/projects")) {
        return Response.json([
          { id: "1", slug: "test-project-api", name: "Test Project API" },
          { id: "2", slug: "test-project-web", name: "Test Project Web" },
          { id: "3", slug: "unrelated", name: "Unrelated" },
        ]);
      }

      // getProject → GET /api/0/projects/<org>/<slug>/ → 404
      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    });

    try {
      await fetchProjectId("test-org", "test-project");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError);
      const msg = (error as ResolutionError).message;
      // Should include fuzzy-matched similar projects
      expect(msg).toContain("test-project-api");
      expect(msg).toContain("test-project-web");
      // Should not include unrelated projects (Levenshtein distance too high)
      expect(msg).not.toContain("unrelated");
      // Should suggest listing projects
      expect(msg).toContain("sentry project list test-org/");
    }
  });

  test("includes numeric project ID hint on 404 for all-digit slug", async () => {
    await setAuthToken("test-token");
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify({ detail: "Not found" }), {
          status: 404,
        })
    );

    try {
      await fetchProjectId("test-org", "6775615880");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError);
      const msg = (error as ResolutionError).message;
      expect(msg).toContain("not numeric project IDs");
      expect(msg).toContain("sentry project list test-org/");
      expect(msg.match(/sentry project list test-org\//g)).toHaveLength(1);
    }
  });

  test("includes project list suggestion even when listProjects fails", async () => {
    await setAuthToken("test-token");
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);

    // Mock: all requests return 404 (both getProject and listProjects fail)
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify({ detail: "Not found" }), {
          status: 404,
        })
    );

    try {
      await fetchProjectId("test-org", "test-project");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError);
      const msg = (error as ResolutionError).message;
      // No similar projects (listProjects also 404'd), but should still
      // suggest the project list command
      expect(msg).toContain("sentry project list test-org/");
      expect(msg).not.toContain("Similar projects:");
    }
  });

  test("rethrows AuthError when not authenticated", async () => {
    // No auth token set — refreshToken() will throw AuthError
    const saved = process.env.SENTRY_AUTH_TOKEN;
    delete process.env.SENTRY_AUTH_TOKEN;
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);

    try {
      await expect(fetchProjectId("test-org", "test-project")).rejects.toThrow(
        AuthError
      );
    } finally {
      if (saved !== undefined) {
        process.env.SENTRY_AUTH_TOKEN = saved;
      }
    }
  });

  test("returns undefined on transient server error", async () => {
    await setAuthToken("test-token");
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify({ detail: "Internal error" }), {
          status: 500,
        })
    );

    const result = await fetchProjectId("test-org", "test-project");
    expect(result).toBeUndefined();
  });

  test("returns cached project ID without hitting the API", async () => {
    await setAuthToken("test-token");
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);
    clearProjectCache();
    // Seed the cache via cacheProjectsForOrg (the `list:` key path) as
    // `listProjects()` does in production.
    cacheProjectsForOrg("test-org", "Test Org", [
      { id: "999", slug: "cached-project", name: "Cached Project" },
    ]);

    let apiCalled = false;
    globalThis.fetch = mockFetch(async () => {
      apiCalled = true;
      return new Response("should not be called", { status: 500 });
    });

    const result = await fetchProjectId("test-org", "cached-project");
    expect(result).toBe(999);
    expect(apiCalled).toBe(false);
  });

  test("writes the response to the project cache on a cache miss", async () => {
    await setAuthToken("test-token");
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);
    clearProjectCache();
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input, init);
      if (req.url.includes("/api/0/projects/test-org/fresh-project/")) {
        return Response.json({
          id: "1234",
          slug: "fresh-project",
          name: "Fresh Project",
          organization: {
            id: "500",
            slug: "test-org",
            name: "Test Org",
          },
        });
      }
      return new Response("Not found", { status: 404 });
    });

    await fetchProjectId("test-org", "fresh-project");

    // After the call, the cache should be populated so a subsequent call
    // skips the API entirely.
    const cached = getCachedProjectBySlug("test-org", "fresh-project");
    expect(cached).toBeDefined();
    expect(cached?.projectId).toBe("1234");
    expect(cached?.projectName).toBe("Fresh Project");
  });

  test("falls through to API when the cache has no projectId (legacy rows)", async () => {
    await setAuthToken("test-token");
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);
    clearProjectCache();
    // Seed a cache entry WITHOUT a projectId (mirrors pre-schema-v7 rows).
    setCachedProject("org-id", "proj-id", {
      orgSlug: "test-org",
      orgName: "Test Org",
      projectSlug: "legacy-project",
      projectName: "Legacy",
    });

    let apiCalled = false;
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input, init);
      if (req.url.includes("/api/0/projects/test-org/legacy-project/")) {
        apiCalled = true;
        return Response.json({ id: "777", slug: "legacy-project" });
      }
      return new Response("Not found", { status: 404 });
    });

    const result = await fetchProjectId("test-org", "legacy-project");
    expect(result).toBe(777);
    expect(apiCalled).toBe(true);
  });
});

describe("resolveTargetSlugs", () => {
  useTestConfigDir("test-resolveTargetSlugs-");

  const projectData = {
    id: "42",
    slug: "frontend",
    name: "Frontend",
    organization: { id: "1", slug: "test-org", name: "Test Org" },
  };
  const canonical = {
    org: "test-org",
    project: "frontend",
    orgDisplay: "Test Org",
    projectDisplay: "Frontend",
  };
  const requests: string[] = [];
  let originalFetch: typeof globalThis.fetch;

  function makeTarget(org: string, project: string): ResolvedTarget {
    return { org, project, orgDisplay: org, projectDisplay: project };
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    requests.length = 0;
    resetCacheState();
    disableResponseCache();
    resetAuthenticatedFetch();
    setAuthToken("test-token");
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);
    setOrgRegion("1", DEFAULT_SENTRY_URL);
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push(new URL(new Request(input, init).url).pathname);
      return Response.json(projectData);
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetCacheState();
    resetAuthenticatedFetch();
  });

  test("leaves slugs beginning with numbers unchanged without fetching", async () => {
    const target = makeTarget("2026-org", "123-api");
    expect(await resolveTargetSlugs(target)).toBe(target);
    expect(requests).toEqual([]);
  });

  test("reuses project metadata and preserves unrelated target context", async () => {
    const target = {
      ...makeTarget("1", "42"),
      projectData,
      packagePath: "packages/web",
    };
    expect(await resolveTargetSlugs(target)).toEqual({
      ...target,
      ...canonical,
    });
    expect(requests).toEqual([]);
  });

  test("keeps the same canonical target before and after the cache warms", async () => {
    for (const org of ["1", "1", "test-org"]) {
      expect(await resolveTargetSlugs(makeTarget(org, "42"))).toMatchObject(
        canonical
      );
    }
    expect(requests).toEqual(["/api/0/projects/1/42/"]);
    expect(getCachedProjectBySlug("test-org", "frontend")?.projectId).toBe(
      "42"
    );
  });

  test("reuses the metadata lookup performed by explicit target resolution", async () => {
    const projectId = await fetchProjectId("test-org", "42");
    expect(
      await resolveTargetSlugs({ ...makeTarget("test-org", "42"), projectId })
    ).toEqual({ ...canonical, projectId: 42 });
    expect(requests).toEqual(["/api/0/projects/test-org/42/"]);
  });

  test("returns canonical identity when the cache cannot be written", async () => {
    getDatabase().exec(`
      CREATE TRIGGER reject_project_cache_writes
      BEFORE INSERT ON project_cache
      BEGIN
        SELECT RAISE(FAIL, 'fixture read-only');
      END;
    `);
    expect(await resolveTargetSlugs(makeTarget("1", "42"))).toMatchObject(
      canonical
    );
  });

  test("resolves a numeric organization from its region cache", async () => {
    setOrgRegions([
      { slug: "test-org", orgId: "1", regionUrl: DEFAULT_SENTRY_URL },
    ]);
    expect(await resolveTargetSlugs(makeTarget("1", "frontend"))).toEqual(
      makeTarget("test-org", "frontend")
    );
    expect(requests).toEqual([]);
  });

  test("propagates lookup errors instead of returning unresolved IDs", async () => {
    globalThis.fetch = mockFetch(async () =>
      Response.json({ detail: "Permission denied" }, { status: 403 })
    );
    await expect(
      resolveTargetSlugs(makeTarget("test-org", "42"))
    ).rejects.toBeInstanceOf(ApiError);
  });

  test("does not return a numeric organization when metadata cannot resolve it", async () => {
    globalThis.fetch = mockFetch(async () =>
      Response.json({ ...projectData, organization: undefined })
    );
    await expect(
      resolveTargetSlugs(makeTarget("1", "42"))
    ).rejects.toBeInstanceOf(ResolutionError);
  });
});

// ============================================================================
// resolveLogProjectId — slug→id resolution tolerant of transient failures,
// used by log list/view to scope by the numeric `project` param (#1317).
// ============================================================================

describe("resolveLogProjectId", () => {
  useTestConfigDir("test-resolveLogProjectId-");

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns an all-digit slug as a numeric ID without hitting the API", async () => {
    await setAuthToken("test-token");
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);
    let apiCalled = false;
    globalThis.fetch = mockFetch(async () => {
      apiCalled = true;
      return new Response("should not be called", { status: 500 });
    });

    const result = await resolveLogProjectId("test-org", "6775615880");
    expect(result).toBe(6_775_615_880);
    expect(apiCalled).toBe(false);
  });

  test("resolves a slug to its numeric project ID", async () => {
    await setAuthToken("test-token");
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);
    clearProjectCache();
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input, init);
      if (req.url.includes("/api/0/projects/test-org/my-project/")) {
        return Response.json({ id: "456", slug: "my-project" });
      }
      return new Response("Not found", { status: 404 });
    });

    const result = await resolveLogProjectId("test-org", "my-project");
    expect(result).toBe(456);
  });

  test("returns undefined on a transient server error (falls back to slug scoping)", async () => {
    await setAuthToken("test-token");
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);
    clearProjectCache();
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify({ detail: "Internal error" }), {
          status: 500,
        })
    );

    const result = await resolveLogProjectId("test-org", "my-project");
    expect(result).toBeUndefined();
  });

  test("re-throws AuthError instead of swallowing it", async () => {
    const saved = process.env.SENTRY_AUTH_TOKEN;
    delete process.env.SENTRY_AUTH_TOKEN;
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);

    try {
      await expect(
        resolveLogProjectId("test-org", "my-project")
      ).rejects.toThrow(AuthError);
    } finally {
      if (saved !== undefined) {
        process.env.SENTRY_AUTH_TOKEN = saved;
      }
    }
  });

  test("re-throws ResolutionError on a genuine 404", async () => {
    await setAuthToken("test-token");
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);
    clearProjectCache();
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify({ detail: "Not found" }), { status: 404 })
    );

    await expect(
      resolveLogProjectId("test-org", "missing-project")
    ).rejects.toThrow(ResolutionError);
  });
});

// ============================================================================
// tryFuzzyProjectRecovery
//
// Tests the discriminated-result fuzzy recovery function. Mocks
// globalThis.fetch to control which projects the API returns per org.
// ============================================================================

describe("tryFuzzyProjectRecovery", () => {
  useTestConfigDir("test-fuzzy-recovery-");

  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    await setAuthToken("test-token");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /**
   * Build a mock fetch that responds to list-projects endpoints.
   *
   * @param projectsByOrg - Map of org slug → list of project slugs
   */
  function mockListProjects(
    projectsByOrg: Record<string, string[]>
  ): typeof fetch {
    return mockFetch(async (input, init) => {
      const req = new Request(input, init);
      const url = req.url;
      // Match /organizations/<org>/projects/
      const orgMatch = url.match(/\/organizations\/([^/]+)\/projects/);
      if (orgMatch) {
        const org = orgMatch[1] as string;
        const slugs = projectsByOrg[org];
        if (slugs) {
          const projects = slugs.map((slug, i) => ({
            id: String(i + 1),
            slug,
            name: slug,
          }));
          return Response.json(projects);
        }
      }
      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    });
  }

  test("returns 'match' when exactly one similar project exists", async () => {
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);
    globalThis.fetch = mockListProjects({
      "test-org": ["app-frontend", "app-backend", "admin-panel"],
    });

    const result = await tryFuzzyProjectRecovery("app-front", [
      { slug: "test-org" },
    ]);
    expect(result.kind).toBe("match");
    if (result.kind === "match") {
      expect(result.project).toBe("app-frontend");
      expect(result.org).toBe("test-org");
    }
  });

  test("returns 'suggestions' when multiple similar projects exist", async () => {
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);
    globalThis.fetch = mockListProjects({
      "test-org": ["app-frontend", "app-backend", "app-worker"],
    });

    const result = await tryFuzzyProjectRecovery("app", [{ slug: "test-org" }]);
    expect(result.kind).toBe("suggestions");
    if (result.kind === "suggestions") {
      expect(result.suggestions.length).toBeGreaterThan(0);
      expect(result.suggestions[0]).toContain("test-org");
    }
  });

  test("returns 'none' when no similar projects exist", async () => {
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);
    globalThis.fetch = mockListProjects({
      "test-org": ["completely-different-name"],
    });

    const result = await tryFuzzyProjectRecovery("zzz-no-match-zzz", [
      { slug: "test-org" },
    ]);
    expect(result.kind).toBe("none");
  });

  test("returns 'none' when all orgs fail to respond", async () => {
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify({ detail: "Error" }), { status: 500 })
    );

    const result = await tryFuzzyProjectRecovery("some-slug", [
      { slug: "test-org" },
    ]);
    expect(result.kind).toBe("none");
  });

  test("returns 'none' with empty orgs list", async () => {
    const result = await tryFuzzyProjectRecovery("anything", []);
    expect(result.kind).toBe("none");
  });

  test("searches across multiple orgs", async () => {
    setOrgRegion("org-alpha", DEFAULT_SENTRY_URL);
    setOrgRegion("org-beta", DEFAULT_SENTRY_URL);
    globalThis.fetch = mockListProjects({
      "org-alpha": ["web-client", "api-server"],
      "org-beta": ["mobile-app", "web-portal"],
    });

    const result = await tryFuzzyProjectRecovery("web-portal", [
      { slug: "org-alpha" },
      { slug: "org-beta" },
    ]);
    expect(result.kind).toBe("match");
    if (result.kind === "match") {
      expect(result.project).toBe("web-portal");
      expect(result.org).toBe("org-beta");
    }
  });

  test("deduplicates slugs across orgs for fuzzy matching", async () => {
    setOrgRegion("org-one", DEFAULT_SENTRY_URL);
    setOrgRegion("org-two", DEFAULT_SENTRY_URL);
    // Same project slug in two orgs — should return suggestions, not crash
    globalThis.fetch = mockListProjects({
      "org-one": ["shared-service"],
      "org-two": ["shared-service"],
    });

    const result = await tryFuzzyProjectRecovery("shared-servic", [
      { slug: "org-one" },
      { slug: "org-two" },
    ]);
    // Both orgs have the matching slug, so it returns suggestions (not a
    // single match) since there are 2 org-qualified entries
    expect(result.kind).toBe("suggestions");
  });

  test("gracefully handles partial org failures", async () => {
    setOrgRegion("good-org", DEFAULT_SENTRY_URL);
    setOrgRegion("bad-org", DEFAULT_SENTRY_URL);
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input, init);
      const url = req.url;
      if (url.includes("good-org")) {
        return Response.json([
          { id: "1", slug: "target-project", name: "target-project" },
        ]);
      }
      // bad-org returns error
      return new Response(JSON.stringify({ detail: "Error" }), { status: 500 });
    });

    const result = await tryFuzzyProjectRecovery("target-project", [
      { slug: "good-org" },
      { slug: "bad-org" },
    ]);
    expect(result.kind).toBe("match");
    if (result.kind === "match") {
      expect(result.project).toBe("target-project");
      expect(result.org).toBe("good-org");
    }
  });
});

// ============================================================================
// resolveOrgOptionalTarget — org-optional resolution for commands
// that accept org-all mode (e.g., sentry explore)
// ============================================================================

describe("resolveOrgOptionalTarget", () => {
  const getConfigDir = useTestConfigDir("test-resolve-optional-");

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Silence unmocked fetch calls — resolveEffectiveOrg catches errors and
    // returns the original slug, so a 404 is sufficient.
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify({ detail: "Not found" }), { status: 404 })
    );
    delete process.env.SENTRY_ORG;
    delete process.env.SENTRY_PROJECT;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.SENTRY_ORG;
    delete process.env.SENTRY_PROJECT;
  });

  test("org-all mode returns org without project", async () => {
    const parsed = parseOrgProjectArg("myorg/");
    expect(parsed.type).toBe("org-all");

    const result = await resolveOrgOptionalTarget(
      parsed,
      getConfigDir(),
      "explore"
    );
    expect(result.org).toBe("myorg");
    expect(result.project).toBeUndefined();
  });

  test("explicit mode returns both org and project", async () => {
    const parsed = parseOrgProjectArg("myorg/myproject");
    expect(parsed.type).toBe("explicit");

    const result = await resolveOrgOptionalTarget(
      parsed,
      getConfigDir(),
      "explore"
    );
    expect(result.org).toBe("myorg");
    expect(result.project).toBe("myproject");
  });

  test("auto-detect mode returns org only when SENTRY_ORG is set", async () => {
    process.env.SENTRY_ORG = "env-org";
    const parsed = parseOrgProjectArg(undefined);
    expect(parsed.type).toBe("auto-detect");

    const result = await resolveOrgOptionalTarget(
      parsed,
      getConfigDir(),
      "explore"
    );
    expect(result.org).toBe("env-org");
    expect(result.project).toBeUndefined();
  });

  test("auto-detect mode throws ContextError when nothing resolves", async () => {
    // No env vars, no defaults, no DSN — resolveOrg returns null
    const parsed = parseOrgProjectArg(undefined);

    await expect(
      resolveOrgOptionalTarget(parsed, getConfigDir(), "explore")
    ).rejects.toThrow(ContextError);
  });

  test("auto-detect ContextError mentions the command name", async () => {
    const parsed = parseOrgProjectArg(undefined);

    try {
      await resolveOrgOptionalTarget(parsed, getConfigDir(), "explore");
      // Should not reach here
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ContextError);
      expect((err as ContextError).message).toContain("Organization");
      expect((err as ContextError).command).toContain("explore");
    }
  });
});
