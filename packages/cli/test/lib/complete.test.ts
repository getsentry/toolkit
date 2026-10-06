/**
 * Completion Engine Tests
 *
 * Tests for the shell completion engine (src/lib/complete.ts).
 * Uses a real SQLite database via useTestConfigDir for realistic
 * cache interaction tests.
 */

import { describe, expect, test } from "vitest";
import {
  completeAliases,
  completeOrgSlashProject,
  completeOrgSlugs,
  completeProjectCreateSpec,
  completeProjectSlugs,
  getCompletions,
} from "../../src/lib/complete.js";
import { setProjectAliases } from "../../src/lib/db/project-aliases.js";
import { setCachedProject } from "../../src/lib/db/project-cache.js";
import {
  type OrgRegionEntry,
  setOrgRegions,
} from "../../src/lib/db/regions.js";
import { useTestConfigDir } from "../helpers.js";

useTestConfigDir("test-complete-");

// -- Helpers --

async function seedOrgs(
  orgs: { slug: string; name: string; regionUrl?: string }[]
): Promise<void> {
  const entries: OrgRegionEntry[] = orgs.map((o) => ({
    slug: o.slug,
    regionUrl: o.regionUrl ?? "https://us.sentry.io",
    orgId: o.slug,
    orgName: o.name,
  }));
  setOrgRegions(entries);
}

async function seedProjects(
  projects: {
    orgId: string;
    projectId: string;
    orgSlug: string;
    projectSlug: string;
    projectName: string;
  }[]
): Promise<void> {
  for (const p of projects) {
    setCachedProject(p.orgId, p.projectId, {
      orgSlug: p.orgSlug,
      orgName: p.orgSlug,
      projectSlug: p.projectSlug,
      projectName: p.projectName,
    });
  }
}

// -- Tests --

describe("getCompletions: context detection", () => {
  test("returns empty for unknown commands", async () => {
    const result = getCompletions(["unknown", "cmd"], "");
    expect(result).toEqual([]);
  });

  test("returns org/project completions for issue list", async () => {
    await seedOrgs([{ slug: "my-org", name: "My Organization" }]);
    const result = getCompletions(["issue", "list"], "");
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].value).toBe("my-org/");
  });

  test("returns org-only completions for org view", async () => {
    await seedOrgs([{ slug: "my-org", name: "My Organization" }]);
    const result = getCompletions(["org", "view"], "");
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].value).toBe("my-org"); // no trailing slash
  });

  test("still provides completions after boolean flags", async () => {
    await seedOrgs([{ slug: "my-org", name: "My Organization" }]);
    // After --verbose (a boolean flag), completions should still work
    const result = getCompletions(["issue", "list", "--verbose"], "");
    expect(result.length).toBeGreaterThan(0);
  });

  test("returns org/project completions for project list", async () => {
    await seedOrgs([{ slug: "test-org", name: "Test" }]);
    const result = getCompletions(["project", "list"], "test");
    expect(result.some((c) => c.value === "test-org/")).toBe(true);
  });

  test("returns org-only completions for team list", async () => {
    await seedOrgs([{ slug: "acme", name: "Acme Inc" }]);
    const result = getCompletions(["team", "list"], "");
    expect(result.some((c) => c.value === "acme")).toBe(true);
  });

  test("returns only valid project create prefixes and pairs", async () => {
    await seedOrgs([{ slug: "acme", name: "Acme Inc" }]);
    await seedProjects([
      {
        orgId: "1",
        projectId: "10",
        orgSlug: "acme",
        projectSlug: "existing",
        projectName: "Existing Project",
      },
    ]);
    setProjectAliases(
      { app: { orgSlug: "acme", projectSlug: "existing" } },
      "fingerprint"
    );

    expect(getCompletions(["project", "create"], "")).toEqual([
      { value: "acme/", description: "Acme Inc" },
    ]);
    expect(getCompletions(["project", "create"], "acme/new")).toEqual([]);
    expect(getCompletions(["project", "create"], "web:java")).toContainEqual({
      value: "web:javascript",
      description: "Platform",
    });
    // Platform must always be attached with ":" — a bare positional never
    // gets legacy space-separated platform completions.
    expect(getCompletions(["project", "create", "web"], "java")).toEqual([]);
  });

  test("completes a new batch pair's platform regardless of preceding pairs", () => {
    // Completion only ever looks at the current partial — a self-contained
    // colon pair completes the same way no matter what preceded it.
    expect(
      getCompletions(["project", "create", "api:node"], "worker:java")
    ).toContainEqual({
      value: "worker:javascript",
      description: "Platform",
    });
    expect(getCompletions(["project", "create", "--team"], "back")).toEqual([]);
  });
});

describe("completeProjectCreateSpec", () => {
  test("suggests common platforms while preserving the project name", () => {
    const result = completeProjectCreateSpec("my-project:");

    expect(result).toContainEqual({
      value: "my-project:javascript",
      description: "Platform",
    });
    expect(result.every((completion) => completion.value.includes(":"))).toBe(
      true
    );
  });

  test("matches every valid platform after a partial", () => {
    const result = completeProjectCreateSpec("acme/app:nintendo");

    expect(result).toEqual([
      { value: "acme/app:nintendo-switch", description: "Platform" },
    ]);
  });

  test("does not complete existing project names before the colon", () => {
    expect(completeProjectCreateSpec("acme/new-project")).toEqual([]);
  });

  test("does not complete project specifications containing whitespace", () => {
    expect(completeProjectCreateSpec("My App:java")).toEqual([]);
  });

  test.each([
    ":java",
    "acme/:java",
    "/app:java",
    "acme/app/child:java",
  ])("does not complete a malformed project target in %s", (partial) => {
    expect(completeProjectCreateSpec(partial)).toEqual([]);
  });
});

