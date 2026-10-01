import { z } from "zod";
import type { Team } from "../../api-client/index";
import { UserInputError } from "../../errors";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  ParamOrganizationSlug,
  ParamProjectSlug,
  ParamRegionUrl,
  ParamTeamSlug,
} from "../../schema";
import { setTagAndAttribute } from "../../telem/scope";
import type { ServerContext } from "../../types";

const assignedTeamSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
});

export const removeTeamFromProjectOutputSchema = z.object({
  changed: z.boolean(),
  teams: z.array(assignedTeamSchema),
});

function mapTeam(team: Team) {
  return {
    id: String(team.id),
    slug: team.slug,
    name: team.name,
  };
}

export default defineTool({
  name: "remove_team_from_project",
  skills: ["project-management"],
  requiredScopes: ["project:write", "team:read", "org:read"],
  description: [
    "Revoke a team's access to an existing Sentry project.",
    "",
    "Use this tool when you need to:",
    "- Remove a team from a project",
    "- Revoke team access without changing project metadata",
    "- Check project team assignments before removing access",
    "",
    "Be careful when using this tool because it revokes project access.",
    "",
    "<examples>",
    "remove_team_from_project(organizationSlug='my-organization', projectSlug='my-project', teamSlug='my-team')",
    "</examples>",
    "",
    "<hints>",
    "- The team must already be assigned to the project.",
    "- This tool will not remove the last team assigned to a project.",
    "</hints>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    projectSlug: ParamProjectSlug,
    teamSlug: ParamTeamSlug,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
  },
  outputSchema: removeTeamFromProjectOutputSchema,
  async handler(params, context: ServerContext) {
    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    const organizationSlug = params.organizationSlug;

    setTagAndAttribute("organization.slug", organizationSlug);
    setTagAndAttribute("project.slug", params.projectSlug);
    setTagAndAttribute("team.slug", params.teamSlug);

    const currentTeams = await apiService.listProjectTeams({
      organizationSlug,
      projectSlug: params.projectSlug,
    });
    const isAssigned = currentTeams.some(
      (team) => team.slug === params.teamSlug,
    );

    if (!isAssigned) {
      throw new UserInputError(
        "The specified team is not assigned to this project. Choose one of the current project teams before removing access.",
      );
    }

    if (currentTeams.length <= 1) {
      throw new UserInputError(
        "Cannot remove the last team assigned to a project. Add another team to the project before removing this team.",
      );
    }

    await apiService.removeTeamFromProject({
      organizationSlug,
      projectSlug: params.projectSlug,
      teamSlug: params.teamSlug,
    });

    const updatedTeams = await apiService.listProjectTeams({
      organizationSlug,
      projectSlug: params.projectSlug,
    });

    return structuredResult({
      changed: true,
      teams: updatedTeams.map(mapTeam),
    });
  },
});
