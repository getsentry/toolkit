/**
 * Unit tests for resolve-target utilities with mocked collaborators.
 *
 * These tests use `vi.mock()` to stub out every dependency (DB caches,
 * DSN detection, api-client). This gives tight control over return values
 * at each decision point, at the cost of not exercising the real DB/HTTP
 * paths — those are covered by `resolve-target.test.ts` (real DB + mocked
 * fetch).
 *
 * Keeping this as a separate file from `resolve-target.test.ts` so the two
 * mocking strategies don't cross-contaminate: `bun test --isolate` gives
 * each file a fresh module graph, so the mocks here don't leak into the
 * real-DB integration tests.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Import the real formatMultipleProjectsFooter from its source file (not the
// barrel dsn/index.js), then pass it through the mock below so the mocked
// barrel still returns the real implementation for this export.
import { formatMultipleProjectsFooter } from "../../src/lib/dsn/errors.js";

// ============================================================================
// Mock Setup - All dependency modules mocked before importing resolve-target
// ============================================================================

// Mock functions we'll control in tests
const {
  mockGetDefaultOrganization,
  mockGetDefaultProject,
  mockDetectDsn,
  mockDetectAllDsns,
  mockFindProjectRoot,
  mockGetDsnSourceDescription,
  mockGetCachedProject,
  mockSetCachedProject,
  mockGetCachedProjectByDsnKey,
  mockSetCachedProjectByDsnKey,
  mockGetCachedDsn,
  mockSetCachedDsn,
  mockGetProject,
  mockFindProjectByDsnKey,
  mockFindProjectsByPattern,
  mockListOrganizationsUncached,
  mockGetOrgByNumericId,
} = vi.hoisted(() => ({
  mockGetDefaultOrganization: vi.fn(() => null),
  mockGetDefaultProject: vi.fn(() => null),
  mockDetectDsn: vi.fn(() => Promise.resolve(null)),
  mockDetectAllDsns: vi.fn(() =>
    Promise.resolve({
      primary: null,
      all: [],
      hasMultiple: false,
      fingerprint: "",
    })
  ),
  mockFindProjectRoot: vi.fn(() =>
    Promise.resolve({
      projectRoot: "/test/project",
      detectedFrom: "package.json",
    })
  ),
  mockGetDsnSourceDescription: vi.fn(() => "SENTRY_DSN environment variable"),
  mockGetCachedProject: vi.fn(() => null),
  mockSetCachedProject: vi.fn(() => {
    /* no-op */
  }),
  mockGetCachedProjectByDsnKey: vi.fn(() => null),
  mockSetCachedProjectByDsnKey: vi.fn(() => {
    /* no-op */
  }),
  mockGetCachedDsn: vi.fn(() => null),
  mockSetCachedDsn: vi.fn(() => {
    /* no-op */
  }),
  mockGetProject: vi.fn(() => Promise.resolve({ slug: "test", name: "Test" })),
  mockFindProjectByDsnKey: vi.fn(() => Promise.resolve(null)),
  mockFindProjectsByPattern: vi.fn(() => Promise.resolve([])),
  mockListOrganizationsUncached: vi.fn(() => Promise.resolve([])),
  mockGetOrgByNumericId: vi.fn(
    () => undefined as { slug: string; regionUrl: string } | undefined
  ),
}));

// Mock all dependency modules
vi.mock("../../src/lib/db/defaults.js", () => ({
  getDefaultOrganization: mockGetDefaultOrganization,
  getDefaultProject: mockGetDefaultProject,
}));

// Bun's vi.mock() replaces the ENTIRE barrel module. Since resolve-target.ts
// imports formatMultipleProjectsFooter from dsn/index.js, we must include it here.
// We pass through the real function (imported above from dsn/errors.js) rather than
// a stub, because Bun leaks vi.mock() state across test files in the same run
// and a simplified stub would break tests in dsn/errors.test.ts.
vi.mock("../../src/lib/dsn/index.js", () => ({
  detectDsn: mockDetectDsn,
  detectAllDsns: mockDetectAllDsns,
  findProjectRoot: mockFindProjectRoot,
  getDsnSourceDescription: mockGetDsnSourceDescription,
  formatMultipleProjectsFooter,
}));

vi.mock("../../src/lib/db/project-cache.js", () => ({
  getCachedProject: mockGetCachedProject,
  setCachedProject: mockSetCachedProject,
  getCachedProjectByDsnKey: mockGetCachedProjectByDsnKey,
  setCachedProjectByDsnKey: mockSetCachedProjectByDsnKey,
}));

vi.mock("../../src/lib/db/dsn-cache.js", () => ({
  getCachedDsn: mockGetCachedDsn,
  setCachedDsn: mockSetCachedDsn,
}));

