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
import { setTagAndAttribute } from "../../telem/scope";
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
  skills: ["project-management"],
  requiredScopes: ["project:write", "team:read", "org:read"],
  description: [
    "Grant a team access to an existing Sentry project.",
    "",
    "Use this tool when you need to:",
    "- Add another team to a project",
    "- Grant a team access without changing project metadata",
    "- Check whether a team already has project access before adding it",
    "",
    "<examples>",
    "add_team_to_project(organizationSlug='my-organization', projectSlug='my-project', teamSlug='my-team')",
    "</examples>",
    "",
    "<hints>",
    "- Team access changes are separate from project metadata updates.",
    "- If the team is already assigned, this tool returns the current team list without making another change.",
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

    setTagAndAttribute("organization.slug", organizationSlug);
    setTagAndAttribute("project.slug", params.projectSlug);
    setTagAndAttribute("team.slug", params.teamSlug);

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
