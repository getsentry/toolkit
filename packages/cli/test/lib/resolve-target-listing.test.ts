/**
 * Tests for new resolve-target listing functions
 *
 * Tests for resolveOrgsForListing, resolveProjectBoundTarget, and
 * resolveProjectBoundFromArg added in the pagination PR.
 * Uses spyOn to mock dependencies without real HTTP calls.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../src/lib/api-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/api-client.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as apiClient from "../../src/lib/api-client.js";
import { DEFAULT_SENTRY_URL } from "../../src/lib/constants.js";

vi.mock("../../src/lib/db/defaults.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/db/defaults.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as defaults from "../../src/lib/db/defaults.js";

vi.mock("../../src/lib/db/auth.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/db/auth.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as auth from "../../src/lib/db/auth.js";
import { setOrgRegion, setOrgRegions } from "../../src/lib/db/regions.js";
import { ContextError, ResolutionError } from "../../src/lib/errors.js";

vi.mock("../../src/lib/resolve-target.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/resolve-target.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as resolveTargetModule from "../../src/lib/resolve-target.js";
import {
  classifyProjectSearchTarget,
  projectSearchNotFoundSuggestions,
  resolveOrgOnlyTarget,
  resolveOrgOptionalTarget,
  resolveOrgProjectOrGuide,
  resolveOrgsForListing,
  resolveProjectBoundFromArg,
  resolveProjectBoundTarget,
  resolveProjectBoundTargets,
} from "../../src/lib/resolve-target.js";

const CWD = "/tmp/test-project";

describe("classifyProjectSearchTarget", () => {
  let findProjectsBySlugSpy: ReturnType<typeof spyOn>;
  let listProjectsSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    findProjectsBySlugSpy = vi.spyOn(apiClient, "findProjectsBySlug");
    listProjectsSpy = vi.spyOn(apiClient, "listProjects");
  });

  afterEach(() => {
    findProjectsBySlugSpy.mockRestore();
    listProjectsSpy.mockRestore();
  });

  test("prefers an exact project over an organization with the same slug", async () => {
    findProjectsBySlugSpy.mockResolvedValue({
      projects: [
        {
          id: "1",
          slug: "acme",
          name: "Acme Project",
          orgSlug: "other-org",
        },
      ],
      orgs: [
        { slug: "acme", name: "Acme Org" },
        { slug: "other-org", name: "Other Org" },
      ],
    });

    const result = await classifyProjectSearchTarget({
      type: "project-search",
      projectSlug: "acme",
    });

    expect(result.kind).toBe("projects");
  });

  test("returns an exact organization only after the project search misses", async () => {
    findProjectsBySlugSpy.mockResolvedValue({
      projects: [],
      orgs: [{ slug: "acme", name: "Acme Org" }],
    });

    const result = await classifyProjectSearchTarget({
      type: "project-search",
      projectSlug: "acme",
    });

    expect(result).toMatchObject({ kind: "organization", org: "acme" });
  });

  test("recovers one fuzzy project after exact project and org misses", async () => {
    findProjectsBySlugSpy.mockResolvedValue({
      projects: [],
      orgs: [{ slug: "acme", name: "Acme Org" }],
    });
    listProjectsSpy.mockResolvedValue([
      { id: "1", slug: "app-frontend", name: "App Frontend" },
    ]);

    const result = await classifyProjectSearchTarget({
      type: "project-search",
      projectSlug: "app-front",
    });

    expect(result).toMatchObject({
      kind: "fuzzy-project",
      org: "acme",
      project: "app-frontend",
    });
  });

  test("returns not-found after project, organization, and fuzzy misses", async () => {
    findProjectsBySlugSpy.mockResolvedValue({
      projects: [],
      orgs: [{ slug: "acme", name: "Acme Org" }],
    });
    listProjectsSpy.mockResolvedValue([]);

    const result = await classifyProjectSearchTarget({
      type: "project-search",
      projectSlug: "missing",
    });

    expect(result.kind).toBe("not-found");
  });
});

describe("projectSearchNotFoundSuggestions", () => {
  test.each([
    {
      name: "preserves fuzzy suggestions",
      scopedOrg: undefined,
      suggestions: ["Similar projects: 'acme/frontend'"],
      expected: ["Similar projects: 'acme/frontend'"],
    },
    {
      name: "describes a scoped organization miss",
      scopedOrg: "acme",
      suggestions: [],
      expected: [
        "No project with this name found in organization 'acme'",
        "Check the organization slug or try: sentry project list acme/",
      ],
    },
    {
      name: "describes an unscoped miss",
      scopedOrg: undefined,
      suggestions: [],
      expected: [
        "No project with this slug found in any accessible organization",
      ],
    },
  ])("$name", ({ scopedOrg, suggestions, expected }) => {
    expect(
      projectSearchNotFoundSuggestions({
        kind: "not-found",
        displaySlug: "missing",
        scopedOrg,
        suggestions,
      })
    ).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// resolveOrgsForListing
// ---------------------------------------------------------------------------

describe("resolveOrgsForListing", () => {
  let getDefaultOrganizationSpy: ReturnType<typeof spyOn>;
  let resolveAllTargetsSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    getDefaultOrganizationSpy = vi.spyOn(defaults, "getDefaultOrganization");
    resolveAllTargetsSpy = vi.spyOn(resolveTargetModule, "resolveAllTargets");

    getDefaultOrganizationSpy.mockReturnValue(null);
    resolveAllTargetsSpy.mockResolvedValue({ targets: [] });
  });

  afterEach(() => {
    getDefaultOrganizationSpy.mockRestore();
    resolveAllTargetsSpy.mockRestore();
  });

  test("returns explicit org when orgFlag is provided", async () => {
    const result = await resolveOrgsForListing("my-org", CWD);
    expect(result.orgs).toEqual(["my-org"]);
    // Should not consult defaults or DSN when explicit org given
    expect(getDefaultOrganizationSpy).not.toHaveBeenCalled();
  });

  test("returns default org when no orgFlag and default exists", async () => {
    getDefaultOrganizationSpy.mockReturnValue("default-org");

    const result = await resolveOrgsForListing(undefined, CWD);
    expect(result.orgs).toEqual(["default-org"]);
  });

  // Skip: resolveOrgsForListing calls resolveAllTargets internally (same-file).
  // vi.spyOn on the export doesn't intercept same-file calls in vitest.
  // These tests are covered by the Bun test suite.
  // biome-ignore lint/suspicious/noSkippedTests: vitest can't intercept same-file internal calls
  test.skip("returns unique orgs from DSN detection when no default", async () => {
    resolveAllTargetsSpy.mockResolvedValue({
      targets: [
        { org: "org-a", project: "proj-1" },
        { org: "org-a", project: "proj-2" }, // same org, different project
        { org: "org-b", project: "proj-3" },
      ],
    });

    const result = await resolveOrgsForListing(undefined, CWD);
    // Should deduplicate orgs
    expect(result.orgs).toEqual(["org-a", "org-b"]);
  });

  test("returns empty orgs when no detection results", async () => {
    resolveAllTargetsSpy.mockResolvedValue({ targets: [] });

    const result = await resolveOrgsForListing(undefined, CWD);
    expect(result.orgs).toEqual([]);
  });

  // biome-ignore lint/suspicious/noSkippedTests: vitest can't intercept same-file internal calls
  test.skip("propagates footer from DSN detection", async () => {
    resolveAllTargetsSpy.mockResolvedValue({
      targets: [
        { org: "org-a", project: "proj-1" },
        { org: "org-b", project: "proj-2" },
      ],
      footer: "Found 2 projects",
    });

    const result = await resolveOrgsForListing(undefined, CWD);
    expect(result.footer).toBe("Found 2 projects");
  });

  // biome-ignore lint/suspicious/noSkippedTests: vitest can't intercept same-file internal calls
  test.skip("propagates skippedSelfHosted from DSN detection", async () => {
    resolveAllTargetsSpy.mockResolvedValue({
      targets: [{ org: "org-a", project: "proj-1" }],
      skippedSelfHosted: 2,
    });

    const result = await resolveOrgsForListing(undefined, CWD);
    expect(result.skippedSelfHosted).toBe(2);
  });

  // biome-ignore lint/suspicious/noSkippedTests: vitest can't intercept same-file internal calls
  test.skip("returns empty orgs and propagates skippedSelfHosted when targets empty but DSNs found", async () => {
    resolveAllTargetsSpy.mockResolvedValue({
      targets: [],
      skippedSelfHosted: 3,
    });

    const result = await resolveOrgsForListing(undefined, CWD);
    expect(result.orgs).toEqual([]);
    expect(result.skippedSelfHosted).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// resolveProjectBoundTarget
// ---------------------------------------------------------------------------

describe("resolveProjectBoundTarget", () => {
  let findProjectsBySlugSpy: ReturnType<typeof spyOn>;
  let resolveOrgAndProjectSpy: ReturnType<typeof spyOn>;
  let listOrganizationsSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    findProjectsBySlugSpy = vi.spyOn(apiClient, "findProjectsBySlug");
    resolveOrgAndProjectSpy = vi.spyOn(
      resolveTargetModule,
      "resolveOrgAndProject"
    );
    // No accessible orgs by default so the authenticated account fallback in
    // resolveOrgProjectOrGuide can't resolve and makes no real HTTP calls.
    listOrganizationsSpy = vi
      .spyOn(apiClient, "listOrganizations")
      .mockResolvedValue([]);
    // Pre-populate org region cache so resolveEffectiveOrg doesn't fetch
    setOrgRegion("my-org", DEFAULT_SENTRY_URL);
  });

  afterEach(() => {
    findProjectsBySlugSpy.mockRestore();
    resolveOrgAndProjectSpy.mockRestore();
    listOrganizationsSpy.mockRestore();
  });

  test("returns org and project for explicit type", async () => {
    const parsed = {
      type: "explicit" as const,
      org: "my-org",
      project: "my-proj",
    };

    const result = await resolveProjectBoundTarget(parsed, CWD, "trace list");
    expect(result).toEqual({ org: "my-org", project: "my-proj" });
    expect(findProjectsBySlugSpy).not.toHaveBeenCalled();
  });

  test("throws ContextError for org-all type", async () => {
    const parsed = { type: "org-all" as const, org: "my-org" };

    await expect(
      resolveProjectBoundTarget(parsed, CWD, "trace list")
    ).rejects.toThrow(ContextError);
  });

  test("resolves project-search when single match found", async () => {
    findProjectsBySlugSpy.mockResolvedValue({
      projects: [{ orgSlug: "found-org", slug: "my-proj", name: "My Project" }],
      orgs: [],
    });

    const parsed = { type: "project-search" as const, projectSlug: "my-proj" };

    const result = await resolveProjectBoundTarget(parsed, CWD, "trace list");
    expect(result).toMatchObject({ org: "found-org", project: "my-proj" });
    expect(result.projectData).toBeDefined();
  });

  test("throws ResolutionError for project-search when no match", async () => {
    findProjectsBySlugSpy.mockResolvedValue({ projects: [], orgs: [] });

    const parsed = {
      type: "project-search" as const,
      projectSlug: "nonexistent",
    };

    await expect(
      resolveProjectBoundTarget(parsed, CWD, "trace list")
    ).rejects.toThrow(ResolutionError);
  });

  test("throws ResolutionError for project-search when multiple matches", async () => {
    findProjectsBySlugSpy.mockResolvedValue({
      projects: [
        { orgSlug: "org-a", slug: "my-proj", name: "My Project" },
        { orgSlug: "org-b", slug: "my-proj", name: "My Project" },
      ],
      orgs: [],
    });

    const parsed = { type: "project-search" as const, projectSlug: "my-proj" };

    await expect(
      resolveProjectBoundTarget(parsed, CWD, "trace list")
    ).rejects.toThrow(ResolutionError);
  });

  // Skip: same-file internal call — resolveProjectBoundTarget → resolveAllTargets
  // biome-ignore lint/suspicious/noSkippedTests: vitest can't intercept same-file internal calls
  test.skip("resolves auto-detect when DSN detection succeeds", async () => {
    resolveOrgAndProjectSpy.mockResolvedValue({
      org: "detected-org",
      project: "detected-proj",
      orgDisplay: "Detected Org",
      projectDisplay: "Detected Project",
    });

    const parsed = { type: "auto-detect" as const };

    const result = await resolveProjectBoundTarget(parsed, CWD, "log list");
    expect(result).toEqual({ org: "detected-org", project: "detected-proj" });
  });

  test("throws ContextError for auto-detect when no target found", async () => {
    resolveOrgAndProjectSpy.mockResolvedValue(null);

    const parsed = { type: "auto-detect" as const };

    await expect(
      resolveProjectBoundTarget(parsed, CWD, "log list")
    ).rejects.toThrow(ContextError);
  });

  test("error message for org-all includes command name and project hint", async () => {
    const parsed = { type: "org-all" as const, org: "sentry" };

    try {
      await resolveProjectBoundTarget(parsed, CWD, "trace list");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ContextError);
      expect((err as Error).message).toContain("trace list");
      expect((err as Error).message).toContain("sentry");
    }
  });

  test("throws ResolutionError when project-search slug matches an organization", async () => {
    // Lines 1017-1023: slug matches an org but no project → org-as-project error
    findProjectsBySlugSpy.mockResolvedValue({
      projects: [],
      orgs: [{ slug: "acme-corp", name: "Acme Corp" }],
    });

    const parsed = {
      type: "project-search" as const,
      projectSlug: "acme-corp",
    };

    try {
      await resolveProjectBoundTarget(parsed, CWD, "trace list");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ResolutionError);
      const msg = (err as ResolutionError).message;
      expect(msg).toContain("is an organization, not a project");
      expect(msg).toContain("acme-corp/<project>");
      expect(msg).toContain("sentry project list acme-corp/");
    }
  });
});

// ---------------------------------------------------------------------------
// resolveProjectBoundFromArg
// ---------------------------------------------------------------------------

describe("resolveProjectBoundFromArg", () => {
  let findProjectsBySlugSpy: ReturnType<typeof spyOn>;
  let resolveOrgAndProjectSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    findProjectsBySlugSpy = vi.spyOn(apiClient, "findProjectsBySlug");
    resolveOrgAndProjectSpy = vi.spyOn(
      resolveTargetModule,
      "resolveOrgAndProject"
    );
    setOrgRegion("my-org", DEFAULT_SENTRY_URL);
  });

  afterEach(() => {
    findProjectsBySlugSpy.mockRestore();
    resolveOrgAndProjectSpy.mockRestore();
  });

  test("resolves 'org/project' string to explicit target", async () => {
    const result = await resolveProjectBoundFromArg(
      "my-org/my-proj",
      CWD,
      "trace list"
    );
    expect(result).toEqual({ org: "my-org", project: "my-proj" });
  });

  test("resolves bare project slug string via project-search", async () => {
    findProjectsBySlugSpy.mockResolvedValue({
      projects: [{ orgSlug: "found-org", slug: "my-proj", name: "My Project" }],
      orgs: [],
    });

    const result = await resolveProjectBoundFromArg("my-proj", CWD, "log list");
    expect(result).toMatchObject({ org: "found-org", project: "my-proj" });
    expect(result.projectData).toBeDefined();
  });

  test("throws ContextError for 'org/' (org-all) string", async () => {
    await expect(
      resolveProjectBoundFromArg("sentry/", CWD, "trace list")
    ).rejects.toThrow(ContextError);
  });

  // Skip: same-file internal call — resolveProjectBoundFromArg → resolveAllTargets
  // biome-ignore lint/suspicious/noSkippedTests: vitest can't intercept same-file internal calls
  test.skip("resolves undefined to auto-detect", async () => {
    resolveOrgAndProjectSpy.mockResolvedValue({
      org: "auto-org",
      project: "auto-proj",
      orgDisplay: "Auto Org",
      projectDisplay: "Auto Project",
    });

    const result = await resolveProjectBoundFromArg(
      undefined,
      CWD,
      "trace list"
    );
    expect(result).toEqual({ org: "auto-org", project: "auto-proj" });
  });
});

// ---------------------------------------------------------------------------
// resolveProjectBoundTargets — org scoping & DSN-style org resolution
// ---------------------------------------------------------------------------

describe("resolveProjectBoundTargets", () => {
  let getProjectSpy: ReturnType<typeof spyOn>;
  let listProjectsSpy: ReturnType<typeof spyOn>;
  let findProjectsBySlugSpy: ReturnType<typeof spyOn>;

  const OPTS = { cwd: CWD, usageHint: "sentry issue list <org>/<project>" };

  beforeEach(() => {
    getProjectSpy = vi.spyOn(apiClient, "getProject");
    listProjectsSpy = vi.spyOn(apiClient, "listProjects");
    findProjectsBySlugSpy = vi.spyOn(apiClient, "findProjectsBySlug");
    // Seed both a normal slug and a DSN-style numeric ID mapping so
    // resolveEffectiveOrg resolves from cache without hitting the API.
    setOrgRegion("my-org", DEFAULT_SENTRY_URL);
    setOrgRegions([
      { slug: "real-org", regionUrl: DEFAULT_SENTRY_URL, orgId: "1081365" },
    ]);
  });

  afterEach(() => {
    getProjectSpy.mockRestore();
    listProjectsSpy.mockRestore();
    findProjectsBySlugSpy.mockRestore();
  });

  test("explicit: resolves DSN-style org id to the real slug", async () => {
    getProjectSpy.mockResolvedValue({ id: "42", slug: "my-proj" });

    const result = await resolveProjectBoundTargets(
      { type: "explicit", org: "o1081365", project: "my-proj" },
      OPTS
    );

    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]).toMatchObject({
      org: "real-org",
      project: "my-proj",
      projectId: 42,
    });
    // The API lookup must use the resolved slug, not the raw DSN id.
    expect(getProjectSpy).toHaveBeenCalledWith("real-org", "my-proj");
  });

  test("org-all: resolves DSN-style org id before listing projects", async () => {
    listProjectsSpy.mockResolvedValue([
      { id: "1", slug: "p1", name: "P1" },
      { id: "2", slug: "p2", name: "P2" },
    ]);

    const result = await resolveProjectBoundTargets(
      { type: "org-all", org: "o1081365" },
      OPTS
    );

    expect(listProjectsSpy).toHaveBeenCalledWith("real-org");
    expect(result.targets).toHaveLength(2);
    for (const t of result.targets) {
      expect(t.org).toBe("real-org");
    }
  });

  test("project-search: scopes recovery to explicit org, ignoring a same-slug project in another org", async () => {
    // A bare-slug lookup fans out across orgs and finds the slug in BOTH
    // org-a (the requested scope) and org-b. The result must only include
    // the org-a match — never leak org-b.
    findProjectsBySlugSpy.mockResolvedValue({
      projects: [
        { orgSlug: "org-b", slug: "my-proj", name: "My Project" },
        { orgSlug: "my-org", slug: "my-proj", name: "My Project" },
      ],
      orgs: [
        { slug: "org-b", name: "Org B" },
        { slug: "my-org", name: "My Org" },
      ],
    });

    const result = await resolveProjectBoundTargets(
      { type: "project-search", projectSlug: "my-proj", org: "my-org" },
      OPTS
    );

    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]).toMatchObject({
      org: "my-org",
      project: "my-proj",
    });
  });

  test("project-search: uses the calling command's usage hint when not found", async () => {
    findProjectsBySlugSpy.mockResolvedValue({ projects: [], orgs: [] });

    try {
      await resolveProjectBoundTargets(
        { type: "project-search", projectSlug: "missing" },
        OPTS
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError);
      expect((error as ResolutionError).hint).toBe(OPTS.usageHint);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveOrgProjectOrGuide (authenticated account fallback)
// ---------------------------------------------------------------------------

describe("resolveOrgProjectOrGuide", () => {
  let isAuthenticatedSpy: ReturnType<typeof spyOn>;
  let listOrganizationsSpy: ReturnType<typeof spyOn>;
  let listProjectsSpy: ReturnType<typeof spyOn>;
  let getDefaultOrgSpy: ReturnType<typeof spyOn>;
  let getDefaultProjectSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    isAuthenticatedSpy = vi.spyOn(auth, "isAuthenticated");
    listOrganizationsSpy = vi.spyOn(apiClient, "listOrganizations");
    listProjectsSpy = vi.spyOn(apiClient, "listProjects");
    // Force the cascade to miss config defaults so it reaches the account
    // fallback (CWD has no DSN/config either).
    getDefaultOrgSpy = vi
      .spyOn(defaults, "getDefaultOrganization")
      .mockReturnValue(null);
    getDefaultProjectSpy = vi
      .spyOn(defaults, "getDefaultProject")
      .mockReturnValue(null);
  });

  afterEach(() => {
    isAuthenticatedSpy.mockRestore();
    listOrganizationsSpy.mockRestore();
    listProjectsSpy.mockRestore();
    getDefaultOrgSpy.mockRestore();
    getDefaultProjectSpy.mockRestore();
  });

  test("auto-selects the sole org/project for a single-org account", async () => {
    isAuthenticatedSpy.mockReturnValue(true);
    listOrganizationsSpy.mockResolvedValue([
      { slug: "solo", name: "Solo Inc" },
    ]);
    listProjectsSpy.mockResolvedValue([
      { id: "42", slug: "only-proj", name: "Only Project" },
    ]);

    const result = await resolveOrgProjectOrGuide({
      cwd: CWD,
      usageHint: "sentry issue list <org>/<project>",
      interactive: false,
    });

    expect(result).toMatchObject({ org: "solo", project: "only-proj" });
  });

  test("throws a ContextError listing accessible orgs for a multi-org account", async () => {
    isAuthenticatedSpy.mockReturnValue(true);
    listOrganizationsSpy.mockResolvedValue([
      { slug: "org-a", name: "Org A" },
      { slug: "org-b", name: "Org B" },
    ]);

    try {
      await resolveOrgProjectOrGuide({
        cwd: CWD,
        usageHint: "sentry issue list <org>/<project>",
        interactive: false,
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ContextError);
      expect((err as Error).message).toContain("org-a");
      expect((err as Error).message).toContain("org-b");
    }
  });

  test("throws a generic ContextError when unauthenticated", async () => {
    isAuthenticatedSpy.mockReturnValue(false);

    await expect(
      resolveOrgProjectOrGuide({
        cwd: CWD,
        usageHint: "sentry issue list <org>/<project>",
        interactive: false,
      })
    ).rejects.toBeInstanceOf(ContextError);
    // Unauthenticated path must not attempt to list orgs.
    expect(listOrganizationsSpy).not.toHaveBeenCalled();
  });
});

describe("resolveOrgOptionalTarget bare org slug", () => {
  let findProjectsBySlugSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    findProjectsBySlugSpy = vi.spyOn(apiClient, "findProjectsBySlug");
  });

  afterEach(() => {
    findProjectsBySlugSpy.mockRestore();
  });

  test("uses the organization when no project has that slug", async () => {
    findProjectsBySlugSpy.mockResolvedValue({
      projects: [],
      orgs: [{ slug: "acme-corp", name: "Acme Corp" }],
    });

    const result = await resolveOrgOptionalTarget(
      { type: "project-search", projectSlug: "acme-corp" },
      CWD,
      "explore"
    );

    expect(result).toEqual({ org: "acme-corp" });
    expect(result.project).toBeUndefined();
    expect(findProjectsBySlugSpy).toHaveBeenCalledTimes(1);
  });

  test("org-only mode preserves its usage hint when a bare target is missing", async () => {
    findProjectsBySlugSpy.mockResolvedValue({ projects: [], orgs: [] });
    const usageHint = "sentry alert metrics create <org>/";

    try {
      await resolveOrgOnlyTarget(
        { type: "project-search", projectSlug: "missing" },
        CWD,
        "alert metrics create",
        usageHint
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError);
      expect((error as ResolutionError).hint).toBe(usageHint);
    }
  });
});