vi.mock("../../src/lib/db/regions.js", () => ({
  getOrgByNumericId: mockGetOrgByNumericId,
  getOrgRegion: vi.fn(() => {
    /* returns undefined */
  }),
  setOrgRegion: vi.fn(() => {
    /* no-op */
  }),
  setOrgRegions: vi.fn(() => {
    /* no-op */
  }),
  clearOrgRegions: vi.fn(() => {
    /* no-op */
  }),
  getAllOrgRegions: vi.fn(() => new Map()),
  getCachedOrganizations: vi.fn(() => []),
  getCachedOrgRole: vi.fn(() => {
    /* returns undefined */
  }),
  disableOrgCache: vi.fn(() => {
    /* no-op */
  }),
  enableOrgCache: vi.fn(() => {
    /* no-op */
  }),
}));

vi.mock("../../src/lib/api-client.js", () => ({
  getProject: mockGetProject,
  findProjectByDsnKey: mockFindProjectByDsnKey,
  findProjectsByPattern: mockFindProjectsByPattern,
  findProjectsBySlug: vi.fn(() => Promise.resolve({ projects: [], orgs: [] })),
  listOrganizations: vi.fn(() => Promise.resolve([])),
  listOrganizationsUncached: mockListOrganizationsUncached,
  listProjects: vi.fn(() => Promise.resolve([])),
  resolveOrgDisplayName: vi.fn((slug: string, name?: string) => name ?? slug),
}));

import { ContextError } from "../../src/lib/errors.js";
// Now import the module under test (after mocks are set up)
import {
  resolveAllTargets,
  resolveFromDsn,
  resolveOrg,
  resolveOrgAndProject,
  resolveOrgsForListing,
} from "../../src/lib/resolve-target.js";

/** Reset all mocks between tests */
function resetAllMocks() {
  mockGetDefaultOrganization.mockReset();
  mockGetDefaultProject.mockReset();
  mockDetectDsn.mockReset();
  mockDetectAllDsns.mockReset();
  mockFindProjectRoot.mockReset();
  mockGetDsnSourceDescription.mockReset();
  mockGetCachedProject.mockReset();
  mockSetCachedProject.mockReset();
  mockGetCachedProjectByDsnKey.mockReset();
  mockSetCachedProjectByDsnKey.mockReset();
  mockGetCachedDsn.mockReset();
  mockSetCachedDsn.mockReset();
  mockGetProject.mockReset();
  mockFindProjectByDsnKey.mockReset();
  mockFindProjectsByPattern.mockReset();
  mockListOrganizationsUncached.mockReset();
  mockGetOrgByNumericId.mockReset();

  // Set sensible defaults
  mockGetDefaultOrganization.mockReturnValue(null);
  mockGetDefaultProject.mockReturnValue(null);
  mockDetectDsn.mockResolvedValue(null);
  mockDetectAllDsns.mockResolvedValue({
    primary: null,
    all: [],
    hasMultiple: false,
    fingerprint: "",
  });
  mockFindProjectRoot.mockResolvedValue({
    projectRoot: "/test/project",
    detectedFrom: "package.json",
  });
  mockGetDsnSourceDescription.mockReturnValue(
    "SENTRY_DSN environment variable"
  );
  mockGetCachedProject.mockReturnValue(null);
  mockGetCachedProjectByDsnKey.mockReturnValue(null);
  mockGetCachedDsn.mockReturnValue(null);
  mockFindProjectsByPattern.mockResolvedValue([]);
  mockListOrganizationsUncached.mockResolvedValue([]);
  mockGetOrgByNumericId.mockReturnValue(undefined);
}

// ============================================================================
// resolveOrg Tests
// ============================================================================

