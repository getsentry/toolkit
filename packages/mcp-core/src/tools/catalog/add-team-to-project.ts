import { z } from "zod";
import type { Team } from "../../api-client/index";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  ParamOrganizationSlug,
  ParamProjectSlug,
  ParamRegionUrl,
  ParamTeamSlug,
} from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";

const assignedTeamSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
});

export const addTeamToProjectOutputSchema = z.object({
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
  name: "add_team_to_project",
  title: "Add Team to Project",
  skills: ["project-management"],
  requiredScopes: ["project:write", "team:read", "org:read"],
  description:
    "Grant a team access to a Sentry project. Returns the project's teams; makes no change if the team already has access.",
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    projectSlug: ParamProjectSlug,
    teamSlug: ParamTeamSlug,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  outputSchema: addTeamToProjectOutputSchema,
  async handler(params, context: ServerContext) {
    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    const organizationSlug = params.organizationSlug;

    setTargetTagsAndAttributes(params);

    const currentTeams = await apiService.listProjectTeams({
      organizationSlug,
      projectSlug: params.projectSlug,
    });
    const alreadyAssigned = currentTeams.some(
      (team) => team.slug === params.teamSlug,
    );

    if (alreadyAssigned) {
      return structuredResult({
        changed: false,
        teams: currentTeams.map(mapTeam),
      });
    }

    await apiService.addTeamToProject({
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
