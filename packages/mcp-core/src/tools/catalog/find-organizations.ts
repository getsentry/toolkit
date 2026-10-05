import { z } from "zod";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import { ParamCursor, ParamSearchQuery } from "../../schema";
import { ALL_SKILLS } from "../../skills";
import type { ServerContext } from "../../types";

const RESULT_LIMIT = 25;

export const findOrganizationsOutputSchema = z.object({
  organizations: z.array(
    z.object({
      slug: z.string(),
      webUrl: z.string().url().nullable(),
      regionUrl: z.string().url().nullable(),
    }),
  ),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

function normalizeUrl(url: string | undefined): string | null {
  return url?.trim() ? url : null;
}

export default defineTool({
  name: "find_organizations",
  skills: ALL_SKILLS, // Foundational tool - available to all skills
  requiredScopes: ["org:read"],
  description: [
    "Find organizations that the user has access to in Sentry.",
    "",
    "Use this tool when you need to:",
    "- View organizations in Sentry",
    "- Find an organization's slug to aid other tool requests",
    "- Search for specific organizations by name or slug",
    "",
    `Returns up to ${RESULT_LIMIT} results per page. When hasMore is true, pass the returned nextCursor with the same filters and scope to fetch the next page.`,
  ].join("\n"),
  inputSchema: {
    query: ParamSearchQuery.nullable().default(null),
    cursor: ParamCursor.nullable().default(null),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  outputSchema: findOrganizationsOutputSchema,
  async handler(params, context: ServerContext) {
    // Organizations are listed from the root host, which returns orgs across
    // all regions, so no regionUrl is passed here.
    const apiService = apiServiceFromContext(context);
    const { organizations, nextCursor } = await apiService.listOrganizations({
      query: params.query ?? undefined,
      limit: RESULT_LIMIT,
      cursor: params.cursor ?? undefined,
    });

    return structuredResult({
      organizations: organizations.map((organization) => ({
        slug: organization.slug,
        webUrl: normalizeUrl(organization.links?.organizationUrl),
        regionUrl: normalizeUrl(organization.links?.regionUrl),
      })),
      hasMore: nextCursor !== null,
      nextCursor,
    });
  },
});
