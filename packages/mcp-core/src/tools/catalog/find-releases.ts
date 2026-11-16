import { z } from "zod";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  ParamOrganizationSlug,
  ParamProjectSlugOrAll,
  ParamRegionUrl,
} from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
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
  title: "Find Releases",
  skills: ["inspect"], // Only available in inspect skill
  requiredScopes: ["project:read"],
  description: `List or search releases (deployed versions) in a Sentry organization or project. Returns each release's dates, new issue count, last commit, and last deploy. Returns at most ${RESULT_LIMIT} releases with no next page; narrow by project or version to see others.`,
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    projectSlug: ParamProjectSlugOrAll.nullable().default(null),
    query: z
      .string()
      .trim()
      .describe(
        "Substring of the release version, such as a commit SHA prefix.",
      )
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

    setTargetTagsAndAttributes({ organizationSlug });

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
