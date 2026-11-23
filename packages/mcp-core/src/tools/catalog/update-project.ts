import { z } from "zod";
import { ApiClientError } from "../../api-client";
import type { Project } from "../../api-client/index";
import { UserInputError } from "../../errors";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  ParamOrganizationSlug,
  ParamPlatform,
  ParamProjectSlug,
  ParamRegionUrl,
} from "../../schema";
import { logIssue } from "../../telem/logging";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";

export const updateProjectOutputSchema = z.object({
  project: z.object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    platform: z.string().nullable(),
  }),
});

export default defineTool({
  name: "update_project",
  title: "Update Project",
  skills: ["project-management"], // Only available in project-management skill
  requiredScopes: ["project:write"],
  description:
    "Rename a Sentry project, change its slug, or change its platform. Returns the updated project. To change which teams can access a project, use add_team_to_project or remove_team_from_project.",
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    projectSlug: ParamProjectSlug,
    name: z
      .string()
      .trim()
      .describe("New display name.")
      .nullable()
      .default(null),
    slug: ParamProjectSlug.describe(
      "New slug, unique in the organization. The project moves to the new slug.",
    )
      .nullable()
      .default(null),
    platform: ParamPlatform.nullable().default(null),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  outputSchema: updateProjectOutputSchema,
  async handler(params, context: ServerContext) {
    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    const organizationSlug = params.organizationSlug;

    setTargetTagsAndAttributes(params);

    const hasProjectUpdates = params.name || params.slug || params.platform;
    if (!hasProjectUpdates) {
      throw new UserInputError(
        "At least one project metadata field is required: `name`, `slug`, or `platform`.",
      );
    }

    if (params.slug && context.constraints.projectSlug) {
      throw new UserInputError(
        "Project slug changes require an organization-scoped or unconstrained session. Reconnect without a project constraint before renaming the project slug.",
      );
    }

    let project: Project;
    try {
      project = await apiService.updateProject({
        organizationSlug,
        projectSlug: params.projectSlug,
        name: params.name,
        slug: params.slug,
        platform: params.platform,
      });
    } catch (err) {
      if (err instanceof ApiClientError) {
        throw err;
      }
      logIssue(err);
      throw new Error(
        `Failed to update project ${params.projectSlug}: ${err instanceof Error ? err.message : "Unknown error"}`,
        { cause: err },
      );
    }

    return structuredResult({
      project: {
        id: String(project.id),
        slug: project.slug,
        name: project.name,
        platform: project.platform ?? null,
      },
    });
  },
});
