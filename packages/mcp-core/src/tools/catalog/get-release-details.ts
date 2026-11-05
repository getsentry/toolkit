import { z } from "zod";
import type { Commit, Deploy, ReleaseDetails } from "../../api-client/types";
import { UserInputError } from "../../errors";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { ParamOrganizationSlug, ParamRegionUrl } from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import { validateSlugOrId } from "../../utils/slug-validation";
import { isPlainObject } from "../../internal/type-guards";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  formatActor,
  formatDate,
  formatId,
  readString,
} from "./support/api-formatting";
import { assertProjectListContainsConstraint } from "./support/project-constraints";

const nullableString = z.string().nullable();

export const getReleaseDetailsOutputSchema = z.object({
  release: z.object({
    id: z.string(),
    version: z.string(),
    shortVersion: nullableString,
    dateCreated: nullableString,
    dateReleased: nullableString,
    firstEvent: nullableString,
    lastEvent: nullableString,
    newIssues: z.number().nullable(),
    projects: z.array(z.string()),
    url: z.string(),
    lastCommit: z
      .object({
        id: z.string(),
        message: nullableString,
        author: nullableString,
        dateCreated: nullableString,
      })
      .nullable(),
  }),
  health: z
    .object({
      sessionsLowerBound: nullableString,
      sessionsUpperBound: nullableString,
      firstReleaseVersion: nullableString,
      lastReleaseVersion: nullableString,
      prevReleaseVersion: nullableString,
      nextReleaseVersion: nullableString,
      adoptionStages: z.array(
        z.object({
          project: z.string(),
          stage: nullableString,
          adopted: nullableString,
          unadopted: nullableString,
        }),
      ),
    })
    .nullable()
    .describe("Release health metadata. Null unless includeHealth is true."),
  deploys: z
    .array(
      z.object({
        id: z.string(),
        environment: nullableString,
        name: nullableString,
        dateStarted: nullableString,
        dateFinished: nullableString,
        url: nullableString,
      }),
    )
    .nullable()
    .describe("Recent deploys. Null when includeDeploys is false."),
  commits: z
    .array(
      z.object({
        id: z.string(),
        message: nullableString,
        author: nullableString,
        repository: nullableString,
        dateCreated: nullableString,
      }),
    )
    .nullable()
    .describe("Recent commits. Null when includeCommits is false."),
});

type ReleaseHealth = NonNullable<
  z.infer<typeof getReleaseDetailsOutputSchema>["health"]
>;

function toProjects(release: ReleaseDetails): string[] {
  return (release.projects ?? []).map(
    (project) => project.slug ?? project.name,
  );
}

function toDeploy(deploy: Deploy) {
  return {
    id: formatId(deploy.id),
    environment: deploy.environment || null,
    name: deploy.name || null,
    dateStarted: formatDate(deploy.dateStarted),
    dateFinished: formatDate(deploy.dateFinished),
    url: deploy.url || null,
  };
}

function toCommit(commit: Commit) {
  return {
    id: formatId(commit.id),
    message: commit.message?.split("\n")[0] || null,
    author: commit.author ? formatActor(commit.author) : null,
    repository: commit.repository?.name || null,
    dateCreated: formatDate(commit.dateCreated),
  };
}

function toHealth(release: ReleaseDetails): ReleaseHealth {
  const meta = release.currentProjectMeta;
  const adoptionStages = isPlainObject(release.adoptionStages)
    ? Object.entries(release.adoptionStages).map(([project, value]) => {
        const stage = isPlainObject(value) ? value : undefined;
        return {
          project,
          stage: readString(stage, "stage"),
          adopted: formatDate(readString(stage, "adopted")),
          unadopted: formatDate(readString(stage, "unadopted")),
        };
      })
    : [];

  return {
    sessionsLowerBound: formatDate(readString(meta, "sessionsLowerBound")),
    sessionsUpperBound: formatDate(readString(meta, "sessionsUpperBound")),
    firstReleaseVersion: readString(meta, "firstReleaseVersion"),
    lastReleaseVersion: readString(meta, "lastReleaseVersion"),
    prevReleaseVersion: readString(meta, "prevReleaseVersion"),
    nextReleaseVersion: readString(meta, "nextReleaseVersion"),
    adoptionStages,
  };
}