describe("resolveOrg", () => {
  beforeEach(() => {
    resetAllMocks();
  });

  test("returns org from CLI flag when provided", async () => {
    const result = await resolveOrg({ org: "my-org", cwd: "/test" });

    expect(result).not.toBeNull();
    expect(result?.org).toBe("my-org");
    // Should not call any other resolution methods
    expect(mockGetDefaultOrganization).not.toHaveBeenCalled();
    expect(mockDetectDsn).not.toHaveBeenCalled();
  });

  test("returns org from config defaults when no CLI flag", async () => {
    mockGetDefaultOrganization.mockReturnValue("default-org");

    const result = await resolveOrg({ cwd: "/test" });

    expect(result).not.toBeNull();
    expect(result?.org).toBe("default-org");
    expect(mockGetDefaultOrganization).toHaveBeenCalled();
    expect(mockDetectDsn).not.toHaveBeenCalled();
  });

  test("falls back to DSN detection when no flag or defaults", async () => {
    mockGetDefaultOrganization.mockReturnValue(null);
    mockDetectDsn.mockResolvedValue({
      raw: "https://abc@o123.ingest.sentry.io/456",
      protocol: "https",
      publicKey: "abc",
      host: "o123.ingest.sentry.io",
      projectId: "456",
      orgId: "123",
      source: "env",
    });
    mockGetCachedProject.mockReturnValue({
      orgSlug: "cached-org",
      orgName: "Cached Organization",
      projectSlug: "project",
      projectName: "Project",
    });

    const result = await resolveOrg({ cwd: "/test" });

    expect(result).not.toBeNull();
    expect(result?.org).toBe("cached-org");
    expect(mockGetDefaultOrganization).toHaveBeenCalled();
    expect(mockDetectDsn).toHaveBeenCalled();
  });

  test("returns numeric orgId when DSN detected but no cache", async () => {
    mockGetDefaultOrganization.mockReturnValue(null);
    mockDetectDsn.mockResolvedValue({
      raw: "https://abc@o123.ingest.sentry.io/456",
      protocol: "https",
      publicKey: "abc",
      host: "o123.ingest.sentry.io",
      projectId: "456",
      orgId: "123",
      source: "env",
    });
    mockGetCachedProject.mockReturnValue(null);

    const result = await resolveOrg({ cwd: "/test" });

    expect(result).not.toBeNull();
    expect(result?.org).toBe("123");
  });

  test("normalizes numeric orgId to slug via DB cache", async () => {
    mockGetDefaultOrganization.mockReturnValue(null);
    mockDetectDsn.mockResolvedValue({
      raw: "https://abc@o1169445.ingest.us.sentry.io/456",
      protocol: "https",
      publicKey: "abc",
      host: "o1169445.ingest.us.sentry.io",
      projectId: "456",
      orgId: "1169445",
      source: "env",
    });
    mockGetCachedProject.mockReturnValue(null);
    mockGetOrgByNumericId.mockReturnValue({
      slug: "my-org",
      regionUrl: "https://us.sentry.io",
    });

    const result = await resolveOrg({ cwd: "/test" });

    expect(result).not.toBeNull();
    expect(result?.org).toBe("my-org");
    expect(mockGetOrgByNumericId).toHaveBeenCalledWith("1169445");
  });

  test("normalizes numeric orgId via API when DB cache misses", async () => {
    mockGetDefaultOrganization.mockReturnValue(null);
    mockDetectDsn.mockResolvedValue({
      raw: "https://abc@o1169445.ingest.us.sentry.io/456",
      protocol: "https",
      publicKey: "abc",
      host: "o1169445.ingest.us.sentry.io",
      projectId: "456",
      orgId: "1169445",
      source: "env",
    });
    mockGetCachedProject.mockReturnValue(null);

    // First call returns undefined (cache miss), second call returns slug
    // (after listOrganizationsUncached populates the cache)
    let callCount = 0;
    mockGetOrgByNumericId.mockImplementation(() => {
      callCount += 1;
      if (callCount >= 2) {
        return { slug: "my-org", regionUrl: "https://us.sentry.io" };
      }
      return;
    });
    mockListOrganizationsUncached.mockResolvedValue([]);

    const result = await resolveOrg({ cwd: "/test" });

    expect(result).not.toBeNull();
    expect(result?.org).toBe("my-org");
    expect(mockListOrganizationsUncached).toHaveBeenCalled();
  });

  test("skips normalization for non-numeric org slug from DSN cache", async () => {
    mockGetDefaultOrganization.mockReturnValue(null);
    mockDetectDsn.mockResolvedValue({
      raw: "https://abc@o123.ingest.sentry.io/456",
      protocol: "https",
      publicKey: "abc",
      host: "o123.ingest.sentry.io",
      projectId: "456",
      orgId: "123",
      source: "env",
    });
    mockGetCachedProject.mockReturnValue({
      orgSlug: "cached-org",
      orgName: "Cached Organization",
      projectSlug: "project",
      projectName: "Project",
    });

    const result = await resolveOrg({ cwd: "/test" });

    expect(result).not.toBeNull();
    expect(result?.org).toBe("cached-org");
    // getOrgByNumericId should not be called because "cached-org" is not all digits
    expect(mockGetOrgByNumericId).not.toHaveBeenCalled();
  });

  test("returns null when no org found from any source", async () => {
    mockGetDefaultOrganization.mockReturnValue(null);
    mockDetectDsn.mockResolvedValue(null);

    const result = await resolveOrg({ cwd: "/test" });

    expect(result).toBeNull();
  });

  test("returns null when DSN has no orgId", async () => {
    mockGetDefaultOrganization.mockReturnValue(null);
    mockDetectDsn.mockResolvedValue({
      raw: "https://abc@sentry.io/456",
      protocol: "https",
      publicKey: "abc",
      host: "sentry.io",
      projectId: "456",
      // No orgId - self-hosted DSN
      source: "env",
    });

    const result = await resolveOrg({ cwd: "/test" });

    expect(result).toBeNull();
  });

  test("returns null when DSN detection throws", async () => {
    mockGetDefaultOrganization.mockReturnValue(null);
    mockDetectDsn.mockRejectedValue(new Error("Detection failed"));

    const result = await resolveOrg({ cwd: "/test" });

    expect(result).toBeNull();
  });
});

// ============================================================================
// resolveFromDsn Tests
// ============================================================================

