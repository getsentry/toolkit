/**
 * Project Cache Tests
 *
 * Tests for caching project information by orgId:projectId or DSN public key.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import {
  cacheProjectsForOrg,
  clearProjectCache,
  getCachedProject,
  getCachedProjectByDsnKey,
  getCachedProjectById,
  getCachedProjectBySlug,
  getCachedProjectsForOrg,
  setCachedProject,
  setCachedProjectByDsnKey,
} from "../../../src/lib/db/project-cache.js";
import { useTestConfigDir } from "../../helpers.js";

useTestConfigDir("test-project-cache-");

describe("getCachedProject", () => {
  test("returns undefined when no cache entry exists", async () => {
    const result = getCachedProject("org-123", "project-456");
    expect(result).toBeUndefined();
  });

  test("returns cached project when entry exists", async () => {
    setCachedProject("org-123", "project-456", {
      orgSlug: "my-org",
      orgName: "My Organization",
      projectSlug: "my-project",
      projectName: "My Project",
    });

    const result = getCachedProject("org-123", "project-456");
    expect(result).toBeDefined();
    expect(result?.orgSlug).toBe("my-org");
    expect(result?.orgName).toBe("My Organization");
    expect(result?.projectSlug).toBe("my-project");
    expect(result?.projectName).toBe("My Project");
    expect(result?.cachedAt).toBeGreaterThan(0);
  });

  test("returns undefined for different orgId", async () => {
    setCachedProject("org-123", "project-456", {
      orgSlug: "my-org",
      orgName: "My Organization",
      projectSlug: "my-project",
      projectName: "My Project",
    });

    const result = getCachedProject("org-different", "project-456");
    expect(result).toBeUndefined();
  });

  test("returns undefined for different projectId", async () => {
    setCachedProject("org-123", "project-456", {
      orgSlug: "my-org",
      orgName: "My Organization",
      projectSlug: "my-project",
      projectName: "My Project",
    });

    const result = getCachedProject("org-123", "project-different");
    expect(result).toBeUndefined();
  });
});

describe("setCachedProject", () => {
  test("creates new cache entry", async () => {
    setCachedProject("org-123", "project-456", {
      orgSlug: "my-org",
      orgName: "My Organization",
      projectSlug: "my-project",
      projectName: "My Project",
    });

    const result = getCachedProject("org-123", "project-456");
    expect(result).toBeDefined();
    expect(result?.orgSlug).toBe("my-org");
  });

  test("updates existing cache entry (upsert)", async () => {
    // Set initial cache
    setCachedProject("org-123", "project-456", {
      orgSlug: "old-org",
      orgName: "Old Organization",
      projectSlug: "old-project",
      projectName: "Old Project",
    });

    // Update cache
    setCachedProject("org-123", "project-456", {
      orgSlug: "new-org",
      orgName: "New Organization",
      projectSlug: "new-project",
      projectName: "New Project",
    });

    const result = getCachedProject("org-123", "project-456");
    expect(result).toBeDefined();
    expect(result?.orgSlug).toBe("new-org");
    expect(result?.orgName).toBe("New Organization");
    expect(result?.projectSlug).toBe("new-project");
    expect(result?.projectName).toBe("New Project");
  });

  test("stores cachedAt timestamp", async () => {
    const before = Date.now();

    setCachedProject("org-123", "project-456", {
      orgSlug: "my-org",
      orgName: "My Organization",
      projectSlug: "my-project",
      projectName: "My Project",
    });

    const after = Date.now();
    const result = getCachedProject("org-123", "project-456");

    expect(result?.cachedAt).toBeGreaterThanOrEqual(before);
    expect(result?.cachedAt).toBeLessThanOrEqual(after);
  });

  test("handles multiple distinct cache entries", async () => {
    setCachedProject("org-1", "project-1", {
      orgSlug: "org-one",
      orgName: "Org One",
      projectSlug: "project-one",
      projectName: "Project One",
    });

    setCachedProject("org-2", "project-2", {
      orgSlug: "org-two",
      orgName: "Org Two",
      projectSlug: "project-two",
      projectName: "Project Two",
    });

    const result1 = getCachedProject("org-1", "project-1");
    const result2 = getCachedProject("org-2", "project-2");

    expect(result1?.orgSlug).toBe("org-one");
    expect(result2?.orgSlug).toBe("org-two");
  });
});

describe("getCachedProjectByDsnKey", () => {
  test("returns undefined when no cache entry exists", async () => {
    const result = getCachedProjectByDsnKey("abc123publickey");
    expect(result).toBeUndefined();
  });

  test("returns cached project when entry exists", async () => {
    setCachedProjectByDsnKey("abc123publickey", {
      orgSlug: "dsn-org",
      orgName: "DSN Organization",
      projectSlug: "dsn-project",
      projectName: "DSN Project",
    });

    const result = getCachedProjectByDsnKey("abc123publickey");
    expect(result).toBeDefined();
    expect(result?.orgSlug).toBe("dsn-org");
    expect(result?.orgName).toBe("DSN Organization");
    expect(result?.projectSlug).toBe("dsn-project");
    expect(result?.projectName).toBe("DSN Project");
    expect(result?.cachedAt).toBeGreaterThan(0);
  });

  test("returns undefined for different public key", async () => {
    setCachedProjectByDsnKey("abc123publickey", {
      orgSlug: "dsn-org",
      orgName: "DSN Organization",
      projectSlug: "dsn-project",
      projectName: "DSN Project",
    });

    const result = getCachedProjectByDsnKey("different-key");
    expect(result).toBeUndefined();
  });
});

describe("setCachedProjectByDsnKey", () => {
  test("creates new cache entry", async () => {
    setCachedProjectByDsnKey("mykey123", {
      orgSlug: "key-org",
      orgName: "Key Organization",
      projectSlug: "key-project",
      projectName: "Key Project",
    });

    const result = getCachedProjectByDsnKey("mykey123");
    expect(result).toBeDefined();
    expect(result?.orgSlug).toBe("key-org");
  });

  test("updates existing cache entry (upsert)", async () => {
    setCachedProjectByDsnKey("mykey123", {
      orgSlug: "old-org",
      orgName: "Old Organization",
      projectSlug: "old-project",
      projectName: "Old Project",
    });

    setCachedProjectByDsnKey("mykey123", {
      orgSlug: "new-org",
      orgName: "New Organization",
      projectSlug: "new-project",
      projectName: "New Project",
    });

    const result = getCachedProjectByDsnKey("mykey123");
    expect(result?.orgSlug).toBe("new-org");
    expect(result?.orgName).toBe("New Organization");
  });

  test("dsn key cache is separate from orgId:projectId cache", async () => {
    // Cache by orgId:projectId
    setCachedProject("123", "456", {
      orgSlug: "by-id-org",
      orgName: "By ID Organization",
      projectSlug: "by-id-project",
      projectName: "By ID Project",
    });

    // Cache by DSN key
    setCachedProjectByDsnKey("publickey", {
      orgSlug: "by-dsn-org",
      orgName: "By DSN Organization",
      projectSlug: "by-dsn-project",
      projectName: "By DSN Project",
    });

    // Both should exist independently
    const byId = getCachedProject("123", "456");
    const byDsn = getCachedProjectByDsnKey("publickey");

    expect(byId?.orgSlug).toBe("by-id-org");
    expect(byDsn?.orgSlug).toBe("by-dsn-org");

    // Cross-lookup should fail - keys are in different formats
    // orgId:projectId format -> "123:456"
    // DSN key format -> "dsn:publickey"
    const byIdAsDsn = getCachedProjectByDsnKey("123:456");
    expect(byIdAsDsn).toBeUndefined();

    // Lookup with wrong key format
    const wrongKey = getCachedProject("wrong", "key");
    expect(wrongKey).toBeUndefined();
  });
});

describe("clearProjectCache", () => {
  test("clears all cache entries", async () => {
    // Add several entries
    setCachedProject("org-1", "project-1", {
      orgSlug: "org-one",
      orgName: "Org One",
      projectSlug: "project-one",
      projectName: "Project One",
    });

    setCachedProject("org-2", "project-2", {
      orgSlug: "org-two",
      orgName: "Org Two",
      projectSlug: "project-two",
      projectName: "Project Two",
    });

    setCachedProjectByDsnKey("key1", {
      orgSlug: "key-org",
      orgName: "Key Organization",
      projectSlug: "key-project",
      projectName: "Key Project",
    });

    // Clear all
    clearProjectCache();

    // All should be undefined across every lookup shape.
    expect(getCachedProject("org-1", "project-1")).toBeUndefined();
    expect(getCachedProject("org-2", "project-2")).toBeUndefined();
    expect(getCachedProjectByDsnKey("key1")).toBeUndefined();
    expect(getCachedProjectBySlug("org-one", "project-one")).toBeUndefined();
    expect(getCachedProjectBySlug("key-org", "key-project")).toBeUndefined();
  });

  test("does not throw when cache is already empty", async () => {
    // Should not throw
    clearProjectCache();
    clearProjectCache();
  });
});

describe("cache key uniqueness", () => {
  test("different orgId:projectId combinations are stored separately", async () => {
    setCachedProject("org-A", "project-1", {
      orgSlug: "org-a",
      orgName: "Org A",
      projectSlug: "project-1",
      projectName: "Project 1 in A",
    });

    setCachedProject("org-B", "project-1", {
      orgSlug: "org-b",
      orgName: "Org B",
      projectSlug: "project-1",
      projectName: "Project 1 in B",
    });

    setCachedProject("org-A", "project-2", {
      orgSlug: "org-a",
      orgName: "Org A",
      projectSlug: "project-2",
      projectName: "Project 2 in A",
    });

    const resultA1 = getCachedProject("org-A", "project-1");
    const resultB1 = getCachedProject("org-B", "project-1");
    const resultA2 = getCachedProject("org-A", "project-2");

    expect(resultA1?.projectName).toBe("Project 1 in A");
    expect(resultB1?.projectName).toBe("Project 1 in B");
    expect(resultA2?.projectName).toBe("Project 2 in A");
  });

  test("handles special characters in IDs", async () => {
    setCachedProject("org:with:colons", "project/with/slashes", {
      orgSlug: "special-org",
      orgName: "Special Organization",
      projectSlug: "special-project",
      projectName: "Special Project",
    });

    const result = getCachedProject("org:with:colons", "project/with/slashes");
    expect(result?.orgSlug).toBe("special-org");
  });

  test("handles numeric-like string IDs", async () => {
    setCachedProject("123", "456", {
      orgSlug: "numeric-org",
      orgName: "Numeric Organization",
      projectSlug: "numeric-project",
      projectName: "Numeric Project",
    });

    const result = getCachedProject("123", "456");
    expect(result?.orgSlug).toBe("numeric-org");
  });
});

describe("cacheProjectsForOrg", () => {
  test("caches multiple projects in one call", async () => {
    cacheProjectsForOrg("my-org", "My Org", [
      { id: "1", slug: "frontend", name: "Frontend" },
      { id: "2", slug: "backend", name: "Backend" },
      { id: "3", slug: "mobile", name: "Mobile App" },
    ]);

    const result = getCachedProjectsForOrg("my-org");
    expect(result).toHaveLength(3);
    expect(result).toContainEqual({
      projectSlug: "frontend",
      projectName: "Frontend",
    });
    expect(result).toContainEqual({
      projectSlug: "backend",
      projectName: "Backend",
    });
    expect(result).toContainEqual({
      projectSlug: "mobile",
      projectName: "Mobile App",
    });
  });

  test("is idempotent on repeated calls", async () => {
    const projects = [
      { id: "1", slug: "frontend", name: "Frontend" },
      { id: "2", slug: "backend", name: "Backend" },
    ];

    cacheProjectsForOrg("my-org", "My Org", projects);
    cacheProjectsForOrg("my-org", "My Org", projects);

    const result = getCachedProjectsForOrg("my-org");
    expect(result).toHaveLength(2);
  });

  test("empty array is a no-op", async () => {
    cacheProjectsForOrg("my-org", "My Org", []);
    const result = getCachedProjectsForOrg("my-org");
    expect(result).toEqual([]);
  });

  test("does not conflict with orgId:projectId cache entries", async () => {
    setCachedProject("org-123", "proj-456", {
      orgSlug: "my-org",
      orgName: "My Org",
      projectSlug: "frontend",
      projectName: "Frontend (by DSN)",
    });

    cacheProjectsForOrg("my-org", "My Org", [
      { id: "456", slug: "frontend", name: "Frontend (by list)" },
    ]);

    // Both entries exist — getCachedProjectsForOrg deduplicates by slug
    const result = getCachedProjectsForOrg("my-org");
    expect(result).toHaveLength(1);
    expect(result[0]?.projectSlug).toBe("frontend");
  });
});

describe("getCachedProjectsForOrg", () => {
  test("returns empty array when no projects for org", async () => {
    const result = getCachedProjectsForOrg("nonexistent-org");
    expect(result).toEqual([]);
  });

  test("returns projects only for the specified org", async () => {
    setCachedProject("org-1", "project-1", {
      orgSlug: "alpha-org",
      orgName: "Alpha",
      projectSlug: "alpha-project",
      projectName: "Alpha Project",
    });
    setCachedProject("org-2", "project-2", {
      orgSlug: "beta-org",
      orgName: "Beta",
      projectSlug: "beta-project",
      projectName: "Beta Project",
    });
    setCachedProject("org-3", "project-3", {
      orgSlug: "alpha-org",
      orgName: "Alpha",
      projectSlug: "alpha-second",
      projectName: "Alpha Second",
    });

    const result = getCachedProjectsForOrg("alpha-org");
    expect(result).toHaveLength(2);
    expect(result).toContainEqual({
      projectSlug: "alpha-project",
      projectName: "Alpha Project",
    });
    expect(result).toContainEqual({
      projectSlug: "alpha-second",
      projectName: "Alpha Second",
    });
  });

  test("returns empty for wrong org", async () => {
    setCachedProject("org-1", "project-1", {
      orgSlug: "alpha-org",
      orgName: "Alpha",
      projectSlug: "alpha-project",
      projectName: "Alpha Project",
    });

    const result = getCachedProjectsForOrg("beta-org");
    expect(result).toEqual([]);
  });
});

describe("getCachedProjectBySlug", () => {
  test("returns undefined when no cache entry exists", () => {
    const result = getCachedProjectBySlug("my-org", "my-project");
    expect(result).toBeUndefined();
  });

  test("returns entry populated via setCachedProject (orgId:projectId key)", () => {
    setCachedProject("123", "456", {
      orgSlug: "my-org",
      orgName: "My Organization",
      projectSlug: "my-project",
      projectName: "My Project",
      projectId: "456",
    });

    const result = getCachedProjectBySlug("my-org", "my-project");
    expect(result).toBeDefined();
    expect(result?.orgSlug).toBe("my-org");
    expect(result?.projectSlug).toBe("my-project");
    expect(result?.projectId).toBe("456");
  });

  test("returns entry populated via setCachedProjectByDsnKey (dsn: key)", () => {
    setCachedProjectByDsnKey("abcdef1234567890", {
      orgSlug: "dsn-org",
      orgName: "DSN Org",
      projectSlug: "dsn-project",
      projectName: "DSN Project",
      projectId: "789",
    });

    const result = getCachedProjectBySlug("dsn-org", "dsn-project");
    expect(result).toBeDefined();
    expect(result?.projectId).toBe("789");
  });

  test("returns entry populated via cacheProjectsForOrg (list: key)", () => {
    cacheProjectsForOrg("my-org", "My Org", [
      { id: "101", slug: "listed-project", name: "Listed Project" },
    ]);

    const result = getCachedProjectBySlug("my-org", "listed-project");
    expect(result).toBeDefined();
    expect(result?.projectId).toBe("101");
    expect(result?.projectName).toBe("Listed Project");
  });

  test("returns the most recently cached entry when multiple key shapes match", async () => {
    // Older entry via dsn key
    setCachedProjectByDsnKey("key-1", {
      orgSlug: "my-org",
      orgName: "My Org",
      projectSlug: "dup",
      projectName: "Old Name",
      projectId: "111",
    });
    // Small delay so `cached_at` differs; setCachedProject uses Date.now()
    await sleep(5);
    // Newer entry via orgId:projectId key
    setCachedProject("org-id", "proj-id", {
      orgSlug: "my-org",
      orgName: "My Org",
      projectSlug: "dup",
      projectName: "New Name",
      projectId: "222",
    });

    const result = getCachedProjectBySlug("my-org", "dup");
    expect(result).toBeDefined();
    expect(result?.projectName).toBe("New Name");
    expect(result?.projectId).toBe("222");
  });

  test("does not match a different org", () => {
    setCachedProject("123", "456", {
      orgSlug: "org-a",
      orgName: "A",
      projectSlug: "shared-slug",
      projectName: "A",
      projectId: "456",
    });

    expect(getCachedProjectBySlug("org-b", "shared-slug")).toBeUndefined();
  });

  test("does not match a different project", () => {
    setCachedProject("123", "456", {
      orgSlug: "org-a",
      orgName: "A",
      projectSlug: "proj-a",
      projectName: "A",
      projectId: "456",
    });

    expect(getCachedProjectBySlug("org-a", "proj-b")).toBeUndefined();
  });

  test("returns entry even when projectId is missing (older rows)", () => {
    setCachedProject("123", "456", {
      orgSlug: "legacy-org",
      orgName: "Legacy",
      projectSlug: "legacy-project",
      projectName: "Legacy",
    });

    const result = getCachedProjectBySlug("legacy-org", "legacy-project");
    expect(result).toBeDefined();
    // SQLite stores missing project IDs as NULL; the row mapper passes
    // the value through unchanged, so callers see `null` (not undefined).
    expect(result?.projectId).toBeFalsy();
  });
});

describe("getCachedProjectById", () => {
  test.each([
    "ids",
    "dsn",
    "list",
  ])("finds an ID cached through the %s key shape without crossing organizations", (keyShape) => {
    const project = {
      orgSlug: "my-org",
      orgName: "My Org",
      projectSlug: "frontend",
      projectName: "Frontend",
      projectId: "42",
    };
    if (keyShape === "ids") {
      setCachedProject("1", "42", project);
    } else if (keyShape === "dsn") {
      setCachedProjectByDsnKey("public-key", project);
    } else {
      cacheProjectsForOrg("my-org", "My Org", [
        { id: "42", slug: "frontend", name: "Frontend" },
      ]);
    }

    expect(getCachedProjectById("my-org", "42")).toMatchObject(project);
    expect(getCachedProjectById("other-org", "42")).toBeUndefined();
    expect(getCachedProjectById("my-org", "43")).toBeUndefined();
  });

  test("uses the most recent slug when a project has been renamed", async () => {
    cacheProjectsForOrg("my-org", "My Org", [
      { id: "42", slug: "old-name", name: "Old Name" },
    ]);
    await sleep(5);
    setCachedProject("1", "42", {
      orgSlug: "my-org",
      orgName: "My Org",
      projectSlug: "new-name",
      projectName: "New Name",
      projectId: "42",
    });

    expect(getCachedProjectById("my-org", "42")?.projectSlug).toBe("new-name");
  });
});
