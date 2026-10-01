import { z } from "zod";
import type { Commit, Deploy, ReleaseDetails } from "../../api-client/types";
import { UserInputError } from "../../errors";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { ParamOrganizationSlug, ParamRegionUrl } from "../../schema";
import { setTagAndAttribute } from "../../telem/scope";
import type { ServerContext } from "../../types";
import { isNumericId, validateSlugOrId } from "../../utils/slug-validation";
import {
  compactLines,
  formatActor,
  formatDate,
  formatId,
  formatUnknown,
} from "./support/api-formatting";
import { assertProjectListContainsConstraint } from "./support/project-constraints";

function formatProjects(release: ReleaseDetails): string | null {
  if (!release.projects || release.projects.length === 0) {
    return null;
  }

  return release.projects
    .map((project) => project.slug ?? project.name)
    .join(", ");
}

function formatDeploy(deploy: Deploy): string {
  const lines = compactLines([
    `### Deploy ${formatId(deploy.id)}`,
    "",
    deploy.environment ? `**Environment**: ${deploy.environment}` : null,
    deploy.name ? `**Name**: ${deploy.name}` : null,
    formatDate(deploy.dateStarted)
      ? `**Started**: ${formatDate(deploy.dateStarted)}`
      : null,
    formatDate(deploy.dateFinished)
      ? `**Finished**: ${formatDate(deploy.dateFinished)}`
      : null,
    deploy.url ? `**URL**: ${deploy.url}` : null,
  ]);

  return lines.join("\n");
}

function formatCommit(commit: Commit): string {
  const author = commit.author ? formatActor(commit.author) : null;
  const message = commit.message?.split("\n")[0] ?? "No commit message";
  const repository = commit.repository?.name;
  return compactLines([
    `- \`${formatId(commit.id)}\`: ${message}`,
    author ? `  - Author: ${author}` : null,
    repository ? `  - Repository: ${repository}` : null,
    formatDate(commit.dateCreated)
      ? `  - Created: ${formatDate(commit.dateCreated)}`
      : null,
  ]).join("\n");
}

function formatHealthOrMeta(release: ReleaseDetails): string[] {
  const lines: string[] = [];
  if (release.currentProjectMeta) {
    for (const [key, value] of Object.entries(release.currentProjectMeta)) {
      lines.push(`- **${key}**: ${formatUnknown(value)}`);
    }
  }

  if (release.adoptionStages !== undefined) {
    lines.push(
      `- **adoptionStages**: ${formatUnknown(release.adoptionStages)}`,
    );
  }

  return lines;
}

export default defineTool({
  name: "get_release_details",
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
    setTagAndAttribute("organization.slug", organizationSlug);
    setTagAndAttribute("release.version", params.releaseVersion);
    const scopedProjectSlug = context.constraints.projectSlug ?? undefined;
    const requestedProjectSlugOrId = params.projectSlugOrId ?? undefined;
    const projectSlugOrId = scopedProjectSlug ?? requestedProjectSlugOrId;

    if (projectSlugOrId) {
      if (isNumericId(projectSlugOrId)) {
        setTagAndAttribute("project.id", projectSlugOrId);
      } else {
        setTagAndAttribute("project.slug", projectSlugOrId);
      }
    }

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

    const releaseUrl = apiService.getReleaseUrl(
      organizationSlug,
      release.version,
    );
    const projects = formatProjects(release);
    const author = release.lastCommit?.author
      ? formatActor(release.lastCommit.author)
      : null;

    const output = compactLines([
      `# Release ${release.version} in **${organizationSlug}**`,
      "",
      `**ID**: ${formatId(release.id)}`,
      release.shortVersion
        ? `**Short Version**: ${release.shortVersion}`
        : null,
      formatDate(release.dateCreated)
        ? `**Created**: ${formatDate(release.dateCreated)}`
        : null,
      formatDate(release.dateReleased)
        ? `**Released**: ${formatDate(release.dateReleased)}`
        : null,
      formatDate(release.firstEvent)
        ? `**First Event**: ${formatDate(release.firstEvent)}`
        : null,
      formatDate(release.lastEvent)
        ? `**Last Event**: ${formatDate(release.lastEvent)}`
        : null,
      release.newGroups !== undefined
        ? `**New Issues**: ${release.newGroups}`
        : null,
      projects ? `**Projects**: ${projects}` : null,
      `**URL**: [Open Release](${releaseUrl})`,
    ]);

    if (release.lastCommit) {
      output.push("", "## Last Commit", "");
      output.push(
        compactLines([
          `**Commit ID**: ${formatId(release.lastCommit.id)}`,
          release.lastCommit.message
            ? `**Message**: ${release.lastCommit.message}`
            : null,
          author ? `**Author**: ${author}` : null,
          formatDate(release.lastCommit.dateCreated)
            ? `**Created**: ${formatDate(release.lastCommit.dateCreated)}`
            : null,
        ]).join("\n"),
      );
    }

    const healthLines = params.includeHealth ? formatHealthOrMeta(release) : [];
    if (healthLines.length > 0) {
      output.push("", "## Health And Project Metadata", "", ...healthLines);
    }

    if (params.includeDeploys) {
      output.push("", "## Deploys", "");
      output.push(
        deploys.length === 0
          ? "No deploys found."
          : deploys.slice(0, params.limit).map(formatDeploy).join("\n\n"),
      );
    }

    if (params.includeCommits) {
      output.push("", "## Commits", "");
      output.push(
        commits.length === 0
          ? "No commits found."
          : commits.slice(0, params.limit).map(formatCommit).join("\n"),
      );
    }

    output.push("", "## Response Notes", "");
    output.push(
      `- Search issues introduced in this release with query \`release:${release.version}\`.`,
    );

    return `${output.join("\n")}\n`;
  },
});
