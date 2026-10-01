import { z } from "zod";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  ParamOrganizationSlug,
  ParamProjectSlugOrAll,
  ParamRegionUrl,
} from "../../schema";
import { setTagAndAttribute } from "../../telem/scope";
import type { ServerContext } from "../../types";

const RESULT_LIMIT = 25;

export const findReleasesOutputSchema = z.object({
  releases: z.array(
    z.object({
      version: z.string(),
      dateCreated: z.string().datetime(),
      dateReleased: z.string().datetime().nullable(),
      firstEvent: z.string().datetime().nullable(),
      lastEvent: z.string().datetime().nullable(),
      newIssues: z.number(),
      projects: z.array(z.string()),
      lastCommit: z
        .object({
          id: z.string(),
          message: z.string().nullable(),
          author: z.string().nullable(),
          dateCreated: z.string().datetime(),
        })
        .nullable(),
      lastDeploy: z
        .object({
          id: z.string(),
          environment: z.string().nullable(),
          dateStarted: z.string().datetime().nullable(),
          dateFinished: z.string().datetime().nullable(),
        })
        .nullable(),
    }),
  ),
  hasMore: z.boolean(),
});

export default defineTool({
  name: "find_releases",
  skills: ["inspect"], // Only available in inspect skill
  requiredScopes: ["project:read"],
  description: [
    "Find releases in Sentry.",
    "",
    "Use this tool when you need to:",
    "- Find recent releases in a Sentry organization",
    "- Find the most recent version released of a specific project",
    "- Determine when a release was deployed to an environment",
    "",
    `Returns up to ${RESULT_LIMIT} results. When hasMore is true, use the projectSlug or query parameter to narrow down results.`,
    "",
    "<examples>",
    "### Find the most recent releases in the 'my-organization' organization",
    "",
    "```",
    "find_releases(organizationSlug='my-organization')",
    "```",
    "",
    "### Find releases matching '2ce6a27' in the 'my-organization' organization",
    "",
    "```",
    "find_releases(organizationSlug='my-organization', query='2ce6a27')",
    "```",
    "</examples>",
    "",
    "<hints>",
    "- If the user passes a parameter in the form of name/otherName, its likely in the format of <organizationSlug>/<projectSlug>.",
    "</hints>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    projectSlug: ParamProjectSlugOrAll.nullable().default(null),
    query: z
      .string()
      .trim()
      .describe("Search for versions which contain the provided string.")
      .nullable()
      .default(null),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  outputSchema: findReleasesOutputSchema,
  async handler(params, context: ServerContext) {
    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    const organizationSlug = params.organizationSlug;

    setTagAndAttribute("organization.slug", organizationSlug);

    const releases = await apiService.listReleases({
      organizationSlug,
      projectSlug: params.projectSlug ?? undefined,
      query: params.query ?? undefined,
      limit: RESULT_LIMIT + 1,
    });

    return structuredResult({
      releases: releases.slice(0, RESULT_LIMIT).map((release) => ({
        version: release.shortVersion,
        dateCreated: new Date(release.dateCreated).toISOString(),
        dateReleased: release.dateReleased
          ? new Date(release.dateReleased).toISOString()
          : null,
        firstEvent: release.firstEvent
          ? new Date(release.firstEvent).toISOString()
          : null,
        lastEvent: release.lastEvent
          ? new Date(release.lastEvent).toISOString()
          : null,
        newIssues: release.newGroups,
        projects: release.projects
          .map((project) => project.slug)
          .filter((slug): slug is string => slug !== null),
        lastCommit: release.lastCommit
          ? {
              id: String(release.lastCommit.id),
              message: release.lastCommit.message,
              author:
                release.lastCommit.author?.name ??
                release.lastCommit.author?.email ??
                null,
              dateCreated: new Date(
                release.lastCommit.dateCreated,
              ).toISOString(),
            }
          : null,
        lastDeploy: release.lastDeploy
          ? {
              id: String(release.lastDeploy.id),
              environment: release.lastDeploy.environment,
              dateStarted: release.lastDeploy.dateStarted
                ? new Date(release.lastDeploy.dateStarted).toISOString()
                : null,
              dateFinished: release.lastDeploy.dateFinished
                ? new Date(release.lastDeploy.dateFinished).toISOString()
                : null,
            }
          : null,
      })),
      hasMore: releases.length > RESULT_LIMIT,
    });
  },
});
