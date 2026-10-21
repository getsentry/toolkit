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
  completeCachedEntities,
  completeDashboards,
  completeIssues,
  completeOrgSlashProject,
  completeOrgSlugs,
  completeProjectCreateSpec,
  completeProjectSlugs,
  getCompletions,
} from "../../src/lib/complete.js";
import {
  cacheCompletionEntities,
  DASHBOARD_ENTITY,
  ISSUE_ENTITY,
} from "../../src/lib/db/completion-cache.js";
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
  orgs: { slug: string; name: string; regionUrl?: string }[],
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
  }[],
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
      "fingerprint",
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
      getCompletions(["project", "create", "api:node"], "worker:java"),
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
      true,
    );
  });

  test("matches every valid platform after a partial", () => {
    const result = completeProjectCreateSpec("acme/app:nintendo");

    expect(result).toEqual([
      { value: "acme/app:nintendo-switch", description: "Platform" },
    ]);
  });

  test("tolerates a typo in an unfinished platform name", () => {
    expect(completeProjectCreateSpec("example:javascipt-r")).toContainEqual({
      value: "example:javascript-react",
      description: "Platform",
    });
  });

  test("does not complete existing project names before the colon", () => {
    expect(completeProjectCreateSpec("acme/new-project")).toEqual([]);
  });

  test("does not complete project specifications containing whitespace", () => {
    expect(completeProjectCreateSpec("My App:java")).toEqual([]);
  });

  test.each([":java", "acme/:java", "/app:java", "acme/app/child:java"])(
    "does not complete a malformed project target in %s",
    (partial) => {
      expect(completeProjectCreateSpec(partial)).toEqual([]);
    },
  );
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

  test("tolerates a typo in an unfinished organization name", async () => {
    await seedOrgs([{ slug: "frontend-web", name: "Frontend web" }]);

    expect(completeOrgSlugs("frone")).toEqual([
      { value: "frontend-web", description: "Frontend web" },
    ]);
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

  test("does not treat the organization before a slash as unfinished", async () => {
    await seedOrgs([{ slug: "frontend-web", name: "Frontend web" }]);
    await seedProjects([
      {
        orgId: "1",
        projectId: "10",
        orgSlug: "frontend-web",
        projectSlug: "backend",
        projectName: "Backend",
      },
    ]);

    expect(completeOrgSlashProject("frone/")).toEqual([]);
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

  test("tolerates a typo in an unfinished project name", async () => {
    await seedProjects([
      {
        orgId: "1",
        projectId: "10",
        orgSlug: "my-org",
        projectSlug: "frontend-web",
        projectName: "Frontend web",
      },
    ]);

    expect(completeProjectSlugs("frone", "my-org")).toEqual([
      { value: "my-org/frontend-web", description: "Frontend web" },
    ]);
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
      "fingerprint",
    );

    const result = completeAliases("");
    expect(result).toHaveLength(2);

    const aCompletion = result.find((c) => c.value === "a");
    expect(aCompletion).toBeDefined();
    expect(aCompletion!.description).toBe("my-org/frontend");
  });

  test("filters short aliases literally with the exact match first", async () => {
    setProjectAliases(
      {
        a: { orgSlug: "org", projectSlug: "proj-a" },
        b: { orgSlug: "org", projectSlug: "proj-b" },
        abc: { orgSlug: "org", projectSlug: "proj-abc" },
      },
      "fingerprint",
    );

    const result = completeAliases("a");
    expect(result.map((c) => c.value)).toEqual(["a", "abc"]);
  });
});

describe("completeCachedEntities", () => {
  test("returns nothing when no entities are cached", async () => {
    await seedOrgs([{ slug: "acme", name: "Acme" }]);
    expect(completeCachedEntities(ISSUE_ENTITY, "")).toEqual([]);
  });

  test("lists the most recently seen entities first for an empty partial", async () => {
    await seedOrgs([{ slug: "acme", name: "Acme" }]);
    cacheCompletionEntities(ISSUE_ENTITY, "acme", [
      { value: "CLI-2", label: "Newer" },
      { value: "CLI-1", label: "Older" },
    ]);

    expect(completeCachedEntities(ISSUE_ENTITY, "")).toEqual([
      { value: "CLI-2", description: "Newer" },
      { value: "CLI-1", description: "Older" },
    ]);
  });

  test("matches the partial against values and titles", async () => {
    await seedOrgs([{ slug: "acme", name: "Acme" }]);
    cacheCompletionEntities(ISSUE_ENTITY, "acme", [
      { value: "CLI-1", label: "TypeError in checkout" },
      { value: "WEB-7", label: "Timeout talking to db" },
    ]);

    expect(
      completeCachedEntities(ISSUE_ENTITY, "cli").map((c) => c.value),
    ).toEqual(["CLI-1"]);
    expect(
      completeCachedEntities(ISSUE_ENTITY, "checkout").map((c) => c.value),
    ).toEqual(["CLI-1"]);
  });

  test("only suggests entities from orgs of the active credential", async () => {
    await seedOrgs([{ slug: "acme", name: "Acme" }]);
    cacheCompletionEntities(ISSUE_ENTITY, "foreign", [{ value: "SECRET-1" }]);

    expect(completeCachedEntities(ISSUE_ENTITY, "")).toEqual([]);
  });

  test("qualifies values that exist in several orgs", async () => {
    await seedOrgs([
      { slug: "acme", name: "Acme" },
      { slug: "beta", name: "Beta" },
    ]);
    cacheCompletionEntities(ISSUE_ENTITY, "acme", [{ value: "CLI-1" }]);
    cacheCompletionEntities(ISSUE_ENTITY, "beta", [
      { value: "CLI-1" },
      { value: "API-3" },
    ]);

    expect(
      completeCachedEntities(ISSUE_ENTITY, "")
        .map((c) => c.value)
        .sort(),
    ).toEqual(["API-3", "acme/CLI-1", "beta/CLI-1"]);
  });
});

describe("completeIssues", () => {
  test("suggests org prefixes and cached short IDs", async () => {
    await seedOrgs([{ slug: "acme", name: "Acme" }]);
    cacheCompletionEntities(ISSUE_ENTITY, "acme", [
      { value: "CLI-1A", label: "Crash on start" },
    ]);

    expect(completeIssues("")).toEqual([
      { value: "acme/", description: "Acme" },
      { value: "CLI-1A", description: "Crash on start" },
    ]);
  });

  test("completes org-qualified short IDs and projects after a slash", async () => {
    await seedOrgs([{ slug: "acme", name: "Acme" }]);
    await seedProjects([
      {
        orgId: "1",
        projectId: "10",
        orgSlug: "acme",
        projectSlug: "cli",
        projectName: "CLI",
      },
    ]);
    cacheCompletionEntities(ISSUE_ENTITY, "acme", [
      { value: "CLI-1A", label: "Crash on start" },
    ]);

    expect(completeIssues("acme/cl")).toEqual([
      { value: "acme/cli", description: "CLI" },
      { value: "acme/CLI-1A", description: "Crash on start" },
    ]);
    expect(completeIssues("nope/")).toEqual([]);
  });

  test("is used by issue commands", async () => {
    await seedOrgs([{ slug: "acme", name: "Acme" }]);
    cacheCompletionEntities(ISSUE_ENTITY, "acme", [{ value: "CLI-1A" }]);

    for (const command of [
      ["issue", "view"],
      ["issue", "resolve"],
      ["issue", "merge", "CLI-9"],
      ["event", "list"],
    ]) {
      expect(getCompletions(command, "CLI").map((c) => c.value)).toContain(
        "CLI-1A",
      );
    }
    // List commands take an org/project target, not an issue.
    expect(
      getCompletions(["issue", "list"], "CLI").map((c) => c.value),
    ).not.toContain("CLI-1A");
  });
});

describe("completeDashboards", () => {
  test("suggests org prefixes and org-qualified dashboard IDs first", async () => {
    await seedOrgs([{ slug: "acme", name: "Acme" }]);
    cacheCompletionEntities(DASHBOARD_ENTITY, "acme", [
      { value: "12", label: "Errors" },
    ]);

    expect(completeDashboards("", [])).toEqual([
      { value: "acme/", description: "Acme" },
      { value: "acme/12", description: "Errors" },
    ]);
    // A title finds its ID.
    expect(completeDashboards("err", [])).toEqual([
      { value: "acme/12", description: "Errors" },
    ]);
    expect(completeDashboards("acme/", [])).toEqual([
      { value: "acme/12", description: "Errors" },
    ]);
  });

  test("suggests bare IDs after an org positional", async () => {
    await seedOrgs([
      { slug: "acme", name: "Acme" },
      { slug: "beta", name: "Beta" },
    ]);
    cacheCompletionEntities(DASHBOARD_ENTITY, "acme", [
      { value: "12", label: "Errors" },
    ]);
    cacheCompletionEntities(DASHBOARD_ENTITY, "beta", [
      { value: "34", label: "Latency" },
    ]);

    expect(completeDashboards("", ["acme/"])).toEqual([
      { value: "12", description: "Errors" },
    ]);
    expect(completeDashboards("", ["--web", "beta"])).toEqual([
      { value: "34", description: "Latency" },
    ]);
    expect(completeDashboards("", ["acme/", "12"])).toEqual([]);
  });

  test("is used by dashboard commands that take an existing dashboard", async () => {
    await seedOrgs([{ slug: "acme", name: "Acme" }]);
    cacheCompletionEntities(DASHBOARD_ENTITY, "acme", [{ value: "12" }]);

    for (const command of [
      ["dashboard", "view"],
      ["dashboard", "revisions"],
      ["dashboard", "widget", "edit"],
    ]) {
      expect(getCompletions(command, "acme/").map((c) => c.value)).toEqual([
        "acme/12",
      ]);
    }
  });
});
