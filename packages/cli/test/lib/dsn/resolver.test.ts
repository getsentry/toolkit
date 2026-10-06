import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createIsolatedDbContext } from "../../model-based/helpers.js";

// Mock api-client module to avoid real API calls
const {
  mockListOrganizations,
  mockListProjects,
  mockFindProjectByDsnKey,
  mockResolveOrgDisplayName,
} = vi.hoisted(() => ({
  mockListOrganizations: vi.fn(() => Promise.resolve([])),
  mockListProjects: vi.fn(() => Promise.resolve([])),
  mockFindProjectByDsnKey: vi.fn(() => Promise.resolve(null)),
  mockResolveOrgDisplayName: vi.fn(
    (slug: string, name?: string) => name ?? slug
  ),
}));

vi.mock("../../../src/lib/api-client.js", () => ({
  listOrganizations: mockListOrganizations,
  listProjects: mockListProjects,
  findProjectByDsnKey: mockFindProjectByDsnKey,
  resolveOrgDisplayName: mockResolveOrgDisplayName,
}));

// Now import the resolver after mocking
import {
  getAccessibleProjects,
  resolveProject,
} from "../../../src/lib/dsn/resolver.js";
import type { DetectedDsn } from "../../../src/lib/dsn/types.js";

describe("resolveProject", () => {
  let cleanup: () => void;

  beforeEach(() => {
    cleanup = createIsolatedDbContext();
    mockListOrganizations.mockClear();
    mockListProjects.mockClear();
    mockFindProjectByDsnKey.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  test("returns resolved info if DSN already has resolved field", async () => {
    const dsn: DetectedDsn = {
      raw: "https://abc123@o123.ingest.sentry.io/456",
      protocol: "https",
      publicKey: "abc123",
      host: "o123.ingest.sentry.io",
      projectId: "456",
      orgId: "123",
      source: "env",
      resolved: {
        orgSlug: "my-org",
        orgName: "My Organization",
        projectSlug: "frontend",
        projectName: "Frontend App",
      },
    };

    const result = await resolveProject("/some/path", dsn);

    expect(result.orgSlug).toBe("my-org");
    expect(result.orgName).toBe("My Organization");
    expect(result.projectSlug).toBe("frontend");
    expect(result.projectName).toBe("Frontend App");
    expect(result.dsn).toBe(dsn);
    expect(result.sourceDescription).toContain("SENTRY_DSN");
    // Should not call API
    expect(mockListOrganizations).not.toHaveBeenCalled();
    expect(mockFindProjectByDsnKey).not.toHaveBeenCalled();
  });

  test("resolves DSN without orgId using findProjectByDsnKey", async () => {
    const dsn: DetectedDsn = {
      raw: "https://abc123@sentry.io/456",
      protocol: "https",
      publicKey: "abc123",
      host: "sentry.io",
      projectId: "456",
      // No orgId - self-hosted or legacy DSN
      source: "env_file",
      sourcePath: ".env",
    };

    mockFindProjectByDsnKey.mockResolvedValue({
      id: "456",
      slug: "my-project",
      name: "My Project",
      organization: {
        id: "123",
        slug: "my-org",
        name: "My Organization",
      },
    });

    const result = await resolveProject("/test/path", dsn);

    expect(result.orgSlug).toBe("my-org");
    expect(result.orgName).toBe("My Organization");
    expect(result.projectSlug).toBe("my-project");
    expect(result.projectName).toBe("My Project");
    expect(mockFindProjectByDsnKey).toHaveBeenCalledWith("abc123");
  });

  test("throws when DSN without orgId cannot be resolved", async () => {
    const dsn: DetectedDsn = {
      raw: "https://unknown@sentry.io/999",
      protocol: "https",
      publicKey: "unknown",
      host: "sentry.io",
      projectId: "999",
      source: "code",
      sourcePath: "app.js",
    };

    mockFindProjectByDsnKey.mockResolvedValue(null);

    await expect(resolveProject("/test/path", dsn)).rejects.toThrow(
      /Cannot resolve project.*DSN could not be matched/
    );
  });

  test("throws when project has no organization", async () => {
    const dsn: DetectedDsn = {
      raw: "https://abc123@sentry.io/456",
      protocol: "https",
      publicKey: "abc123",
      host: "sentry.io",
      projectId: "456",
      source: "env",
    };

    mockFindProjectByDsnKey.mockResolvedValue({
      id: "456",
      slug: "orphan-project",
      name: "Orphan Project",
      // No organization
    });

    await expect(resolveProject("/test/path", dsn)).rejects.toThrow(
      /Cannot resolve project/
    );
  });

  test("resolves DSN with orgId using listOrganizations and listProjects", async () => {
    const dsn: DetectedDsn = {
      raw: "https://abc123@o123.ingest.sentry.io/456",
      protocol: "https",
      publicKey: "abc123",
      host: "o123.ingest.sentry.io",
      projectId: "456",
      orgId: "123",
      source: "code",
      sourcePath: "src/sentry.ts",
    };

    mockListOrganizations.mockResolvedValue([
      { id: "999", slug: "other-org", name: "Other Org" },
      { id: "123", slug: "my-org", name: "My Organization" },
    ]);

    mockListProjects.mockResolvedValue([
      { id: "789", slug: "other-project", name: "Other Project" },
      { id: "456", slug: "frontend", name: "Frontend App" },
    ]);

    const result = await resolveProject("/test/path", dsn);

    expect(result.orgSlug).toBe("my-org");
    expect(result.orgName).toBe("My Organization");
    expect(result.projectSlug).toBe("frontend");
    expect(result.projectName).toBe("Frontend App");
    expect(mockListOrganizations).toHaveBeenCalled();
    expect(mockListProjects).toHaveBeenCalledWith("my-org");
  });

  test("throws when organization not found by orgId", async () => {
    const dsn: DetectedDsn = {
      raw: "https://abc123@o999.ingest.sentry.io/456",
      protocol: "https",
      publicKey: "abc123",
      host: "o999.ingest.sentry.io",
      projectId: "456",
      orgId: "999",
      source: "env",
    };

    mockListOrganizations.mockResolvedValue([
      { id: "123", slug: "my-org", name: "My Org" },
    ]);

    await expect(resolveProject("/test/path", dsn)).rejects.toThrow(
      /Could not find organization with ID 999/
    );
  });

  test("throws when project not found by projectId", async () => {
    const dsn: DetectedDsn = {
      raw: "https://abc123@o123.ingest.sentry.io/999",
      protocol: "https",
      publicKey: "abc123",
      host: "o123.ingest.sentry.io",
      projectId: "999",
      orgId: "123",
      source: "env",
    };

    mockListOrganizations.mockResolvedValue([
      { id: "123", slug: "my-org", name: "My Org" },
    ]);

    mockListProjects.mockResolvedValue([
      { id: "456", slug: "existing-project", name: "Existing" },
    ]);

    await expect(resolveProject("/test/path", dsn)).rejects.toThrow(
      /Could not find project with ID 999 in organization my-org/
    );
  });

  test("handles org ID as string vs number comparison", async () => {
    const dsn: DetectedDsn = {
      raw: "https://key@o42.ingest.sentry.io/100",
      protocol: "https",
      publicKey: "key",
      host: "o42.ingest.sentry.io",
      projectId: "100",
      orgId: "42",
      source: "env",
    };

    // API returns id as number, but DSN has it as string
    mockListOrganizations.mockResolvedValue([
      { id: 42, slug: "number-org", name: "Number Org" },
    ]);

    mockListProjects.mockResolvedValue([
      { id: 100, slug: "number-project", name: "Number Project" },
    ]);

    const result = await resolveProject("/test/path", dsn);

    expect(result.orgSlug).toBe("number-org");
    expect(result.projectSlug).toBe("number-project");
  });
});

describe("getAccessibleProjects", () => {
  beforeEach(() => {
    mockListOrganizations.mockReset();
    mockListProjects.mockReset();
  });

  test("returns empty array when not authenticated", async () => {
    mockListOrganizations.mockRejectedValue(new Error("Not authenticated"));

    const projects = await getAccessibleProjects();

    expect(projects).toEqual([]);
  });

  test("returns projects from all accessible organizations", async () => {
    mockListOrganizations.mockResolvedValue([
      { id: "1", slug: "org-a", name: "Organization A" },
      { id: "2", slug: "org-b", name: "Organization B" },
    ]);

    // First call for org-a
    mockListProjects.mockResolvedValueOnce([
      { id: "10", slug: "frontend", name: "Frontend" },
      { id: "11", slug: "backend", name: "Backend" },
    ]);

    // Second call for org-b
    mockListProjects.mockResolvedValueOnce([
      { id: "20", slug: "api", name: "API Service" },
    ]);

    const projects = await getAccessibleProjects();

    expect(projects).toHaveLength(3);
    expect(projects).toContainEqual({
      org: "org-a",
      project: "frontend",
      orgName: "Organization A",
      projectName: "Frontend",
    });
    expect(projects).toContainEqual({
      org: "org-a",
      project: "backend",
      orgName: "Organization A",
      projectName: "Backend",
    });
    expect(projects).toContainEqual({
      org: "org-b",
      project: "api",
      orgName: "Organization B",
      projectName: "API Service",
    });
  });

  test("skips organizations that fail to list projects", async () => {
    mockListOrganizations.mockResolvedValue([
      { id: "1", slug: "accessible", name: "Accessible Org" },
      { id: "2", slug: "forbidden", name: "Forbidden Org" },
    ]);

    mockListProjects.mockResolvedValueOnce([
      { id: "10", slug: "my-project", name: "My Project" },
    ]);

    mockListProjects.mockRejectedValueOnce(new Error("403 Forbidden"));

    const projects = await getAccessibleProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0]).toEqual({
      org: "accessible",
      project: "my-project",
      orgName: "Accessible Org",
      projectName: "My Project",
    });
  });

  test("returns empty array when no projects exist", async () => {
    mockListOrganizations.mockResolvedValue([
      { id: "1", slug: "empty-org", name: "Empty Organization" },
    ]);

    mockListProjects.mockResolvedValue([]);

    const projects = await getAccessibleProjects();

    expect(projects).toEqual([]);
  });

  test("handles organization with no access to projects", async () => {
    mockListOrganizations.mockResolvedValue([
      { id: "1", slug: "org-1", name: "Org 1" },
    ]);

    mockListProjects.mockRejectedValue(new Error("Access denied"));

    const projects = await getAccessibleProjects();

    expect(projects).toEqual([]);
  });
});
