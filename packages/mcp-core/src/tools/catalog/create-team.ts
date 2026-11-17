import { z } from "zod";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import { ParamOrganizationSlug, ParamRegionUrl } from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";

export const createTeamOutputSchema = z.object({
  team: z.object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
  }),
});

export default defineTool({
  name: "create_team",
  title: "Create Team",
  skills: ["project-management"], // Only available in project-management skill
  requiredScopes: ["team:write"],
  description:
    "Create a new team in a Sentry organization. Returns the team's ID, slug, and name.",
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    name: z.string().trim().describe("The name of the team to create."),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
  outputSchema: createTeamOutputSchema,
  async handler(params, context: ServerContext) {
    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    const organizationSlug = params.organizationSlug;

    setTargetTagsAndAttributes({ organizationSlug });

    const team = await apiService.createTeam({
      organizationSlug,
      name: params.name,
    });
    return structuredResult({
      team: {
        id: String(team.id),
        slug: team.slug,
        name: team.name,
      },
    });
  },
});