describe("resolveFromDsn", () => {
  beforeEach(() => {
    resetAllMocks();
  });

  test("returns null when no DSN detected", async () => {
    mockDetectDsn.mockResolvedValue(null);

    const result = await resolveFromDsn("/test");

    expect(result).toBeNull();
  });

  test("returns null when DSN has no orgId", async () => {
    mockDetectDsn.mockResolvedValue({
      raw: "https://abc@sentry.io/456",
      protocol: "https",
      publicKey: "abc",
      host: "sentry.io",
      projectId: "456",
      source: "env",
    });

    const result = await resolveFromDsn("/test");

    expect(result).toBeNull();
  });

  test("returns null when DSN has no projectId", async () => {
    mockDetectDsn.mockResolvedValue({
      raw: "https://abc@o123.ingest.sentry.io/",
      protocol: "https",
      publicKey: "abc",
      host: "o123.ingest.sentry.io",
      orgId: "123",
      source: "env",
    });

    const result = await resolveFromDsn("/test");

    expect(result).toBeNull();
  });

  test("returns cached project info when available", async () => {
    mockDetectDsn.mockResolvedValue({
      raw: "https://abc@o123.ingest.sentry.io/456",
      protocol: "https",
      publicKey: "abc",
      host: "o123.ingest.sentry.io",
      projectId: "456",
      orgId: "123",
      source: "env",
      sourcePath: "/test/.env",
    });
    mockGetCachedProject.mockReturnValue({
      orgSlug: "cached-org",
      orgName: "Cached Organization",
      projectSlug: "cached-project",
      projectName: "Cached Project",
    });

    const result = await resolveFromDsn("/test");

    expect(result).not.toBeNull();
    expect(result?.org).toBe("cached-org");
    expect(result?.project).toBe("cached-project");
    expect(result?.orgDisplay).toBe("Cached Organization");
    expect(result?.projectDisplay).toBe("Cached Project");
    expect(mockGetCachedProject).toHaveBeenCalledWith("123", "456");
  });

  test("uses resolution surfaced by the detector without any API call", async () => {
    mockDetectDsn.mockResolvedValue({
      raw: "https://abc@o123.ingest.sentry.io/456",
      protocol: "https",
      publicKey: "abc",
      host: "o123.ingest.sentry.io",
      projectId: "456",
      orgId: "123",
      source: "env",
      resolved: {
        orgSlug: "detected-org",
        orgName: "Detected Organization",
        projectSlug: "detected-project",
        projectName: "Detected Project",
      },
    });

    const result = await resolveFromDsn("/test");

    expect(result?.org).toBe("detected-org");
    expect(result?.project).toBe("detected-project");
    expect(result?.orgDisplay).toBe("Detected Organization");
    expect(result?.projectDisplay).toBe("Detected Project");
    // DSN already encodes identity — no discovery call and no cache lookup.
    expect(mockGetProject).not.toHaveBeenCalled();
    expect(mockGetCachedProject).not.toHaveBeenCalled();
  });

  test("skips org/project discovery on cache miss when DSN encodes identity", async () => {
    mockDetectDsn.mockResolvedValue({
      raw: "https://abc@o123.ingest.sentry.io/456",
      protocol: "https",
      publicKey: "abc",
      host: "o123.ingest.sentry.io",
      projectId: "456",
      orgId: "123",
      source: "env",
      sourcePath: "/test/.env",
    });
    mockGetCachedProject.mockReturnValue(null);

    const result = await resolveFromDsn("/test");

    // No getProject discovery call — the numeric IDs from the DSN are used
    // directly (the API accepts them as org/project identifiers).
    expect(mockGetProject).not.toHaveBeenCalled();
    expect(result?.org).toBe("123");
    expect(result?.project).toBe("456");
    expect(result?.projectId).toBe(456);
  });

  test("enriches org slug from the local regions cache without an API call", async () => {
    mockDetectDsn.mockResolvedValue({
      raw: "https://abc@o1169445.ingest.us.sentry.io/456",
      protocol: "https",
      publicKey: "abc",
      host: "o1169445.ingest.us.sentry.io",
      projectId: "456",
      orgId: "1169445",
      source: "env",
    });
    mockGetCachedProject.mockReturnValue(null);
    mockGetOrgByNumericId.mockReturnValue({
      slug: "my-org",
      regionUrl: "https://us.sentry.io",
    });

    const result = await resolveFromDsn("/test");

    expect(result?.org).toBe("my-org");
    expect(result?.orgDisplay).toBe("my-org");
    expect(result?.project).toBe("456");
    expect(mockGetProject).not.toHaveBeenCalled();
    expect(mockGetOrgByNumericId).toHaveBeenCalledWith("1169445");
  });
});

// ============================================================================
// resolveOrgAndProject Tests
// ============================================================================

