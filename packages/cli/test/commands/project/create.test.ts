/**
 * Project Create Command Tests
 *
 * Tests for the project create command in src/commands/project/create.ts.
 * Covers the public Stricli parser contract and uses mocked API boundaries for
 * command behavior without real HTTP calls.
 */

import { run } from "@stricli/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { app } from "../../../src/app.js";
import { createCommand } from "../../../src/commands/project/create.js";
import type { SentryContext } from "../../../src/context.js";
import type { CreatedProjectDetails } from "../../../src/lib/api-client.js";

// Auto-mock at the definition site so internal calls (e.g. createProjectWithDsn
// calling createProject within projects.js) are intercepted. All exports become
// vi.fn() stubs that tests configure via mockResolvedValue in beforeEach.
vi.mock("../../../src/lib/api/projects.js");
vi.mock("../../../src/lib/api/teams.js");
vi.mock("../../../src/lib/api/organizations.js");
vi.mock("../../../src/lib/resolve-target.js");

// biome-ignore lint/performance/noNamespaceImport: needed for vi.spyOn mocking
import * as orgsApi from "../../../src/lib/api/organizations.js";
// biome-ignore lint/performance/noNamespaceImport: needed for vi.spyOn mocking
import * as projectsApi from "../../../src/lib/api/projects.js";
// biome-ignore lint/performance/noNamespaceImport: needed for vi.spyOn mocking
import * as teamsApi from "../../../src/lib/api/teams.js";
import { DEFAULT_SENTRY_URL } from "../../../src/lib/constants.js";
import { setOrgRegion } from "../../../src/lib/db/regions.js";
import {
  ApiError,
  CliError,
  ContextError,
  EXIT,
  ResolutionError,
  ValidationError,
} from "../../../src/lib/errors.js";
import type { ProjectCreatedResult } from "../../../src/lib/formatters/human.js";
// biome-ignore lint/performance/noNamespaceImport: needed for vi.spyOn mocking
import * as resolveTarget from "../../../src/lib/resolve-target.js";
import { slugify } from "../../../src/lib/utils.js";
import type { SentryProject, SentryTeam } from "../../../src/types/index.js";
import { useTestConfigDir } from "../../helpers.js";

const sampleTeam: SentryTeam = {
  id: "1",
  slug: "engineering",
  name: "Engineering",
  memberCount: 5,
  isMember: true,
};

const sampleTeam2: SentryTeam = {
  id: "2",
  slug: "mobile",
  name: "Mobile Team",
  memberCount: 3,
  isMember: true,
};

const sampleProject: SentryProject = {
  id: "999",
  slug: "my-app",
  name: "my-app",
  platform: "python",
  dateCreated: "2026-02-12T10:00:00Z",
};

/** Build an API result whose project identity matches the requested name. */
function createdProjectDetails(name: string): CreatedProjectDetails {
  const slug = slugify(name);
  return {
    project: { ...sampleProject, name, slug, platform: "node" },
    dsn: `https://${slug}@o123.ingest.us.sentry.io/999`,
    url: `https://sentry.io/organizations/acme-corp/projects/${slug}/`,
  };
}

// Isolated DB for region cache — prevents "unexpected fetch" warnings
// from resolveOrgRegion when buildOrgNotFoundError calls resolveEffectiveOrg
useTestConfigDir("test-project-create-");

function createMockContext(): {
  context: SentryContext;
  stdoutWrite: ReturnType<typeof vi.fn>;
} {
  const stdoutWrite = vi.fn(() => true);
  return {
    context: {
      process,
      env: process.env,
      stdout: { write: stdoutWrite },
      stderr: { write: vi.fn(() => true) },
      stdin: process.stdin,
      cwd: "/tmp",
      homeDir: "/tmp",
      configDir: "/tmp",
    },
    stdoutWrite,
  };
}

