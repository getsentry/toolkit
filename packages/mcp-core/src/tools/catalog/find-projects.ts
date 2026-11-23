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
  title: "Find Projects",
  skills: ALL_SKILLS, // Foundational tool - available to all skills
  requiredScopes: ["project:read"],
  description: `List or search projects in a Sentry organization. Returns project slugs, ${RESULT_LIMIT} per page.`,
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    query: ParamSearchQuery.describe(
      "Filter by name or slug, or pass a numeric project ID.",
    )
      .nullable()
      .default(null),
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

    const listProjects = (query: string | undefined) =>
      apiService.listProjects(organizationSlug, {
        query,
        limit: RESULT_LIMIT,
        cursor: params.cursor ?? undefined,
      });

    // Sentry matches free text against name and slug only, so a bare
    // numeric ID finds nothing unless it is sent as `id:`.
    const query = params.query ?? undefined;
    let result: Awaited<ReturnType<typeof listProjects>> | undefined;
    if (query && /^\d+$/.test(query) && !params.cursor) {
      result = await listProjects(`id:${query}`);
    }
    if (!result?.projects.length) {
      result = await listProjects(query);
    }
    const { projects, nextCursor } = result;

    return structuredResult({
      projects: projects.map((project) => ({ slug: project.slug })),
      hasMore: nextCursor !== null,
      nextCursor,
    });
  },
});