describe("resolveOrgAndProject", () => {
  beforeEach(() => {
    resetAllMocks();
  });

  test("returns target from CLI flags when both provided", async () => {
    const result = await resolveOrgAndProject({
      org: "my-org",
      project: "my-project",
      cwd: "/test",
    });

    expect(result).not.toBeNull();
    expect(result?.org).toBe("my-org");
    expect(result?.project).toBe("my-project");
    expect(result?.orgDisplay).toBe("my-org");
    expect(result?.projectDisplay).toBe("my-project");
    // Should not call any detection methods
    expect(mockGetDefaultOrganization).not.toHaveBeenCalled();
    expect(mockDetectDsn).not.toHaveBeenCalled();
  });

  test("throws ContextError when only org provided", async () => {
    await expect(
      resolveOrgAndProject({ org: "my-org", cwd: "/test" })
    ).rejects.toThrow(ContextError);
  });

  test("throws ContextError when only project provided", async () => {
    await expect(
      resolveOrgAndProject({ project: "my-project", cwd: "/test" })
    ).rejects.toThrow(ContextError);
  });

  test("returns target from config defaults when no flags", async () => {
    mockGetDefaultOrganization.mockReturnValue("default-org");
    mockGetDefaultProject.mockReturnValue("default-project");

    const result = await resolveOrgAndProject({ cwd: "/test" });

    expect(result).not.toBeNull();
    expect(result?.org).toBe("default-org");
    expect(result?.project).toBe("default-project");
    expect(mockGetDefaultOrganization).toHaveBeenCalled();
    expect(mockGetDefaultProject).toHaveBeenCalled();
  });

  test("falls back to DSN detection when no flags or defaults", async () => {
    mockGetDefaultOrganization.mockReturnValue(null);
    mockGetDefaultProject.mockReturnValue(null);
    mockDetectDsn.mockResolvedValue({
      raw: "https://abc@o123.ingest.sentry.io/456",
      protocol: "https",
      publicKey: "abc",
      host: "o123.ingest.sentry.io",
      projectId: "456",
      orgId: "123",
      source: "env",
    });
    mockGetCachedProject.mockReturnValue({
      orgSlug: "dsn-org",
      orgName: "DSN Org",
      projectSlug: "dsn-project",
      projectName: "DSN Project",
    });

    const result = await resolveOrgAndProject({ cwd: "/test" });

    expect(result).not.toBeNull();
    expect(result?.org).toBe("dsn-org");
    expect(result?.project).toBe("dsn-project");
  });

  test("falls back to directory inference when DSN detection fails", async () => {
    mockGetDefaultOrganization.mockReturnValue(null);
    mockGetDefaultProject.mockReturnValue(null);
    mockDetectDsn.mockResolvedValue(null);
    mockFindProjectRoot.mockResolvedValue({
      projectRoot: "/home/user/my-project",
      detectedFrom: "package.json",
    });
    mockFindProjectsByPattern.mockResolvedValue([
      {
        id: "789",
        slug: "my-project",
        name: "My Project",
        orgSlug: "inferred-org",
        organization: { id: "1", slug: "inferred-org", name: "Inferred Org" },
      },
    ]);

    const result = await resolveOrgAndProject({ cwd: "/home/user/my-project" });

    expect(result).not.toBeNull();
    expect(result?.org).toBe("inferred-org");
    expect(result?.project).toBe("my-project");
  });

  test("returns null when no resolution method succeeds", async () => {
    mockGetDefaultOrganization.mockReturnValue(null);
    mockGetDefaultProject.mockReturnValue(null);
    mockDetectDsn.mockResolvedValue(null);
    // Short directory name that won't match
    mockFindProjectRoot.mockResolvedValue({
      projectRoot: "/home/user/ab",
      detectedFrom: "package.json",
    });
    mockFindProjectsByPattern.mockResolvedValue([]);

    const result = await resolveOrgAndProject({ cwd: "/home/user/ab" });

    expect(result).toBeNull();
  });
});

// ============================================================================
// resolveAllTargets Tests
// ============================================================================