describe("project create", () => {
  const listTeamsSpy = vi.mocked(teamsApi.listTeams);
  // The command calls createProjectWithDsn (not createProject directly).
  // With vitest auto-mock, createProjectWithDsn is a vi.fn() stub that
  // doesn't internally call createProject, so we assert on this spy.
  const createProjectWithDsnSpy = vi.mocked(projectsApi.createProjectWithDsn);
  const createProjectWithAutoTeamSpy = vi.mocked(
    projectsApi.createProjectWithAutoTeam
  );
  const createTeamSpy = vi.mocked(teamsApi.createTeam);
  const tryGetPrimaryDsnSpy = vi.mocked(projectsApi.tryGetPrimaryDsn);
  const listOrgsSpy = vi.mocked(orgsApi.listOrganizations);
  const resolveOrgSpy = vi.mocked(resolveTarget.resolveOrg);

  beforeEach(() => {
    vi.clearAllMocks();
    // Pre-populate region cache for orgs used in tests to avoid
    // "unexpected fetch" warnings from resolveOrgRegion
    setOrgRegion("acme-corp", DEFAULT_SENTRY_URL);
    setOrgRegion("123", DEFAULT_SENTRY_URL);

    // Default mocks
    resolveOrgSpy.mockResolvedValue({ org: "acme-corp" });
    listTeamsSpy.mockResolvedValue([sampleTeam]);
    createProjectWithDsnSpy.mockResolvedValue({
      project: sampleProject,
      dsn: "https://abc@o123.ingest.us.sentry.io/999",
      url: "https://sentry.io/organizations/acme-corp/projects/my-app/",
    });
    // Default: org-scoped fallback is disabled (matches the common org config).
    createProjectWithAutoTeamSpy.mockRejectedValue(
      new ApiError(
        "Forbidden",
        403,
        "Your organization has disabled this feature for members."
      )
    );
    createTeamSpy.mockResolvedValue(sampleTeam);
    tryGetPrimaryDsnSpy.mockResolvedValue(
      "https://abc@o123.ingest.us.sentry.io/999"
    );
    listOrgsSpy.mockResolvedValue([
      { slug: "acme-corp", name: "Acme Corp" },
      { slug: "other-org", name: "Other Org" },
    ]);
  });

  afterEach(() => {
    listTeamsSpy.mockReset();
    createProjectWithDsnSpy.mockReset();
    createProjectWithAutoTeamSpy.mockReset();
    createTeamSpy.mockReset();
    tryGetPrimaryDsnSpy.mockReset();
    listOrgsSpy.mockReset();
    resolveOrgSpy.mockReset();
  });

  test("creates project with auto-detected org and single team", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await createCommand.loader();
    await func.call(context, { json: false }, "my-app:node");

    expect(createProjectWithDsnSpy).toHaveBeenCalledWith(
      "acme-corp",
      "engineering",
      {
        name: "my-app",
        platform: "node",
      }
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Created project 'my-app'");
    expect(output).toContain("acme-corp");
    expect(output).toContain("engineering");
    expect(output).toContain("https://abc@o123.ingest.us.sentry.io/999");
  });

  test("parses org/name positional syntax", async () => {
    const { context } = createMockContext();
    const func = await createCommand.loader();
    await func.call(context, { json: false }, "my-org/my-app:python");

    // resolveOrg should receive the explicit org
    expect(resolveOrgSpy).toHaveBeenCalledWith({
      org: "my-org",
      cwd: "/tmp",
    });
  });

  test.each([
    "python-flask",
    "node-mastra",
    "node-flue",
    "node-eve",
  ])("passes the paired platform %s to createProject", async (platform) => {
    const { context } = createMockContext();
    const func = await createCommand.loader();
    await func.call(context, { json: false }, `my-app:${platform}`);

    expect(createProjectWithDsnSpy).toHaveBeenCalledWith(
      "acme-corp",
      "engineering",
      {
        name: "my-app",
        platform,
      }
    );
  });

  test.each([
    ["without an org", ["my-app", "python-flask"]],
    ["with an explicit org", ["my-org/my-app", "python-flask"]],
  ])("rejects the space-separated form %s — platform must use :", async (_label, args) => {
    const { context } = createMockContext();
    const func = await createCommand.loader();

    const err = await func
      .call(context, { json: false }, ...args)
      .catch((error: Error) => error);

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain("must use <name>:<platform> syntax");
    expect(createProjectWithDsnSpy).not.toHaveBeenCalled();
  });

  test("rejects the space-separated form through Stricli", async () => {
    const { context, stdoutWrite } = createMockContext();
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    try {
      await run(
        app,
        [
          "project",
          "create",
          "my-org/my-app",
          "node",
          "--team",
          "backend",
          "--dry-run",
        ],
        context
      );

      expect(createProjectWithDsnSpy).not.toHaveBeenCalled();
      const output =
        stdoutWrite.mock.calls.join("") +
        stderrWrite.mock.calls.map(([data]) => String(data)).join("");
      expect(output).toContain("must use <name>:<platform> syntax");
    } finally {
      stderrWrite.mockRestore();
    }
  });

  test("splits historical colon-containing names on the final colon instead", async () => {
    const { context } = createMockContext();
    const func = await createCommand.loader();
    await func.call(context, { json: false }, "my-org/api:europe:node");

    expect(resolveOrgSpy).toHaveBeenCalledWith({
      org: "my-org",
      cwd: "/tmp",
    });
    expect(createProjectWithDsnSpy).toHaveBeenCalledWith(
      "acme-corp",
      "engineering",
      {
        name: "api:europe",
        platform: "node",
      }
    );
  });

  test("passes --team to skip team auto-detection", async () => {
    listTeamsSpy.mockResolvedValue([sampleTeam, sampleTeam2]);

    const { context } = createMockContext();
    const func = await createCommand.loader();
    await func.call(context, { team: "mobile", json: false }, "my-app:go");

    // listTeams should NOT be called when --team is explicit
    expect(listTeamsSpy).not.toHaveBeenCalled();
    expect(createProjectWithDsnSpy).toHaveBeenCalledWith(
      "acme-corp",
      "mobile",
      {
        name: "my-app",
        platform: "go",
      }
    );
  });

  test("auto-selects team when user is member of exactly one among many", async () => {
    const nonMemberTeam = { ...sampleTeam2, isMember: false };
    listTeamsSpy.mockResolvedValue([nonMemberTeam, sampleTeam]);

    const { context } = createMockContext();
    const func = await createCommand.loader();
    await func.call(context, { json: false }, "my-app:node");

    // Should auto-select the one team the user is a member of
    expect(createProjectWithDsnSpy).toHaveBeenCalledWith(
      "acme-corp",
      "engineering",
      {
        name: "my-app",
        platform: "node",
      }
    );
  });

  test("errors when user is member of multiple teams without --team", async () => {
    listTeamsSpy.mockResolvedValue([sampleTeam, sampleTeam2]);

    const { context } = createMockContext();
    const func = await createCommand.loader();

    const err = await func
      .call(context, { json: false }, "my-app:node")
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ContextError);
    expect(err.message).toContain("You belong to 2 teams");
    expect(err.message).toContain("engineering");
    expect(err.message).toContain("mobile");

    expect(createProjectWithDsnSpy).not.toHaveBeenCalled();
  });

  test("shows only member teams in error, not all org teams", async () => {
    const nonMemberTeam = {
      id: "3",
      slug: "infra",
      name: "Infrastructure",
      isMember: false,
    };
    listTeamsSpy.mockResolvedValue([sampleTeam, sampleTeam2, nonMemberTeam]);

    const { context } = createMockContext();
    const func = await createCommand.loader();

    const err = await func
      .call(context, { json: false }, "my-app:node")
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ContextError);
    expect(err.message).toContain("engineering");
    expect(err.message).toContain("mobile");
    // Non-member team should NOT appear
    expect(err.message).not.toContain("infra");
  });

  test("falls back to all teams when isMember is not available", async () => {
    const teamNoMembership1 = { id: "1", slug: "alpha", name: "Alpha" };
    const teamNoMembership2 = { id: "2", slug: "beta", name: "Beta" };
    listTeamsSpy.mockResolvedValue([teamNoMembership1, teamNoMembership2]);

    const { context } = createMockContext();
    const func = await createCommand.loader();

    const err = await func
      .call(context, { json: false }, "my-app:node")
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ContextError);
    expect(err.message).toContain("Multiple teams found");
    expect(err.message).toContain("alpha");
    expect(err.message).toContain("beta");
  });

  test("auto-creates team when org has no teams", async () => {
    listTeamsSpy.mockResolvedValue([]);
    createTeamSpy.mockResolvedValue({
      id: "10",
      slug: "my-app",
      name: "my-app",
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await createCommand.loader();
    await func.call(context, { json: false }, "my-app:node");

    expect(createTeamSpy).toHaveBeenCalledWith("acme-corp", "my-app");
    expect(createProjectWithDsnSpy).toHaveBeenCalledWith(
      "acme-corp",
      "my-app",
      {
        name: "my-app",
        platform: "node",
      }
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Created team 'my-app'");
    expect(output).toContain("org had no teams");
  });

  test("errors when org cannot be resolved", async () => {
    resolveOrgSpy.mockResolvedValue(null);

    const { context } = createMockContext();
    const func = await createCommand.loader();

    await expect(
      func.call(context, { json: false }, "my-app:node")
    ).rejects.toThrow(ContextError);
  });

  test("handles 409 conflict with friendly error", async () => {
    createProjectWithDsnSpy.mockRejectedValue(
      new ApiError(
        "API request failed: 409 Conflict",
        409,
        "Project already exists"
      )
    );

    const { context } = createMockContext();
    const func = await createCommand.loader();

    const err = await func
      .call(context, { json: false }, "my-app:node")
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(err.message).toContain("already exists");
    expect(err.message).toContain("sentry project view");
  });

  test("handles 404 from createProject as team-not-found with available teams", async () => {
    createProjectWithDsnSpy.mockRejectedValue(
      new ApiError("API request failed: 404 Not Found", 404)
    );

    const { context } = createMockContext();
    const func = await createCommand.loader();

    // Use --team with a slug that doesn't match any team in the org
    const err = await func
      .call(context, { team: "nonexistent", json: false }, "my-app:node")
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(err.message).toContain("Team 'nonexistent' not found");
    expect(err.message).toContain("Available teams:");
    expect(err.message).toContain("engineering");
    expect(err.message).toContain("--team <team-slug>");
  });

  test("handles 404 when auto-selected team exists — shows permission error", async () => {
    // createProject returns 404 but the auto-selected team IS in the org.
    // This used to produce a contradictory "Team 'engineering' not found"
    // while listing "engineering" as an available team.
    createProjectWithDsnSpy.mockRejectedValue(
      new ApiError("API request failed: 404 Not Found", 404)
    );
    // Default listTeams returns [sampleTeam] (slug: "engineering")
    // resolveOrCreateTeam auto-selects "engineering", then handleCreateProject404
    // calls listTeams again and finds "engineering" in the list.

    const { context } = createMockContext();
    const func = await createCommand.loader();

    const err = await func
      .call(context, { json: false }, "my-app:node")
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(err.message).toContain("exists but the request was rejected");
    expect(err.message).toContain("permission");
    // Must NOT say "not found" — the team clearly exists
    expect(err.message).not.toContain("not found");
  });

  test("handles 404 from createProject with bad org — shows user's orgs", async () => {
    createProjectWithDsnSpy.mockRejectedValue(
      new ApiError("API request failed: 404 Not Found", 404)
    );
    // listTeams also fails → org is bad
    listTeamsSpy.mockRejectedValue(
      new ApiError("API request failed: 404 Not Found", 404)
    );

    const { context } = createMockContext();
    const func = await createCommand.loader();

    const err = await func
      .call(context, { json: false, team: "backend" }, "my-app:node")
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(err.message).toContain("Organization 'acme-corp' not found");
    expect(err.message).toContain("Your organizations");
    expect(err.message).toContain("other-org");
  });

  test("handles 404 with non-404 listTeams failure — shows generic error", async () => {
    createProjectWithDsnSpy.mockRejectedValue(
      new ApiError("API request failed: 404 Not Found", 404)
    );
    // listTeams returns 403 (not 404) — can't tell if org or team is wrong
    listTeamsSpy.mockRejectedValue(
      new ApiError("API request failed: 403 Forbidden", 403)
    );

    const { context } = createMockContext();
    const func = await createCommand.loader();

    const err = await func
      .call(context, { json: false, team: "backend" }, "my-app:node")
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(err.message).toContain("could not be created");
    expect(err.message).toContain("may not exist, or you may lack access");
  });

  test("rejects invalid platform client-side without API call", async () => {
    const { context } = createMockContext();
    const func = await createCommand.loader();

    const err = await func
      .call(context, { json: false }, "my-app:javascript-node")
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).exitCode).toBe(EXIT.VALIDATION);
    expect(err.message).toContain("Invalid platform 'javascript-node'");
    expect(err.message).toContain("Did you mean?");
    expect(err.message).toContain("node");
    expect(err.message).toContain("Common platforms:");

    // Should NOT have called the API
    expect(createProjectWithDsnSpy).not.toHaveBeenCalled();
  });

  test("handles 400 invalid platform from API as safety net", async () => {
    createProjectWithDsnSpy.mockRejectedValue(
      new ApiError(
        "API request failed: 400 Bad Request",
        400,
        '{"platform":["Invalid platform"]}'
      )
    );

    const { context } = createMockContext();
    const func = await createCommand.loader();

    // Use a valid platform so client-side check passes, but API rejects
    const err = await func
      .call(context, { json: false }, "my-app:node")
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(err.message).toContain("Invalid platform 'node'");
    expect(err.message).toContain("Common platforms:");
  });

  test("wraps other API errors with context, preserving ApiError type", async () => {
    // createProjectWithDsn fails with a non-403 server error (e.g. 500).
    // The fallback is only attempted on 403; this should surface directly.
    createProjectWithDsnSpy.mockRejectedValue(
      new ApiError("Internal Server Error", 500, "Something went wrong")
    );

    const { context } = createMockContext();
    const func = await createCommand.loader();

    const err = (await func
      .call(context, { json: false }, "my-app:node")
      .catch((e: Error) => e)) as ApiError;
    // Stays ApiError (not a plain CliError wrapper) so 5xx errors are
    // captured for error reporting.
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
    expect(err.message).toContain("Failed to create project");
    expect(err.message).toContain("500");
    expect(err.format()).toContain("Something went wrong");
  });

  test("falls back to org-scoped endpoint when team-based creation 403s", async () => {
    // Simulate: member has a team (via listTeams) but can't create projects on it.
    // The fallback to POST /organizations/{org}/projects/ should kick in.
    createProjectWithDsnSpy.mockRejectedValue(
      new ApiError("Forbidden", 403, "You do not have permission")
    );
    createProjectWithAutoTeamSpy.mockResolvedValue({
      project: sampleProject,
      dsn: "https://abc@o123.ingest.us.sentry.io/999",
      url: "https://sentry.io/organizations/acme-corp/projects/my-app/",
      team_slug: "team-testuser",
    });

    const { context } = createMockContext();
    const func = await createCommand.loader();
    await func.call(context, { json: false }, "my-app:node");

    expect(createProjectWithAutoTeamSpy).toHaveBeenCalledWith("acme-corp", {
      name: "my-app",
      platform: "node",
    });
  });

  test("preserves unrelated API 400 errors for project names", async () => {
    createProjectWithDsnSpy.mockRejectedValue(
      new ApiError(
        "Bad Request",
        400,
        '{"name":["Ensure this field has no more than 50 characters."]}'
      )
    );
    const { context } = createMockContext();
    const func = await createCommand.loader();
    const err = (await func
      .call(context, { json: false }, "my-cool-app:node")
      .catch((e: Error) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.detail).toContain("no more than 50 characters");
    expect(err.message).not.toContain("separate argument");
  });

  test("preserves unrelated API 400 errors on the org-scoped fallback", async () => {
    createProjectWithDsnSpy.mockRejectedValue(
      new ApiError("Forbidden", 403, "You do not have permission")
    );
    createProjectWithAutoTeamSpy.mockRejectedValue(
      new ApiError(
        "Bad Request",
        400,
        '{"name":["Ensure this field has no more than 50 characters."]}'
      )
    );
    const { context } = createMockContext();
    const func = await createCommand.loader();
    const err = (await func
      .call(context, { json: false }, "my-cool-app:node")
      .catch((e: Error) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.message).toContain("Failed to create project 'my-cool-app'");
    expect(err.detail).toContain("no more than 50 characters");
    expect(err.message).not.toContain("separate argument");
  });

  test("handles API platform errors on the org-scoped fallback", async () => {
    createProjectWithDsnSpy.mockRejectedValue(
      new ApiError("Forbidden", 403, "You do not have permission")
    );
    createProjectWithAutoTeamSpy.mockRejectedValue(
      new ApiError(
        "API request failed: 400 Bad Request",
        400,
        '{"platform":["Invalid platform"]}'
      )
    );
    const { context } = createMockContext();
    const func = await createCommand.loader();
    const err = await func
      .call(context, { json: false }, "my-app:node")
      .catch((error: Error) => error);

    expect(err).toBeInstanceOf(CliError);
    expect(err.message).toContain("Invalid platform 'node'");
    expect(err.message).toContain("Common platforms:");
  });

  test("surfaces policy error when org has disabled member project creation", async () => {
    // Both paths 403: team-based creation fails, and the fallback returns
    // the org-level policy error ("disabled this feature").
    createProjectWithDsnSpy.mockRejectedValue(
      new ApiError("Forbidden", 403, "You do not have permission")
    );
    // createProjectWithAutoTeamSpy already defaults to "disabled this feature" 403

    const { context } = createMockContext();
    const func = await createCommand.loader();

    const err = (await func
      .call(context, { json: false }, "my-app:node")
      .catch((e: Error) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
    expect(err.message).toContain("disabled project creation for members");
  });

  test("outputs JSON when --json flag is set", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await createCommand.loader();
    await func.call(context, { json: true }, "my-app:node");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.project.slug).toBe("my-app");
    expect(parsed.dsn).toBe("https://abc@o123.ingest.us.sentry.io/999");
    expect(parsed.teamSlug).toBe("engineering");
  });

  test("handles DSN fetch failure gracefully", async () => {
    // Override to simulate DSN fetch failure inside createProjectWithDsn
    createProjectWithDsnSpy.mockResolvedValue({
      project: sampleProject,
      dsn: null,
      url: "https://sentry.io/organizations/acme-corp/projects/my-app/",
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await createCommand.loader();
    await func.call(context, { json: false }, "my-app:node");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    // Should still show project info without DSN
    expect(output).toContain("Created project 'my-app'");
    expect(output).not.toContain("ingest.us.sentry.io");
  });

  test("errors on invalid org/name syntax", async () => {
    const { context } = createMockContext();
    const func = await createCommand.loader();

    // Missing name after slash
    await expect(
      func.call(context, { json: false }, "acme-corp/:node")
    ).rejects.toThrow(ContextError);
  });

  test("shows platform in human output", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await createCommand.loader();
    await func.call(context, { json: false }, "my-app:python-django");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("python");
  });

  test("shows project URL in human output", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await createCommand.loader();
    await func.call(context, { json: false }, "my-app:node");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain(
      "sentry.io/organizations/acme-corp/projects/my-app/"
    );
  });

  test("shows slug divergence note when Sentry adjusts the slug", async () => {
    // Sentry may append a random suffix when the desired slug is taken
    createProjectWithDsnSpy.mockResolvedValue({
      project: { ...sampleProject, slug: "my-app-0g", name: "my-app" },
      dsn: "https://abc@o123.ingest.us.sentry.io/999",
      url: "https://sentry.io/organizations/acme-corp/projects/my-app-0g/",
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await createCommand.loader();
    await func.call(context, { json: false }, "my-app:node");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    // Plain mode renders code spans as plain text without padding
    expect(output).toContain("Slug my-app-0g was assigned");
    expect(output).toContain("my-app is already taken");
  });

  test("does not show slug note when slug matches name", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await createCommand.loader();
    await func.call(context, { json: false }, "my-app:node");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).not.toContain("was assigned");
  });

  test("shows helpful error when name is missing", async () => {
    const { context } = createMockContext();
    const func = await createCommand.loader();

    const err = await func
      .call(context, { json: false })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ContextError);
    expect(err.message).toContain("Project specification is required");
    expect(err.message).toContain(
      "sentry project create [<org>/]<name>:<platform>..."
    );
  });

  test.each([
    "",
    "   ",
  ])("rejects an empty project name argument (%j)", async (name) => {
    const { context } = createMockContext();
    const func = await createCommand.loader();

    const err = await func
      .call(context, { json: false }, `${name}:node`)
      .catch((error: Error) => error);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain("Project name cannot be empty");
  });

  test.each([
    "my-app",
    "my-app:",
  ])("shows a helpful error when platform is missing from %s", async (projectArg) => {
    const { context } = createMockContext();
    const func = await createCommand.loader();

    const err = await func
      .call(context, { json: false }, projectArg)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).exitCode).toBe(EXIT.VALIDATION);
    expect(err.message).toContain("Platform is required");
    expect(err.message).toContain("Common platforms:");
    expect(err.message).toContain("javascript-nextjs");
    expect(err.message).toContain("python");
    expect(err.message).toContain("Run 'sentry platform list'");
    // There is no space-separated form at all, so it must never be suggested.
    expect(err.message).not.toContain(" <platform>");
  });

  test("rejects trailing-platform batches that were never supported", async () => {
    const { context } = createMockContext();
    const func = await createCommand.loader();

    const err = await func
      .call(context, { json: false }, "web", "api", "node")
      .catch((error: Error) => error);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain("must use <name>:<platform> syntax");
    expect(createProjectWithDsnSpy).not.toHaveBeenCalled();
  });

  test("wraps listTeams API failure with org list", async () => {
    listTeamsSpy.mockRejectedValue(
      new ApiError("API request failed: 404 Not Found", 404)
    );

    const { context } = createMockContext();
    const func = await createCommand.loader();

    const err = await func
      .call(context, { json: false }, "my-app:node")
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ResolutionError);
    expect(err.message).toContain("acme-corp");
    expect(err.message).toContain("not found");
    // Should show the user's actual orgs to help them pick the right one
    expect(err.message).toContain("Your organizations");
    expect(err.message).toContain("other-org");
  });

  test("shows auto-detected org source when listTeams fails", async () => {
    resolveOrgSpy.mockResolvedValue({
      org: "123",
      detectedFrom: "test/mocks/routes.ts",
    });
    listTeamsSpy.mockRejectedValue(
      new ApiError("API request failed: 404 Not Found", 404)
    );

    const { context } = createMockContext();
    const func = await createCommand.loader();

    const err = await func
      .call(context, { json: false }, "my-app:node")
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ResolutionError);
    expect(err.message).toContain("auto-detected from test/mocks/routes.ts");
    expect(err.message).toContain("123");
    expect(err.message).toContain("Your organizations");
  });

  test("listTeams 403 triggers org-scoped fallback, surfaces policy error if fallback also blocked", async () => {
    // listTeams returns 403 (member lacks team:read). handleListTeamsError re-throws
    // the raw ApiError so the outer catch can route to the org-scoped fallback.
    // The default beforeEach mock has createProjectWithAutoTeam reject with
    // "disabled this feature", so the final error is the policy-disabled message.
    listTeamsSpy.mockRejectedValue(
      new ApiError("API request failed: 403 Forbidden", 403)
    );

    const { context } = createMockContext();
    const func = await createCommand.loader();

    const err = (await func
      .call(context, { json: false }, "my-app:node")
      .catch((e: Error) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
    expect(err.message).toContain("disabled project creation for members");
  });

  test("auto-corrects dot-separated platform to hyphen-separated", async () => {
    const { context } = createMockContext();
    const func = await createCommand.loader();
    await func.call(context, { json: false }, "my-app:javascript.nextjs");

    // Should send corrected platform to API
    expect(createProjectWithDsnSpy).toHaveBeenCalledWith(
      "acme-corp",
      "engineering",
      {
        name: "my-app",
        platform: "javascript-nextjs",
      }
    );
  });

  test("does not correct platform without dots", async () => {
    const { context } = createMockContext();
    const func = await createCommand.loader();
    await func.call(context, { json: false }, "my-app:javascript-nextjs");

    // Should send platform as-is to API (no correction needed)
    expect(createProjectWithDsnSpy).toHaveBeenCalledWith(
      "acme-corp",
      "engineering",
      {
        name: "my-app",
        platform: "javascript-nextjs",
      }
    );
  });

  test("auto-corrects multiple dots in platform then validates", async () => {
    const { context } = createMockContext();
    const func = await createCommand.loader();

    // python.django.rest → python-django-rest (not a valid platform)
    const err = await func
      .call(context, { json: false }, "my-app:python.django.rest")
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(err.message).toContain("Invalid platform 'python-django-rest'");
  });

  test("creates multiple projects with independent platforms", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await createCommand.loader();
    await func.call(
      context,
      { json: false },
      "web:javascript",
      "api:python-django",
      "worker:node"
    );

    expect(createProjectWithDsnSpy).toHaveBeenCalledTimes(3);
    for (const [name, platform] of [
      ["web", "javascript"],
      ["api", "python-django"],
      ["worker", "node"],
    ] as const) {
      expect(createProjectWithDsnSpy).toHaveBeenCalledWith(
        "acme-corp",
        "engineering",
        { name, platform }
      );
    }
    const output = stdoutWrite.mock.calls.map((call) => call[0]).join("");
    expect(output.match(/Created project/g)).toHaveLength(3);
  });

  test("creates one hundred project pairs in one command", async () => {
    const specs = Array.from(
      { length: 100 },
      (_, index) => `project-${index}:node`
    );
    const { context } = createMockContext();
    const func = await createCommand.loader();

    await func.call(context, { json: false }, ...specs);

    expect(createProjectWithDsnSpy).toHaveBeenCalledTimes(100);
    expect(createProjectWithDsnSpy).toHaveBeenLastCalledWith(
      "acme-corp",
      "engineering",
      { name: "project-99", platform: "node" }
    );
  });

  test("outputs a single JSON array for created projects", async () => {
    createProjectWithDsnSpy
      .mockResolvedValueOnce(createdProjectDetails("web"))
      .mockResolvedValueOnce(createdProjectDetails("api"));
    const { context, stdoutWrite } = createMockContext();
    const func = await createCommand.loader();
    await func.call(context, { json: true }, "web:node", "api:node");

    const output = stdoutWrite.mock.calls.map((call) => call[0]).join("");
    const parsed = JSON.parse(output) as Array<
      Record<string, unknown> & { project: { name: string } }
    >;
    expect(parsed.map((result) => result.project.name)).toEqual(["web", "api"]);
    for (const result of parsed) {
      expect(result).not.toHaveProperty("slugDiverged");
      expect(result).not.toHaveProperty("expectedSlug");
      expect(result).not.toHaveProperty("teamSource");
      expect(result).not.toHaveProperty("requestedPlatform");
    }
  });

  test("shows completed projects when a later creation fails", async () => {
    createProjectWithDsnSpy
      .mockResolvedValueOnce(createdProjectDetails("web"))
      .mockRejectedValueOnce(new ApiError("Server Error", 500));
    const { context, stdoutWrite } = createMockContext();
    const func = await createCommand.loader();
    const error = await func
      .call(context, { json: false }, "web:node", "api:node")
      .catch((caught: Error) => caught);

    expect(error).toBeInstanceOf(ApiError);
    const output = stdoutWrite.mock.calls.map((call) => call[0]).join("");
    expect(output).toContain("Created project 'web'");
    expect(output).not.toContain("Created project 'api'");
  });

  test("keeps partial batch JSON parseable when a later creation fails", async () => {
    createProjectWithDsnSpy
      .mockResolvedValueOnce(createdProjectDetails("web"))
      .mockRejectedValueOnce(new ApiError("Server Error", 500));
    const { context, stdoutWrite } = createMockContext();
    const func = await createCommand.loader();
    const error = await func
      .call(context, { json: true }, "web:node", "api:node")
      .catch((caught: Error) => caught);

    expect(error).toBeInstanceOf(ApiError);
    const output = stdoutWrite.mock.calls.map((call) => call[0]).join("");
    const parsed = JSON.parse(output) as ProjectCreatedResult[];
    expect(parsed.map((result) => result.project.name)).toEqual(["web"]);
  });

  test("invalid platform identifies its project pair", async () => {
    const { context } = createMockContext();
    const func = await createCommand.loader();
    const err = await func
      .call(context, { json: false }, "proj1:node", "proj2:not-a-platform")
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain("Invalid platform 'not-a-platform'");
    expect(err.message).toContain("sentry project create proj2:<platform>");
  });

  test.each([
    ["paired", ["My Cool App:node"]],
  ])("rejects whitespace in a %s project name", async (_syntax, args) => {
    const { context } = createMockContext();
    const func = await createCommand.loader();
    const err = await func
      .call(context, { json: false }, ...args)
      .catch((error: Error) => error);

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain(
      "Project name 'My Cool App' cannot contain whitespace"
    );
    expect(createProjectWithDsnSpy).not.toHaveBeenCalled();
  });

  test("preserves commas inside a project name", async () => {
    const { context } = createMockContext();
    const func = await createCommand.loader();
    await func.call(context, { json: false }, "payments,eu:node");

    expect(createProjectWithDsnSpy).toHaveBeenCalledTimes(1);
    expect(createProjectWithDsnSpy).toHaveBeenCalledWith(
      "acme-corp",
      "engineering",
      { name: "payments,eu", platform: "node" }
    );
  });

  test("splits a project specification on its final colon", async () => {
    const { context } = createMockContext();
    const func = await createCommand.loader();
    await func.call(context, { json: false }, "api:europe:node");

    expect(createProjectWithDsnSpy).toHaveBeenCalledWith(
      "acme-corp",
      "engineering",
      { name: "api:europe", platform: "node" }
    );
  });

  // --dry-run tests

  test("dry-run shows what would be created without API call", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await createCommand.loader();
    await func.call(context, { json: false, "dry-run": true }, "my-app:node");

    // Should NOT call createProject
    expect(createProjectWithDsnSpy).not.toHaveBeenCalled();
    // Should NOT fetch DSN
    expect(tryGetPrimaryDsnSpy).not.toHaveBeenCalled();

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Dry run");
    expect(output).toContain("acme-corp");
    expect(output).toContain("engineering");
    expect(output).toContain("my-app");
    expect(output).toContain("node");
  });

  test("dry-run: multi-project empty org previews one shared team", async () => {
    listTeamsSpy.mockResolvedValue([]);
    const { context, stdoutWrite } = createMockContext();
    const func = await createCommand.loader();
    await func.call(
      context,
      { json: false, "dry-run": true },
      "web:javascript",
      "api:python-django",
      "worker:node"
    );

    // Dry-run never creates teams or projects.
    expect(createTeamSpy).not.toHaveBeenCalled();
    expect(createProjectWithDsnSpy).not.toHaveBeenCalled();

    // Every project previews the SAME team (first project's slug), matching a
    // real run that creates one team and reuses it — not one team per project.
    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Would create team 'web'");
    expect(output).not.toContain("Would create team 'api'");
    expect(output).not.toContain("Would create team 'worker'");
  });

  test("dry-run still validates platform", async () => {
    const { context } = createMockContext();
    const func = await createCommand.loader();

    const err = await func
      .call(
        context,
        { json: false, "dry-run": true },
        "my-app:invalid-platform"
      )
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(err.message).toContain("Invalid platform");
  });

  test("dry-run still resolves org", async () => {
    const { context } = createMockContext();
    const func = await createCommand.loader();
    await func.call(
      context,
      { json: false, "dry-run": true },
      "my-org/my-app:python"
    );

    expect(resolveOrgSpy).toHaveBeenCalledWith({
      org: "my-org",
      cwd: "/tmp",
    });
  });

  test("dry-run outputs JSON when --json is set", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await createCommand.loader();
    await func.call(context, { json: true, "dry-run": true }, "my-app:node");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    // Same ProjectCreatedResult shape as normal path
    expect(parsed.orgSlug).toBe("acme-corp");
    expect(parsed.teamSlug).toBe("engineering");
    expect(parsed.project.name).toBe("my-app");
    expect(parsed.project.slug).toBe("my-app");
    expect(parsed.project.platform).toBe("node");
    expect(parsed.dsn).toBeNull();
    expect(parsed.dryRun).toBe(true);

    // Should NOT call createProject
    expect(createProjectWithDsnSpy).not.toHaveBeenCalled();
  });

  test("dry-run outputs one JSON array for multiple projects", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await createCommand.loader();
    await func.call(
      context,
      { json: true, "dry-run": true },
      "web:node",
      "api:node"
    );

    const output = stdoutWrite.mock.calls.map((call) => call[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(2);
    expect(
      parsed.map((result: ProjectCreatedResult) => result.project.name)
    ).toEqual(["web", "api"]);
  });

  test("dry-run shows team source for auto-selected teams", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await createCommand.loader();
    await func.call(context, { json: false, "dry-run": true }, "my-app:node");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    // Single team = auto-selected → note about team usage
    expect(output).toContain("Would use team");
  });

  test("dry-run with no teams shows auto-created team without creating it", async () => {
    listTeamsSpy.mockResolvedValue([]);

    const { context, stdoutWrite } = createMockContext();
    const func = await createCommand.loader();
    await func.call(context, { json: false, "dry-run": true }, "my-app:node");

    // Should NOT call createTeam
    expect(createTeamSpy).not.toHaveBeenCalled();
    // Should NOT call createProject
    expect(createProjectWithDsnSpy).not.toHaveBeenCalled();

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Dry run");
    expect(output).toContain("my-app");
    expect(output).toContain("Would create team");
  });

  test("falls back to a later project's slug when the first name slugifies to empty", async () => {
    listTeamsSpy.mockResolvedValue([]);

    const { context, stdoutWrite } = createMockContext();
    const func = await createCommand.loader();
    // "!!!" has no characters slugify() keeps, so it alone can't name the
    // auto-created team — the batch should still share "my-app" instead of
    // rejecting every project with "No teams found".
    await func.call(
      context,
      { json: false, "dry-run": true },
      "!!!:node",
      "my-app:python"
    );

    expect(createTeamSpy).not.toHaveBeenCalled();
    expect(createProjectWithDsnSpy).not.toHaveBeenCalled();

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).not.toContain("No teams found");
    expect(output).toContain("Would create team");
    // Both projects share the same auto-create slug, derived from "my-app".
    expect(output.match(/Would create team 'my-app'/g)).toHaveLength(2);
  });
});
