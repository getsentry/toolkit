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
import { ALL_SKILLS } from "../../skills";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";

const RESULT_LIMIT = 25;

export const findProjectsOutputSchema = z.object({
  projects: z.array(
    z.object({
      slug: z.string(),
    }),
  ),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

export default defineTool({
  name: "find_projects",
  skills: ALL_SKILLS, // Foundational tool - available to all skills
  requiredScopes: ["project:read"],
  description: [
    "Find projects in Sentry.",
    "",
    "Use this tool when you need to:",
    "- View projects in a Sentry organization",
    "- Find a project's slug to aid other tool requests",
    "- Search for specific projects by name or slug",
    "",
    `Returns up to ${RESULT_LIMIT} results per page. When hasMore is true, pass the returned nextCursor with the same filters and scope to fetch the next page.`,
  ].join("\n"),
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
  outputSchema: findProjectsOutputSchema,
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

    const { projects, nextCursor } = await apiService.listProjects(
      organizationSlug,
      {
        query: params.query ?? undefined,
        limit: RESULT_LIMIT,
        cursor: params.cursor ?? undefined,
      },
    );

    return structuredResult({
      projects: projects.map((project) => ({ slug: project.slug })),
      hasMore: nextCursor !== null,
      nextCursor,
    });
  },
});