describe("resolveAllTargets", () => {
  beforeEach(() => {
    resetAllMocks();
  });

  test("returns single target from CLI flags", async () => {
    const result = await resolveAllTargets({
      org: "my-org",
      project: "my-project",
      cwd: "/test",
    });

    expect(result.targets).toHaveLength(1);
    expect(result.targets[0].org).toBe("my-org");
    expect(result.targets[0].project).toBe("my-project");
  });

  test("throws ContextError when only org provided", async () => {
    await expect(
      resolveAllTargets({ org: "my-org", cwd: "/test" })
    ).rejects.toThrow(ContextError);
  });

  test("returns single target from config defaults", async () => {
    mockGetDefaultOrganization.mockReturnValue("default-org");
    mockGetDefaultProject.mockReturnValue("default-project");

    const result = await resolveAllTargets({ cwd: "/test" });

    expect(result.targets).toHaveLength(1);
    expect(result.targets[0].org).toBe("default-org");
    expect(result.targets[0].project).toBe("default-project");
  });

  test("resolves multiple DSNs in monorepo", async () => {
    mockGetDefaultOrganization.mockReturnValue(null);
    mockGetDefaultProject.mockReturnValue(null);
    mockDetectAllDsns.mockResolvedValue({
      primary: {
        raw: "https://abc@o123.ingest.sentry.io/456",
        protocol: "https",
        publicKey: "abc",
        host: "o123.ingest.sentry.io",
        projectId: "456",
        orgId: "123",
        source: "env-file",
        sourcePath: "/test/monorepo/packages/frontend/.env",
      },
      all: [
        {
          raw: "https://abc@o123.ingest.sentry.io/456",
          protocol: "https",
          publicKey: "abc",
          host: "o123.ingest.sentry.io",
          projectId: "456",
          orgId: "123",
          source: "env-file",
          sourcePath: "/test/monorepo/packages/frontend/.env",
        },
        {
          raw: "https://def@o123.ingest.sentry.io/789",
          protocol: "https",
          publicKey: "def",
          host: "o123.ingest.sentry.io",
          projectId: "789",
          orgId: "123",
          source: "env-file",
          sourcePath: "/test/monorepo/packages/backend/.env",
        },
      ],
      hasMultiple: true,
      fingerprint: "abc-def",
    });
    mockGetCachedProject
      .mockReturnValueOnce({
        orgSlug: "my-org",
        orgName: "My Org",
        projectSlug: "frontend",
        projectName: "Frontend",
      })
      .mockReturnValueOnce({
        orgSlug: "my-org",
        orgName: "My Org",
        projectSlug: "backend",
        projectName: "Backend",
      });
    mockGetDsnSourceDescription
      .mockReturnValueOnce("packages/frontend/.env")
      .mockReturnValueOnce("packages/backend/.env");

    const result = await resolveAllTargets({ cwd: "/test/monorepo" });

    expect(result.targets).toHaveLength(2);
    expect(result.targets[0].org).toBe("my-org");
    expect(result.targets[0].project).toBe("frontend");
    expect(result.targets[1].org).toBe("my-org");
    expect(result.targets[1].project).toBe("backend");
  });

  test("deduplicates targets with same org+project", async () => {
    mockGetDefaultOrganization.mockReturnValue(null);
    mockGetDefaultProject.mockReturnValue(null);
    mockDetectAllDsns.mockResolvedValue({
      primary: {
        raw: "https://abc@o123.ingest.sentry.io/456",
        protocol: "https",
        publicKey: "abc",
        host: "o123.ingest.sentry.io",
        projectId: "456",
        orgId: "123",
        source: "env-file",
        sourcePath: "/test/.env",
      },
      all: [
        {
          raw: "https://abc@o123.ingest.sentry.io/456",
          protocol: "https",
          publicKey: "abc",
          host: "o123.ingest.sentry.io",
          projectId: "456",
          orgId: "123",
          source: "env-file",
          sourcePath: "/test/.env",
        },
        {
          raw: "https://abc@o123.ingest.sentry.io/456",
          protocol: "https",
          publicKey: "abc",
          host: "o123.ingest.sentry.io",
          projectId: "456",
          orgId: "123",
          source: "env",
          // Same DSN from different source
        },
      ],
      hasMultiple: true,
      fingerprint: "abc-abc",
    });
    mockGetCachedProject.mockReturnValue({
      orgSlug: "my-org",
      orgName: "My Org",
      projectSlug: "my-project",
      projectName: "My Project",
    });

    const result = await resolveAllTargets({ cwd: "/test" });

    // Should be deduplicated to single target
    expect(result.targets).toHaveLength(1);
  });

  test("falls back to directory inference when no DSNs detected", async () => {
    mockGetDefaultOrganization.mockReturnValue(null);
    mockGetDefaultProject.mockReturnValue(null);
    mockDetectAllDsns.mockResolvedValue({
      primary: null,
      all: [],
      hasMultiple: false,
      fingerprint: "",
    });
    mockFindProjectRoot.mockResolvedValue({
      projectRoot: "/home/user/my-app",
      detectedFrom: "package.json",
    });
    mockFindProjectsByPattern.mockResolvedValue([
      {
        id: "789",
        slug: "my-app",
        name: "My App",
        orgSlug: "inferred-org",
        organization: { id: "1", slug: "inferred-org", name: "Inferred Org" },
      },
    ]);

    const result = await resolveAllTargets({ cwd: "/home/user/my-app" });

    expect(result.targets).toHaveLength(1);
    expect(result.targets[0].org).toBe("inferred-org");
    expect(result.targets[0].project).toBe("my-app");
  });

  test("returns empty targets when a public-key DSN cannot be resolved", async () => {
    mockGetDefaultOrganization.mockReturnValue(null);
    mockGetDefaultProject.mockReturnValue(null);
    // Self-hosted / public-key-only DSN (no orgId) — the DSN does not encode
    // org identity, so a lookup is required and can fail.
    mockDetectAllDsns.mockResolvedValue({
      primary: {
        raw: "https://abc@sentry.example.com/456",
        protocol: "https",
        publicKey: "abc",
        host: "sentry.example.com",
        projectId: "456",
        source: "env",
      },
      all: [
        {
          raw: "https://abc@sentry.example.com/456",
          protocol: "https",
          publicKey: "abc",
          host: "sentry.example.com",
          projectId: "456",
          source: "env",
        },
      ],
      hasMultiple: false,
      fingerprint: "",
    });
    mockGetCachedProjectByDsnKey.mockReturnValue(null);
    // findProjectByDsnKey returns null (project not found)
    mockFindProjectByDsnKey.mockResolvedValue(null);
    mockFindProjectRoot.mockResolvedValue({
      projectRoot: "/a",
      detectedFrom: "package.json",
    });

    const result = await resolveAllTargets({ cwd: "/test" });

    expect(result.targets).toHaveLength(0);
  });

  test("skips discovery for orgId DSNs and resolves from numeric IDs", async () => {
    mockGetDefaultOrganization.mockReturnValue(null);
    mockGetDefaultProject.mockReturnValue(null);
    mockDetectAllDsns.mockResolvedValue({
      primary: {
        raw: "https://abc@o123.ingest.sentry.io/456",
        protocol: "https",
        publicKey: "abc",
        host: "o123.ingest.sentry.io",
        projectId: "456",
        orgId: "123",
        source: "env",
      },
      all: [
        {
          raw: "https://abc@o123.ingest.sentry.io/456",
          protocol: "https",
          publicKey: "abc",
          host: "o123.ingest.sentry.io",
          projectId: "456",
          orgId: "123",
          source: "env",
        },
      ],
      hasMultiple: false,
      fingerprint: "",
    });
    mockGetCachedProject.mockReturnValue(null);

    const result = await resolveAllTargets({ cwd: "/test" });

    expect(result.targets).toHaveLength(1);
    expect(result.targets[0].org).toBe("123");
    expect(result.targets[0].project).toBe("456");
    // The DSN already identifies the target — no discovery API call.
    expect(mockGetProject).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Environment Variable Resolution Tests (SENTRY_ORG / SENTRY_PROJECT)
// ============================================================================

describe("env var resolution: SENTRY_ORG + SENTRY_PROJECT", () => {
  beforeEach(() => {
    resetAllMocks();
  });

  afterEach(() => {
    delete process.env.SENTRY_ORG;
    delete process.env.SENTRY_PROJECT;
  });

  // --- resolveOrg ---

  test("resolveOrg: returns org from SENTRY_ORG when no CLI flag", async () => {
    process.env.SENTRY_ORG = "env-org";

    const result = await resolveOrg({ cwd: "/test" });

    expect(result).not.toBeNull();
    expect(result?.org).toBe("env-org");
    // Env vars take priority over config defaults
    expect(mockGetDefaultOrganization).not.toHaveBeenCalled();
  });

  test("resolveOrg: CLI flag takes priority over env var", async () => {
    process.env.SENTRY_ORG = "env-org";

    const result = await resolveOrg({ org: "flag-org", cwd: "/test" });

    expect(result?.org).toBe("flag-org");
  });

  test("resolveOrg: SENTRY_PROJECT=org/project combo provides org", async () => {
    process.env.SENTRY_PROJECT = "combo-org/combo-project";

    const result = await resolveOrg({ cwd: "/test" });

    expect(result?.org).toBe("combo-org");
  });

  test("resolveOrg: combo SENTRY_PROJECT overrides SENTRY_ORG", async () => {
    process.env.SENTRY_ORG = "env-org";
    process.env.SENTRY_PROJECT = "combo-org/combo-project";

    const result = await resolveOrg({ cwd: "/test" });

    // The combo form should win because resolveFromEnvVars returns combo-org
    expect(result?.org).toBe("combo-org");
  });

  // --- resolveOrgAndProject ---

  test("resolveOrgAndProject: uses SENTRY_ORG + SENTRY_PROJECT", async () => {
    process.env.SENTRY_ORG = "env-org";
    process.env.SENTRY_PROJECT = "env-project";

    const result = await resolveOrgAndProject({ cwd: "/test" });

    expect(result).not.toBeNull();
    expect(result?.org).toBe("env-org");
    expect(result?.project).toBe("env-project");
    expect(result?.detectedFrom).toContain("env var");
    // Should not fall through to defaults or DSN detection
    expect(mockGetDefaultOrganization).not.toHaveBeenCalled();
    expect(mockDetectDsn).not.toHaveBeenCalled();
  });

  test("resolveOrgAndProject: SENTRY_PROJECT=org/project combo works", async () => {
    process.env.SENTRY_PROJECT = "my-org/my-project";

    const result = await resolveOrgAndProject({ cwd: "/test" });

    expect(result).not.toBeNull();
    expect(result?.org).toBe("my-org");
    expect(result?.project).toBe("my-project");
    expect(result?.detectedFrom).toContain("SENTRY_PROJECT");
  });

  test("resolveOrgAndProject: CLI flags take priority over env vars", async () => {
    process.env.SENTRY_ORG = "env-org";
    process.env.SENTRY_PROJECT = "env-project";

    const result = await resolveOrgAndProject({
      org: "flag-org",
      project: "flag-project",
      cwd: "/test",
    });

    expect(result?.org).toBe("flag-org");
    expect(result?.project).toBe("flag-project");
  });

  test("resolveOrgAndProject: SENTRY_ORG alone (no project) falls through", async () => {
    process.env.SENTRY_ORG = "env-org";
    // No SENTRY_PROJECT — resolveFromEnvVars returns org-only, but
    // resolveOrgAndProject requires project, so it falls through

    const result = await resolveOrgAndProject({ cwd: "/test" });

    // Falls through to defaults (which are null), then DSN, then dir inference
    expect(result).toBeNull();
  });

  test("resolveOrgAndProject: env vars beat config defaults", async () => {
    process.env.SENTRY_ORG = "env-org";
    process.env.SENTRY_PROJECT = "env-project";
    mockGetDefaultOrganization.mockReturnValue("default-org");
    mockGetDefaultProject.mockReturnValue("default-project");

    const result = await resolveOrgAndProject({ cwd: "/test" });

    expect(result?.org).toBe("env-org");
    expect(result?.project).toBe("env-project");
    // Config defaults should not have been checked
    expect(mockGetDefaultOrganization).not.toHaveBeenCalled();
  });

  // --- resolveAllTargets ---

  test("resolveAllTargets: uses SENTRY_ORG + SENTRY_PROJECT", async () => {
    process.env.SENTRY_ORG = "env-org";
    process.env.SENTRY_PROJECT = "env-project";

    const result = await resolveAllTargets({ cwd: "/test" });

    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]?.org).toBe("env-org");
    expect(result.targets[0]?.project).toBe("env-project");
    expect(result.targets[0]?.detectedFrom).toContain("env var");
  });

  test("resolveAllTargets: SENTRY_PROJECT=org/project combo", async () => {
    process.env.SENTRY_PROJECT = "combo-org/combo-proj";

    const result = await resolveAllTargets({ cwd: "/test" });

    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]?.org).toBe("combo-org");
    expect(result.targets[0]?.project).toBe("combo-proj");
  });

  test("resolveAllTargets: env vars beat config defaults", async () => {
    process.env.SENTRY_ORG = "env-org";
    process.env.SENTRY_PROJECT = "env-project";
    mockGetDefaultOrganization.mockReturnValue("default-org");
    mockGetDefaultProject.mockReturnValue("default-project");

    const result = await resolveAllTargets({ cwd: "/test" });

    expect(result.targets[0]?.org).toBe("env-org");
    expect(mockGetDefaultOrganization).not.toHaveBeenCalled();
  });

  // --- resolveOrgsForListing ---

  test("resolveOrgsForListing: returns org from SENTRY_ORG when no flag or defaults", async () => {
    process.env.SENTRY_ORG = "env-org";

    const result = await resolveOrgsForListing(undefined, "/test");

    expect(result.orgs).toEqual(["env-org"]);
  });

  // --- Edge cases ---

  test("whitespace-only env vars are ignored", async () => {
    process.env.SENTRY_ORG = "  ";
    process.env.SENTRY_PROJECT = "  ";

    const result = await resolveOrgAndProject({ cwd: "/test" });

    // Should fall through — empty after trim
    expect(result).toBeNull();
  });

  test("SENTRY_PROJECT with trailing slash is treated as invalid combo", async () => {
    process.env.SENTRY_PROJECT = "my-org/";

    const result = await resolveOrgAndProject({ cwd: "/test" });

    // slash present but empty project — falls through entirely
    expect(result).toBeNull();
  });

  test("SENTRY_PROJECT with leading slash is treated as invalid combo", async () => {
    process.env.SENTRY_PROJECT = "/my-project";

    const result = await resolveOrgAndProject({ cwd: "/test" });

    // slash present but empty org — falls through entirely
    expect(result).toBeNull();
  });

  test("malformed SENTRY_PROJECT with slash does not leak slash into project slug", async () => {
    // Regression: SENTRY_PROJECT="org/" + SENTRY_ORG="my-org" must NOT
    // produce project="org/" — the malformed combo should be discarded
    // and only the org from SENTRY_ORG should be returned.
    process.env.SENTRY_ORG = "my-org";
    process.env.SENTRY_PROJECT = "other-org/";

    const result = await resolveOrgAndProject({ cwd: "/test" });

    // Should fall through because SENTRY_PROJECT is a malformed combo.
    // resolveFromEnvVars returns org-only from SENTRY_ORG, but
    // resolveOrgAndProject requires a project, so result is null.
    expect(result).toBeNull();
  });

  test("malformed SENTRY_PROJECT with slash still provides org via SENTRY_ORG", async () => {
    process.env.SENTRY_ORG = "my-org";
    process.env.SENTRY_PROJECT = "other-org/";

    const result = await resolveOrg({ cwd: "/test" });

    // Malformed combo discards SENTRY_PROJECT but SENTRY_ORG is still used
    expect(result?.org).toBe("my-org");
  });
});
