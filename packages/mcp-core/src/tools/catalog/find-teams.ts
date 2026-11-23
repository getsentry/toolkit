import { z } from "zod";
import { UserInputError } from "../../errors";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  ParamCursor,
  ParamOrganizationSlug,
  ParamRegionUrl,
  ParamSearchQuery,
} from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";

const RESULT_LIMIT = 25;

export const findTeamsOutputSchema = z.object({
  teams: z.array(
    z.object({
      slug: z.string(),
      id: z.string(),
    }),
  ),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

export default defineTool({
  name: "find_teams",
  title: "Find Teams",
  skills: ["inspect", "triage", "project-management"], // Team viewing and management
  requiredScopes: ["team:read"],
  description: `List or search teams in a Sentry organization. Returns each team's slug and numeric ID, ${RESULT_LIMIT} per page.`,
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    query: ParamSearchQuery.nullable().default(null),
    cursor: ParamCursor.nullable().default(null),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  outputSchema: findTeamsOutputSchema,
  async handler(params, context: ServerContext) {
    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    const organizationSlug = params.organizationSlug;

    if (!organizationSlug) {
      throw new UserInputError(
        "Organization slug is required. Please provide an organizationSlug parameter.",
      );
    }

    setTargetTagsAndAttributes({ organizationSlug });

    const { teams, nextCursor } = await apiService.listTeams(organizationSlug, {
      query: params.query ?? undefined,
      limit: RESULT_LIMIT,
      cursor: params.cursor ?? undefined,
    });

    return structuredResult({
      teams: teams.map((team) => ({ slug: team.slug, id: String(team.id) })),
      hasMore: nextCursor !== null,
      nextCursor,
    });
  },
});