export default defineTool({
  name: "get_release_details",
  title: "Get Release Details",
  skills: ["inspect"],
  requiredScopes: ["project:read"],
  description: [
    "Get details for a Sentry release.",
    "",
    "Use this tool when you need to:",
    "- Inspect an exact release version",
    "- Scope a release lookup to a specific project",
    "- See deploys and environments for a release",
    "- See recent commits attached to a release",
    "- Gather release health metadata when a project is known",
    "",
    "To find issues introduced in a release, call search_issues with query `release:<version>`.",
    "",
    "<examples>",
    "get_release_details(organizationSlug='my-organization', releaseVersion='1.2.3')",
    "get_release_details(organizationSlug='my-organization', releaseVersion='1.2.3', projectSlugOrId='backend')",
    "get_release_details(organizationSlug='my-organization', releaseVersion='1.2.3', includeHealth=true, projectSlugOrId='backend')",
    "</examples>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    releaseVersion: z.string().trim().min(1).describe("Exact release version."),
    projectSlugOrId: z
      .string()
      .trim()
      .superRefine(validateSlugOrId)
      .describe(
        "Optional project slug or numeric ID. Use this to scope release details, deploys, and commits to one project; required for health metadata unless the session is already project-constrained.",
      )
      .nullable()
      .default(null),
    includeHealth: z
      .boolean()
      .describe(
        "Include project-specific release health metadata. Requires projectSlugOrId unless the session is already project-constrained.",
      )
      .default(false),
    includeDeploys: z
      .boolean()
      .describe("Include recent deploys for this release.")
      .default(true),
    includeCommits: z
      .boolean()
      .describe("Include recent commits attached to this release.")
      .default(true),
    limit: z
      .number()
      .int()
      .positive()
      .max(50)
      .describe("Maximum number of deploys and commits to return, up to 50.")
      .default(10),
  },
  outputSchema: getReleaseDetailsOutputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(params, context: ServerContext) {
    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    const organizationSlug = params.organizationSlug;
    const scopedProjectSlug = context.constraints.projectSlug ?? undefined;
    const requestedProjectSlugOrId = params.projectSlugOrId ?? undefined;
    const projectSlugOrId = scopedProjectSlug ?? requestedProjectSlugOrId;
    setTargetTagsAndAttributes({
      organizationSlug,
      projectSlugOrId,
      releaseVersion: params.releaseVersion,
    });

    if (
      scopedProjectSlug &&
      requestedProjectSlugOrId &&
      requestedProjectSlugOrId !== scopedProjectSlug
    ) {
      const scopedProject = await apiService.getProject({
        organizationSlug,
        projectSlugOrId: scopedProjectSlug,
      });
      const scopedProjectId = String(scopedProject.id);
      if (requestedProjectSlugOrId !== scopedProjectId) {
        throw new UserInputError(
          `Release project is outside the active project constraint. Expected project "${scopedProjectSlug}".`,
        );
      }
    }

    if (params.includeHealth && !projectSlugOrId) {
      throw new UserInputError(
        "Release health metadata requires a project. Provide `projectSlugOrId` or use a project-constrained session.",
      );
    }

    const release = await apiService.getReleaseDetails({
      organizationSlug,
      releaseVersion: params.releaseVersion,
      projectSlugOrId,
      includeHealth: params.includeHealth,
    });
    if (release.projects && release.projects.length > 0) {
      assertProjectListContainsConstraint({
        resourceLabel: "Release",
        scopedProjectSlug,
        projects: release.projects,
      });
    }

    const [deploys, commits] = await Promise.all([
      params.includeDeploys
        ? apiService.listReleaseDeploys({
            organizationSlug,
            releaseVersion: params.releaseVersion,
            projectSlugOrId,
            limit: params.limit,
          })
        : Promise.resolve([]),
      params.includeCommits
        ? apiService.listReleaseCommits({
            organizationSlug,
            releaseVersion: params.releaseVersion,
            projectSlugOrId,
            limit: params.limit,
          })
        : Promise.resolve([]),
    ]);

    const lastCommit = release.lastCommit;

    return structuredResult({
      release: {
        id: formatId(release.id),
        version: release.version,
        shortVersion: release.shortVersion || null,
        dateCreated: formatDate(release.dateCreated),
        dateReleased: formatDate(release.dateReleased),
        firstEvent: formatDate(release.firstEvent),
        lastEvent: formatDate(release.lastEvent),
        newIssues: release.newGroups ?? null,
        projects: toProjects(release),
        url: apiService.getReleaseUrl(organizationSlug, release.version),
        lastCommit: lastCommit
          ? {
              id: formatId(lastCommit.id),
              message: lastCommit.message || null,
              author: lastCommit.author ? formatActor(lastCommit.author) : null,
              dateCreated: formatDate(lastCommit.dateCreated),
            }
          : null,
      },
      health: params.includeHealth ? toHealth(release) : null,
      deploys: params.includeDeploys
        ? deploys.slice(0, params.limit).map(toDeploy)
        : null,
      commits: params.includeCommits
        ? commits.slice(0, params.limit).map(toCommit)
        : null,
    });
  },
});
