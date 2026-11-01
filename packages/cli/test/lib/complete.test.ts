/**
 * Completion Engine Tests
 *
 * Tests for the shell completion engine (src/lib/complete.ts).
 * Uses a real SQLite database via useTestConfigDir for realistic
 * cache interaction tests.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  completeAliases,
  completeOrgSlashProject,
  completeOrgSlugs,
  completeProjectCreateSpec,
  completeProjectSlugs,
  getCompletions,
} from "../../src/lib/complete.js";
import { setAuthToken } from "../../src/lib/db/auth.js";
import { cacheCompletionEntities } from "../../src/lib/db/completion-cache.js";
import { setProjectAliases } from "../../src/lib/db/project-aliases.js";
import { setCachedProject } from "../../src/lib/db/project-cache.js";
import { setUserInfo } from "../../src/lib/db/user.js";
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
    const result = await getCompletions(["unknown", "cmd"], "");
    expect(result).toEqual([]);
  });

  test("returns org/project completions for issue list", async () => {
    await seedOrgs([{ slug: "my-org", name: "My Organization" }]);
    const result = await getCompletions(["issue", "list"], "");
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].value).toBe("my-org/");
  });

  test("returns org-only completions for org view", async () => {
    await seedOrgs([{ slug: "my-org", name: "My Organization" }]);
    const result = await getCompletions(["org", "view"], "");
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].value).toBe("my-org"); // no trailing slash
  });

  test("still provides completions after boolean flags", async () => {
    await seedOrgs([{ slug: "my-org", name: "My Organization" }]);
    // After --verbose (a boolean flag), completions should still work
    const result = await getCompletions(["issue", "list", "--verbose"], "");
    expect(result.length).toBeGreaterThan(0);
  });

  test("returns nothing for the value of a flag without a completer", async () => {
    await seedOrgs([{ slug: "my-org", name: "My Organization" }]);
    expect(await getCompletions(["issue", "list", "--limit"], "")).toEqual([]);
    expect(await getCompletions(["issue", "list", "-n"], "")).toEqual([]);
    // Once the value is given, the next word is a target again.
    expect(
      (await getCompletions(["issue", "list", "--period", "7d"], "")).length,
    ).toBeGreaterThan(0);
    expect(
      (await getCompletions(["issue", "list", "--period=7d"], "")).length,
    ).toBeGreaterThan(0);
  });

  test("ends a flag's value at the next flag", async () => {
    await seedOrgs([{ slug: "my-org", name: "My Organization" }]);
    // `--time-series` may be given without a value (`inferEmpty`), so the
    // next flag is a flag, not its value.
    expect(
      (await getCompletions(["explore", "--time-series", "--period"], "")).map(
        (c) => c.value,
      ),
    ).toContain("24h");
    expect(
      (await getCompletions(["explore", "--time-series", "-t"], "")).map(
        (c) => c.value,
      ),
    ).toContain("24h");
    // Without a following flag, the next word is still its value.
    expect(await getCompletions(["explore", "--time-series"], "")).toEqual([]);
  });

  test("completes --period values", async () => {
    expect(await getCompletions(["issue", "list", "--period"], "")).toEqual([
      { value: "1h", description: "Last hour" },
      { value: "24h", description: "Last 24 hours" },
      { value: "7d", description: "Last 7 days" },
      { value: "14d", description: "Last 14 days" },
      { value: "30d", description: "Last 30 days" },
      { value: "90d", description: "Last 90 days" },
    ]);
    expect(
      (await getCompletions(["dashboard", "view", "-t"], "1")).map(
        (c) => c.value,
      ),
    ).toEqual(["1s", "1m", "1h", "1d", "1w"]);
    expect(await getCompletions(["log", "list", "--period"], "2024-")).toEqual(
      [],
    );
  });

  test("completes issue search terms in --query", async () => {
    const values = async (words: string[], partial: string) =>
      (await getCompletions(words, partial)).map((c) => c.value);

    expect(await values(["issue", "list", "--query"], "is:unr")).toEqual([
      "is:unresolved",
    ]);
    expect(await values(["issue", "list", "-q"], "level:error is:reg")).toEqual(
      ["level:error is:regressed"],
    );
    expect(await values(["issue", "list", "-q"], "level:w")).toEqual([
      "level:warning",
    ]);
    expect(await values(["feedback", "list", "-q"], "")).toEqual([
      "is:",
      "level:",
    ]);
  });

  test("returns org/project completions for project list", async () => {
    await seedOrgs([{ slug: "test-org", name: "Test" }]);
    const result = await getCompletions(["project", "list"], "test");
    expect(result.some((c) => c.value === "test-org/")).toBe(true);
  });

  test("returns org/project completions for the top-level explore command", async () => {
    await seedOrgs([{ slug: "my-org", name: "My Organization" }]);
    const result = await getCompletions(["explore"], "");
    expect(result.some((c) => c.value === "my-org/")).toBe(true);
  });

  test("returns org-only completions for team list", async () => {
    await seedOrgs([{ slug: "acme", name: "Acme Inc" }]);
    const result = await getCompletions(["team", "list"], "");
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

    expect(await getCompletions(["project", "create"], "")).toEqual([
      { value: "acme/", description: "Acme Inc" },
    ]);
    expect(await getCompletions(["project", "create"], "acme/new")).toEqual([]);
    expect(
      await getCompletions(["project", "create"], "web:java"),
    ).toContainEqual({
      value: "web:javascript",
      description: "Platform",
    });
    // Platform must always be attached with ":" — a bare positional never
    // gets legacy space-separated platform completions.
    expect(await getCompletions(["project", "create", "web"], "java")).toEqual(
      [],
    );
  });

  test("completes a new batch pair's platform regardless of preceding pairs", async () => {
    // Completion only ever looks at the current partial — a self-contained
    // colon pair completes the same way no matter what preceded it.
    expect(
      await getCompletions(["project", "create", "api:node"], "worker:java"),
    ).toContainEqual({
      value: "worker:javascript",
      description: "Platform",
    });
    expect(
      await getCompletions(["project", "create", "--team"], "back"),
    ).toEqual([]);
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

describe("getCompletions: cached entities", () => {
  /** Issue suggestions for `issue view <partial>`, without org prefixes. */
  async function issues(partial: string) {
    return (await getCompletions(["issue", "view"], partial)).filter(
      (c) => !c.value.endsWith("/"),
    );
  }

  test("returns nothing when no entities are cached", async () => {
    await seedOrgs([{ slug: "acme", name: "Acme" }]);
    expect(await issues("")).toEqual([]);
  });

  test("lists the most recently seen entities first for an empty partial", async () => {
    await seedOrgs([{ slug: "acme", name: "Acme" }]);
    cacheCompletionEntities("issue", "acme", [
      { value: "CLI-2", label: "Newer" },
      { value: "CLI-1", label: "Older" },
    ]);

    expect(await issues("")).toEqual([
      { value: "CLI-2", description: "Newer" },
      { value: "CLI-1", description: "Older" },
    ]);
  });

  test("matches the partial against values and titles", async () => {
    await seedOrgs([{ slug: "acme", name: "Acme" }]);
    cacheCompletionEntities("issue", "acme", [
      { value: "CLI-1", label: "TypeError in checkout" },
      { value: "WEB-7", label: "Timeout talking to db" },
    ]);

    expect((await issues("cli")).map((c) => c.value)).toEqual(["CLI-1"]);
    expect((await issues("checkout")).map((c) => c.value)).toEqual(["CLI-1"]);
  });

  test("only suggests entities from orgs of the active credential", async () => {
    await seedOrgs([{ slug: "acme", name: "Acme" }]);
    cacheCompletionEntities("issue", "foreign", [{ value: "SECRET-1" }]);

    expect(await issues("")).toEqual([]);
  });

  test("names the org of every value when several orgs are known", async () => {
    await seedOrgs([
      { slug: "acme", name: "Acme" },
      { slug: "beta", name: "Beta" },
    ]);
    cacheCompletionEntities("issue", "acme", [{ value: "CLI-1" }]);
    cacheCompletionEntities("issue", "beta", [
      { value: "CLI-1" },
      { value: "API-3" },
    ]);

    expect((await issues("")).map((c) => c.value).sort()).toEqual([
      "acme/CLI-1",
      "beta/API-3",
      "beta/CLI-1",
    ]);
  });
});