describe("completeOrgSlugs", () => {
  test("returns empty when no orgs cached", async () => {
    const result = completeOrgSlugs("");
    expect(result).toEqual([]);
  });

  test("returns all orgs for empty partial", async () => {
    await seedOrgs([
      { slug: "alpha", name: "Alpha Org" },
      { slug: "beta", name: "Beta Org" },
    ]);
    const result = completeOrgSlugs("");
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.value).sort()).toEqual(["alpha", "beta"]);
  });

  test("prefix matches", async () => {
    await seedOrgs([
      { slug: "sentry", name: "Sentry" },
      { slug: "other", name: "Other" },
    ]);
    const result = completeOrgSlugs("sen");
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe("sentry");
    expect(result[0].description).toBe("Sentry");
  });

  test("fuzzy matches", async () => {
    await seedOrgs([
      { slug: "sentry", name: "Sentry" },
      { slug: "other", name: "Other" },
    ]);
    // "senry" → "sentry" (distance 1, within threshold)
    const result = completeOrgSlugs("senry");
    expect(result.some((c) => c.value === "sentry")).toBe(true);
  });
});

describe("completeOrgSlashProject", () => {
  test("no slash returns org slugs with trailing slash + aliases", async () => {
    await seedOrgs([{ slug: "my-org", name: "My Org" }]);
    const result = completeOrgSlashProject("");
    expect(result.some((c) => c.value === "my-org/")).toBe(true);
  });

  test("with slash returns projects for the org", async () => {
    await seedOrgs([{ slug: "my-org", name: "My Org" }]);
    await seedProjects([
      {
        orgId: "1",
        projectId: "10",
        orgSlug: "my-org",
        projectSlug: "frontend",
        projectName: "Frontend App",
      },
      {
        orgId: "1",
        projectId: "20",
        orgSlug: "my-org",
        projectSlug: "backend",
        projectName: "Backend API",
      },
    ]);

    const result = completeOrgSlashProject("my-org/");
    expect(result.map((c) => c.value).sort()).toEqual([
      "my-org/backend",
      "my-org/frontend",
    ]);
  });

  test("with fuzzy org slug before slash resolves to correct org", async () => {
    await seedOrgs([{ slug: "sentry", name: "Sentry" }]);
    await seedProjects([
      {
        orgId: "1",
        projectId: "10",
        orgSlug: "sentry",
        projectSlug: "cli",
        projectName: "CLI",
      },
    ]);

    // "senry/" has a typo in the org — should fuzzy-resolve to "sentry"
    const result = completeOrgSlashProject("senry/");
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe("sentry/cli");
  });

  test("with unresolvable org slug before slash returns empty", async () => {
    await seedOrgs([{ slug: "sentry", name: "Sentry" }]);
    const result = completeOrgSlashProject("zzzzzzz/");
    expect(result).toEqual([]);
  });

  test("with slash and partial project filters", async () => {
    await seedOrgs([{ slug: "my-org", name: "My Org" }]);
    await seedProjects([
      {
        orgId: "1",
        projectId: "10",
        orgSlug: "my-org",
        projectSlug: "frontend",
        projectName: "Frontend",
      },
      {
        orgId: "1",
        projectId: "20",
        orgSlug: "my-org",
        projectSlug: "backend",
        projectName: "Backend",
      },
    ]);

    const result = completeOrgSlashProject("my-org/fro");
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe("my-org/frontend");
  });
});

describe("completeProjectSlugs", () => {
  test("returns empty when no projects cached for org", async () => {
    const result = completeProjectSlugs("", "nonexistent");
    expect(result).toEqual([]);
  });

  test("returns matching projects", async () => {
    await seedProjects([
      {
        orgId: "1",
        projectId: "10",
        orgSlug: "my-org",
        projectSlug: "web",
        projectName: "Web App",
      },
      {
        orgId: "1",
        projectId: "20",
        orgSlug: "my-org",
        projectSlug: "api",
        projectName: "API Service",
      },
    ]);

    const result = completeProjectSlugs("we", "my-org");
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe("my-org/web");
    expect(result[0].description).toBe("Web App");
  });
});

describe("completeAliases", () => {
  test("returns empty when no aliases exist", async () => {
    const result = completeAliases("");
    expect(result).toEqual([]);
  });

  test("returns matching aliases", async () => {
    setProjectAliases(
      {
        a: { orgSlug: "my-org", projectSlug: "frontend" },
        b: { orgSlug: "my-org", projectSlug: "backend" },
      },
      "fingerprint"
    );

    const result = completeAliases("");
    expect(result).toHaveLength(2);

    const aCompletion = result.find((c) => c.value === "a");
    expect(aCompletion).toBeDefined();
    expect(aCompletion!.description).toBe("my-org/frontend");
  });

  test("filters aliases by prefix (exact match ranks first)", async () => {
    setProjectAliases(
      {
        a: { orgSlug: "org", projectSlug: "proj-a" },
        b: { orgSlug: "org", projectSlug: "proj-b" },
        abc: { orgSlug: "org", projectSlug: "proj-abc" },
      },
      "fingerprint"
    );

    const result = completeAliases("a");
    // "a" is exact match, "abc" is prefix match, "b" is fuzzy match
    expect(result[0].value).toBe("a"); // exact match first
    expect(result.some((c) => c.value === "abc")).toBe(true); // prefix match
  });
});
