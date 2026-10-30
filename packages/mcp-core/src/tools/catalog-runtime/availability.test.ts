import { getClient } from "@sentry/core";
import { describe, expect, it, vi } from "vitest";
import type { Skill } from "../../skills";
import { getServerContext } from "../../test-setup";
import type { ServerContext } from "../../types";
import addTeamToProject from "../catalog/add-team-to-project";
import catalogTools from "../catalog";
import createProject from "../catalog/create-project";
import removeTeamFromProject from "../catalog/remove-team-from-project";
import updateProject from "../catalog/update-project";
import {
  getFilteredInputSchema,
  getToolsForMcpRegistration,
  getSearchableTools,
  prepareToolParams,
} from "./availability";

vi.mock("@sentry/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sentry/core")>();
  return { ...actual, getClient: vi.fn(actual.getClient) };
});

function getProjectManagementContext(
  constraints: Partial<ServerContext["constraints"]> = {},
): ServerContext {
  return getServerContext({
    grantedSkills: new Set<Skill>(["project-management"]),
    constraints,
  });
}

function getSearchableToolNames(context: ServerContext): string[] {
  return getSearchableTools({
    tools: catalogTools,
    context,
    experimentalMode: false,
    useDefaultSurfacePolicy: true,
  }).map(({ tool }) => tool.name);
}

describe("catalog availability", () => {
  it("keeps project-management tools skill-gated and catalog-only", () => {
    const inspectContext = getServerContext({
      grantedSkills: new Set<Skill>(["inspect"]),
    });
    const inspectToolNames = getSearchableToolNames(inspectContext);

    expect(inspectToolNames).not.toEqual(
      expect.arrayContaining([
        "create_project",
        "update_project",
        "add_team_to_project",
        "remove_team_from_project",
      ]),
    );

    const projectManagementContext = getProjectManagementContext();
    const directToolNames = getToolsForMcpRegistration({
      tools: catalogTools,
      context: projectManagementContext,
      experimentalMode: false,
      useDefaultSurfacePolicy: true,
    }).map(({ tool }) => tool.name);

    expect(directToolNames).not.toEqual(
      expect.arrayContaining([
        "create_project",
        "update_project",
        "add_team_to_project",
        "remove_team_from_project",
      ]),
    );
    expect(getSearchableToolNames(projectManagementContext)).toEqual(
      expect.arrayContaining([
        "create_project",
        "update_project",
        "add_team_to_project",
        "remove_team_from_project",
      ]),
    );
  });

  it("shows submit_feedback_to_sentry_team only when Sentry telemetry has a DSN", () => {
    const context = getServerContext({
      grantedSkills: new Set<Skill>(["inspect"]),
    });

    vi.mocked(getClient).mockReturnValueOnce(undefined);
    expect(getSearchableToolNames(context)).not.toContain(
      "submit_feedback_to_sentry_team",
    );

    vi.mocked(getClient).mockReturnValueOnce({
      getDsn: () => ({ host: "o1.ingest.sentry.io" }),
    } as unknown as ReturnType<typeof getClient>);
    expect(getSearchableToolNames(context)).toContain(
      "submit_feedback_to_sentry_team",
    );
  });

  it("hides create_project from project-scoped project-management sessions", () => {
    const context = getProjectManagementContext({
      organizationSlug: "my-org",
      projectSlug: "my-project",
    });

    expect(getSearchableToolNames(context)).toEqual(
      expect.arrayContaining([
        "update_project",
        "add_team_to_project",
        "remove_team_from_project",
      ]),
    );
    expect(getSearchableToolNames(context)).not.toContain("create_project");
  });

  it("injects organization constraints for project creation", () => {
    const context = getProjectManagementContext({
      organizationSlug: "my-org",
    });

    expect(getFilteredInputSchema(createProject, context)).not.toHaveProperty(
      "organizationSlug",
    );
    expect(
      prepareToolParams({
        tool: createProject,
        params: {
          organizationSlug: "other-org",
          teamSlug: "my-team",
          name: "My Project",
          slug: null,
          platform: null,
          regionUrl: null,
        },
        context,
      }),
    ).toMatchObject({
      organizationSlug: "my-org",
      teamSlug: "my-team",
    });
  });

  it("injects project constraints for project update and team access tools", () => {
    const context = getProjectManagementContext({
      organizationSlug: "my-org",
      projectSlug: "my-project",
    });

    for (const tool of [
      updateProject,
      addTeamToProject,
      removeTeamFromProject,
    ]) {
      expect(getFilteredInputSchema(tool, context)).not.toHaveProperty(
        "organizationSlug",
      );
      expect(getFilteredInputSchema(tool, context)).not.toHaveProperty(
        "projectSlug",
      );
    }

    expect(
      prepareToolParams({
        tool: updateProject,
        params: {
          organizationSlug: "other-org",
          projectSlug: "other-project",
          name: "Updated Project",
          slug: null,
          platform: null,
          regionUrl: null,
        },
        context,
      }),
    ).toMatchObject({
      organizationSlug: "my-org",
      projectSlug: "my-project",
      name: "Updated Project",
    });

    for (const tool of [addTeamToProject, removeTeamFromProject]) {
      expect(
        prepareToolParams({
          tool,
          params: {
            organizationSlug: "other-org",
            projectSlug: "other-project",
            teamSlug: "my-team",
            regionUrl: null,
          },
          context,
        }),
      ).toMatchObject({
        organizationSlug: "my-org",
        projectSlug: "my-project",
        teamSlug: "my-team",
      });
    }
  });
});