describe("getCompletions: issues", () => {
  test("suggests org prefixes and cached short IDs", async () => {
    await seedOrgs([{ slug: "acme", name: "Acme" }]);
    cacheCompletionEntities("issue", "acme", [
      { value: "CLI-1A", label: "Crash on start" },
    ]);

    expect(await getCompletions(["issue", "view"], "")).toEqual([
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
    cacheCompletionEntities("issue", "acme", [
      { value: "CLI-1A", label: "Crash on start" },
    ]);

    expect(await getCompletions(["issue", "view"], "acme/cl")).toEqual([
      { value: "acme/cli", description: "CLI" },
      { value: "acme/CLI-1A", description: "Crash on start" },
    ]);
    expect(await getCompletions(["issue", "view"], "nope/")).toEqual([]);
  });

  test("reads the org with the target parser the commands use", async () => {
    await seedOrgs([{ slug: "acme", name: "Acme" }]);
    cacheCompletionEntities("issue", "acme", [{ value: "CLI-1A" }]);

    // A display-name org is normalized like `issue view` would.
    expect(
      (await getCompletions(["issue", "view"], "Acme/CLI")).map((c) => c.value),
    ).toEqual(["acme/CLI-1A"]);
    // Input the parser rejects, and pasted URLs, are not targets to extend.
    expect(await getCompletions(["issue", "view"], "acme/cli/x/y")).toEqual([]);
    expect(
      await getCompletions(["issue", "view"], "https://acme.sentry.io/issues/"),
    ).toEqual([]);
  });

  test("is used by issue commands", async () => {
    await seedOrgs([{ slug: "acme", name: "Acme" }]);
    cacheCompletionEntities("issue", "acme", [{ value: "CLI-1A" }]);

    for (const command of [
      ["issue", "view"],
      ["issue", "resolve"],
      ["issue", "merge", "CLI-9"],
      ["event", "list"],
    ]) {
      expect(
        (await getCompletions(command, "CLI")).map((c) => c.value),
      ).toContain("CLI-1A");
    }
    // List commands take an org/project target, not an issue.
    expect(
      (await getCompletions(["issue", "list"], "CLI")).map((c) => c.value),
    ).not.toContain("CLI-1A");
  });

  test("skips positionals that do not take an issue", async () => {
    await seedOrgs([{ slug: "acme", name: "Acme" }]);
    cacheCompletionEntities("issue", "acme", [{ value: "CLI-1A" }]);

    // `issue link <issue> <url>`: the second positional is a URL.
    expect(
      (await getCompletions(["issue", "link"], "CLI")).map((c) => c.value),
    ).toContain("CLI-1A");
    expect(await getCompletions(["issue", "link", "CLI-1A"], "")).toEqual([]);
    expect(await getCompletions(["issue", "unlink", "CLI-1A"], "")).toEqual([]);
    expect(await getCompletions(["issue", "resolve", "CLI-1A"], "")).toEqual(
      [],
    );
    // Variadic issue commands complete every positional.
    expect(
      (await getCompletions(["issue", "view", "CLI-9"], "CLI")).map(
        (c) => c.value,
      ),
    ).toContain("CLI-1A");
  });
});

describe("getCompletions: dashboards", () => {
  test("suggests org prefixes and dashboard IDs", async () => {
    await seedOrgs([{ slug: "acme", name: "Acme" }]);
    cacheCompletionEntities("dashboard", "acme", [
      { value: "12", label: "Errors" },
    ]);

    // Always `org/<id>`, even with one org: a bare ID would be read in the
    // auto-detected org.
    expect(await getCompletions(["dashboard", "view"], "")).toEqual([
      { value: "acme/", description: "Acme" },
      { value: "acme/12", description: "Errors" },
    ]);
    // A title finds its ID.
    expect(await getCompletions(["dashboard", "view"], "err")).toEqual([
      { value: "acme/12", description: "Errors" },
    ]);
    expect(await getCompletions(["dashboard", "view"], "acme/")).toEqual([
      { value: "acme/12", description: "Errors" },
    ]);
  });

  test("completes only the first positional", async () => {
    await seedOrgs([{ slug: "acme", name: "Acme" }]);
    cacheCompletionEntities("dashboard", "acme", [
      { value: "12", label: "Errors" },
    ]);

    // In `<org/project> <id-or-title>`, the second word is not completed.
    expect(await getCompletions(["dashboard", "view", "acme/"], "")).toEqual(
      [],
    );
  });

  test("skips flag values when counting positionals", async () => {
    await seedOrgs([{ slug: "acme", name: "Acme" }]);
    cacheCompletionEntities("dashboard", "acme", [
      { value: "12", label: "Errors" },
    ]);

    // The value of --period is a period, not a dashboard.
    expect(
      (await getCompletions(["dashboard", "view", "--period"], "")).map(
        (c) => c.value,
      ),
    ).not.toContain("acme/12");
    expect(
      await getCompletions(["dashboard", "restore", "acme", "--revision"], ""),
    ).toEqual([]);
    // `7d` is the flag value, so the next word is still the first positional.
    expect(
      await getCompletions(["dashboard", "view", "--period", "7d"], "acme/"),
    ).toEqual([{ value: "acme/12", description: "Errors" }]);
    // Boolean flags do not consume a value.
    expect(
      await getCompletions(["dashboard", "view", "--web"], "acme/"),
    ).toEqual([{ value: "acme/12", description: "Errors" }]);
  });

  test("is used by dashboard commands that take an existing dashboard", async () => {
    await seedOrgs([{ slug: "acme", name: "Acme" }]);
    cacheCompletionEntities("dashboard", "acme", [{ value: "12" }]);

    for (const command of [
      ["dashboard", "view"],
      ["dashboard", "revisions"],
      ["dashboard", "widget", "edit"],
    ]) {
      expect(
        (await getCompletions(command, "acme/")).map((c) => c.value),
      ).toEqual(["acme/12"]);
    }
  });
});

/** Values of the completions for `words` and `partial`. */
async function values(words: string[], partial: string): Promise<string[]> {
  return (await getCompletions(words, partial)).map((c) => c.value);
}

describe("getCompletions: paths", () => {
  // A file, a dotfile, a directory, and a link to it
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "complete-paths-"));
    writeFileSync(join(dir, "app.wasm"), "");
    writeFileSync(join(dir, ".env"), "");
    mkdirSync(join(dir, "dist"));
    symlinkSync(join(dir, "dist"), join(dir, "out"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("file positionals list files and directories, directories with a slash", async () => {
    expect(await values(["wasm-split"], `${dir}/`)).toEqual([
      `${dir}/app.wasm`,
      `${dir}/dist/`,
      `${dir}/out/`,
    ]);
    expect(await values(["wasm-split"], `${dir}/a`)).toEqual([
      `${dir}/app.wasm`,
    ]);
  });

  test("dotfiles are listed only for a partial starting with a dot", async () => {
    expect(await values(["wasm-split"], `${dir}/.`)).toEqual([`${dir}/.env`]);
  });

  test("directory positionals list directories only", async () => {
    expect(await values(["sourcemap", "upload"], `${dir}/`)).toEqual([
      `${dir}/dist/`,
      `${dir}/out/`,
    ]);
  });

  test("init completes targets, or directories once the word looks like a path", async () => {
    await seedOrgs([{ slug: "acme", name: "Acme Inc" }]);
    expect(await values(["init"], "ac")).toEqual(["acme/"]);
    expect(await values(["init"], `${dir}/`)).toEqual([
      `${dir}/dist/`,
      `${dir}/out/`,
    ]);
    // Bare names would be read as a target, so a path keeps its prefix
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect(await values(["init", "acme/"], ".")).toEqual([
        "./dist/",
        "./out/",
      ]);
      // After a target, only a directory can follow
      expect(await values(["init", "acme/"], "d")).toEqual(["./dist/"]);
      // After a directory, only a target can follow; after both, nothing
      expect(await values(["init", "./dist"], "ac")).toEqual(["acme/"]);
      expect(await values(["init", "./dist"], "./")).toEqual([]);
      expect(await values(["init", "acme/", "./dist"], "")).toEqual([]);
    } finally {
      process.chdir(cwd);
    }
  });

  test("a partial in a missing directory completes nothing", async () => {
    expect(await values(["wasm-split"], `${dir}/missing/a`)).toEqual([]);
  });
});

describe("getCompletions: fixed values", () => {
  test("choice positionals complete their values by prefix", async () => {
    expect(await values(["cli", "completion"], "")).toEqual([
      "bash",
      "zsh",
      "fish",
    ]);
    expect(await values(["cli", "completion"], "z")).toEqual(["zsh"]);
    expect(await values(["cli", "upgrade"], "n")).toEqual(["nightly"]);
  });

  test("a variadic choice positional completes its first word only", async () => {
    expect(await values(["cli", "defaults"], "tel")).toEqual(["telemetry"]);
    expect(await values(["cli", "defaults", "telemetry"], "")).toEqual([]);
  });

  test("enum flags complete their values", async () => {
    expect(await values(["event", "send", "--level"], "w")).toEqual([
      "warning",
    ]);
  });

  test("text positionals complete nothing", async () => {
    expect(await getCompletions(["cli", "feedback"], "")).toEqual([]);
  });

  test("flags of shared parsers complete the values those parsers accept", async () => {
    expect(await values(["issue", "list", "--cursor"], "")).toEqual([
      "next",
      "prev",
      "first",
    ]);
    expect(await values(["log", "list", "--sort"], "o")).toEqual(["oldest"]);
    expect(await values(["trace", "view", "--spans"], "")).toEqual([
      "all",
      "no",
    ]);
    expect(await values(["cli", "setup", "--channel"], "n")).toEqual([
      "nightly",
    ]);
  });

  test("flags of a command's own parsers complete their values", async () => {
    expect(await values(["issue", "list", "--sort"], "f")).toEqual(["freq"]);
    expect(await values(["api", "-X"], "P")).toEqual(["POST", "PUT", "PATCH"]);
  });

  test("--fields completes the next field of the list", async () => {
    expect(await values(["issue", "view", "--fields"], "id,ti")).toEqual([
      "id,title",
    ]);
    expect(
      await values(["issue", "view", "--fields"], "id,title,"),
    ).not.toContain("id,title,id");
    expect(await values(["issue", "view", "--fields"], "project.s")).toEqual([
      "project.slug",
    ]);
  });

  test("list flags complete fixed values one item at a time", async () => {
    expect(
      await values(["auth", "login", "--scope"], "org:read,org:wr"),
    ).toEqual(["org:read,org:write"]);
  });

  test("platform flags complete platforms", async () => {
    const [best] = await values(["project", "list", "--platform"], "python-dj");
    expect(best).toBe("python-django");
    expect(await values(["event", "send", "--platform"], "")).toContain(
      "javascript",
    );
  });
});

describe("getCompletions: command paths", () => {
  test("help completes route names one segment per word", async () => {
    expect(await getCompletions(["help"], "aler")).toEqual([
      { value: "alert", description: expect.any(String) },
    ]);
    expect(await values(["help", "alert"], "")).toEqual(["issues", "metrics"]);
    expect(await values(["help", "alert", "issues"], "l")).toEqual(["list"]);
    expect(await values(["help", "alert", "issues", "list"], "")).toEqual([]);
  });

  test("words naming a nested route group complete its subcommands", async () => {
    expect(await values(["alert", "issues"], "")).toContain("list");
    expect(await values(["dashboard", "widget"], "e")).toEqual(["edit"]);
    // The shell scripts complete the first two levels themselves.
    expect(await values(["alert"], "")).toEqual([]);
  });
});

describe("getCompletions: flag names", () => {
  test("a partial starting with - completes the command's flags with their briefs", async () => {
    expect(await getCompletions(["issue", "list"], "--li")).toEqual([
      { value: "--limit", description: "Maximum number of issues to list" },
    ]);
    const all = await values(["issue", "list"], "-");
    // Booleans and aliases too, but not hidden flags
    expect(all).toEqual(expect.arrayContaining(["--json", "--limit", "-n"]));
    expect(all).not.toContain("--log-level");
    expect(await values(["issue", "list"], "--")).not.toContain("-n");
  });

  test("nested commands complete their own flags", async () => {
    expect(await values(["alert", "issues", "list"], "--li")).toEqual([
      "--limit",
    ]);
    expect(await values(["dashboard", "widget", "add"], "--q")).toEqual([
      "--query",
    ]);
  });

  test("flags already given are left out, by any spelling", async () => {
    for (const given of [["--limit", "5"], ["-n", "5"], ["--limit=5"]]) {
      const remaining = await values(["issue", "list", ...given], "-");
      expect(remaining).not.toContain("--limit");
      expect(remaining).not.toContain("-n");
    }
    expect(await values(["issue", "list", "--json"], "--j")).toEqual([]);
  });

  test("variadic flags may be given again", async () => {
    expect(
      await values(["alert", "issues", "create", "--action", "{}"], "--act"),
    ).toEqual(["--action"]);
  });

  test("a flag after one that takes a value is a flag, not its value", async () => {
    expect(await values(["issue", "list", "--limit"], "--j")).toEqual([
      "--json",
    ]);
  });
});

describe("getCompletions: accounts", () => {
  function addAccount(host: string, email: string, userId: string): void {
    setAuthToken(`token-${userId}-${host}`, undefined, undefined, {
      host,
      newAccount: true,
    });
    setUserInfo({ userId, email });
  }

  test("completes stored accounts, qualified by server when ambiguous", async () => {
    addAccount("https://sentry.io", "jane@acme.com", "1");
    addAccount("https://sentry.io", "bob@other.dev", "2");
    addAccount("https://sentry.example.com", "bob@other.dev", "3");

    expect(await getCompletions(["auth", "switch"], "jane")).toEqual([
      { value: "jane@acme.com", description: "sentry.io" },
    ]);
    expect((await values(["auth", "logout"], "bob")).sort()).toEqual([
      "bob@other.dev:sentry.example.com",
      "bob@other.dev:sentry.io",
    ]);
  });
});

describe("getCompletions: flag values that name cached entities", () => {
  test("completes a flag from the org the target names, else every org", async () => {
    await seedOrgs([
      { slug: "acme", name: "Acme" },
      { slug: "beta", name: "Beta" },
    ]);
    cacheCompletionEntities("environment", "acme", [{ value: "production" }]);
    cacheCompletionEntities("environment", "beta", [
      { value: "staging" },
      { value: "production" },
    ]);
    const create = ["alert", "metrics", "create"];

    expect(await values([...create, "acme/cli", "--environment"], "")).toEqual([
      "production",
    ]);
    expect((await values([...create, "--environment"], "")).sort()).toEqual([
      "production",
      "staging",
    ]);
  });

  test("completes the last item of a comma-separated list", async () => {
    await seedOrgs([{ slug: "acme", name: "Acme" }]);
    cacheCompletionEntities("environment", "acme", [
      { value: "production" },
      { value: "staging" },
    ]);

    expect(
      await values(["release", "list", "--environment"], "production,"),
    ).toEqual(["production,staging"]);
  });

  test("completes owners as team actors, matched by team slug", async () => {
    await seedOrgs([{ slug: "acme", name: "Acme" }]);
    cacheCompletionEntities("owner", "acme", [
      { value: "team:7", label: "#backend" },
      { value: "team:9", label: "#frontend" },
    ]);

    expect(
      await getCompletions(["alert", "issues", "create", "--owner"], "back"),
    ).toEqual([{ value: "team:7", description: "#backend" }]);
  });

  test("issue link completes integrations, apps, and app form fields", async () => {
    await seedOrgs([{ slug: "acme", name: "Acme" }]);
    cacheCompletionEntities("integration", "acme", [
      { value: "99", label: "Jira: acme-jira" },
    ]);
    cacheCompletionEntities("sentry-app", "acme", [
      { value: "linear", label: "Linear" },
    ]);
    cacheCompletionEntities("app-link-field", "acme", [
      { value: "priority=", label: "tracker, required" },
      { value: "priority=high", label: "tracker, required" },
    ]);

    expect(
      await getCompletions(["issue", "link", "--integration"], "jira"),
    ).toEqual([{ value: "99", description: "Jira: acme-jira" }]);
    expect(await values(["issue", "unlink", "--app"], "")).toEqual(["linear"]);
    expect(await values(["issue", "link", "--field"], "prio")).toContain(
      "priority=",
    );
    expect(await values(["issue", "link", "--field"], "priority=h")).toEqual([
      "priority=high",
    ]);
  });

  test("issue merge --into completes issues", async () => {
    await seedOrgs([{ slug: "acme", name: "Acme" }]);
    cacheCompletionEntities("issue", "acme", [{ value: "CLI-1A" }]);

    expect(
      await values(["issue", "merge", "CLI-1A", "CLI-2B", "--into"], "CLI"),
    ).toContain("CLI-1A");
  });

  test("monitor run completes a monitor slug, then nothing for the command", async () => {
    await seedOrgs([{ slug: "acme", name: "Acme" }]);
    cacheCompletionEntities("monitor", "acme", [
      { value: "nightly", label: "Nightly job" },
    ]);

    expect(await values(["monitor", "run"], "")).toEqual(["nightly"]);
    expect(await values(["monitor", "run", "nightly", "--"], "")).toEqual([]);
  });

  test("completes comma-separated project slugs of the target org", async () => {
    await seedOrgs([{ slug: "acme", name: "Acme" }]);
    await seedProjects([
      {
        orgId: "1",
        projectId: "10",
        orgSlug: "acme",
        projectSlug: "cli",
        projectName: "CLI",
      },
      {
        orgId: "1",
        projectId: "11",
        orgSlug: "acme",
        projectSlug: "web",
        projectName: "Web",
      },
    ]);

    expect(
      await values(["release", "create", "acme/1.0.0", "--project"], "cli,"),
    ).toEqual(["cli,web"]);
  });
});

describe("getCompletions: issue archive --until", () => {
  const until = (partial: string) =>
    values(["issue", "archive", "CLI-1", "--until"], partial);

  test("offers the keywords and duration presets", async () => {
    expect(await until("")).toEqual(
      expect.arrayContaining(["forever", "auto", "1h", "7d"]),
    );
    expect(await until("f")).toEqual(["forever"]);
  });

  test("completes a number to counts and durations", async () => {
    expect(await until("10")).toEqual([
      "10x",
      "10u",
      "10s",
      "10m",
      "10h",
      "10d",
      "10w",
    ]);
  });

  test("offers a count's window, which completes like a duration", async () => {
    expect(await until("10x")).toEqual(["10x", "10x/"]);
    expect(await until("10x/")).toEqual(
      expect.arrayContaining(["10x/1h", "10x/24h"]),
    );
    expect(await until("10u/5")).toEqual(
      expect.arrayContaining(["10u/5m", "10u/5h"]),
    );
  });
});

describe("getCompletions: api endpoints", () => {
  test("completes API paths one segment at a time", async () => {
    await seedOrgs([{ slug: "acme", name: "Acme" }]);

    expect(await values(["api"], "organiz")).toEqual(["organizations/"]);
    expect(await getCompletions(["api"], "organizations/")).toEqual([
      { value: "organizations/acme/", description: "Acme" },
    ]);
    const orgPaths = await values(["api"], "organizations/acme/iss");
    expect(orgPaths).toContain("organizations/acme/issues/");
    expect(
      orgPaths.every((path) => path.startsWith("organizations/acme/iss")),
    ).toBe(true);
  });

  test("keeps the /api/0/ prefix as typed", async () => {
    expect(await values(["api"], "/api/0/organiz")).toEqual([
      "/api/0/organizations/",
    ]);
  });
});

describe("getCompletions: account servers", () => {
  test("completes the servers of stored accounts", async () => {
    setAuthToken("token-1", undefined, undefined, {
      host: "https://sentry.example.com",
      newAccount: true,
    });
    setUserInfo({ userId: "1", email: "jane@acme.com" });

    expect(
      await getCompletions(["auth", "switch", "--url"], "https://sentry.ex"),
    ).toEqual([
      { value: "https://sentry.example.com", description: "jane@acme.com" },
    ]);
  });
});

describe("getCompletions: fixed values from the modules that validate them", () => {
  test("metric alert windows, grid positions, providers, and aggregations", async () => {
    expect(
      await values(["alert", "metrics", "create", "--time-window"], "1"),
    ).toEqual(["1", "10", "15", "120", "1440"]);
    expect(await values(["dashboard", "widget", "add", "--col"], "")).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
    expect(
      await values(["dashboard", "widget", "edit", "--width"], "6"),
    ).toEqual(["6"]);
    expect(await values(["build", "upload", "--vcs-provider"], "git")).toEqual([
      "github",
      "github_enterprise",
      "gitlab",
    ]);
    expect(await values(["explore", "--agg"], "p9")).toEqual([
      "p90",
      "p95",
      "p99",
    ]);
  });

  test("event send --user offers the keys with their own User field", async () => {
    expect(await values(["event", "send", "--user"], "")).toEqual([
      "id:",
      "email:",
      "ip_address:",
      "username:",
    ]);
  });

  test("sourcemap --ext completes the default extensions as a list", async () => {
    expect(await values(["sourcemap", "inject", "--ext"], ".js,.m")).toEqual([
      ".js,.mjs",
    ]);
  });
});
