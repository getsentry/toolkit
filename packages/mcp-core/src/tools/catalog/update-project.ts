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
import { setTagAndAttribute } from "../../telem/scope";
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
  skills: ["project-management"], // Only available in project-management skill
  requiredScopes: ["project:write"],
  description: [
    "Update project metadata in Sentry, such as name, slug, and platform.",
    "",
    "Be careful when using this tool!",
    "",
    "Use this tool when you need to:",
    "- Update a project's name or slug to fix onboarding mistakes",
    "- Change the platform assigned to a project",
    "",
    "<examples>",
    "### Update a project's name and slug",
    "",
    "```",
    "update_project(organizationSlug='my-organization', projectSlug='old-project', name='New Project Name', slug='new-project-slug')",
    "```",
    "",
    "### Update platform",
    "",
    "```",
    "update_project(organizationSlug='my-organization', projectSlug='my-project', platform='python')",
    "```",
    "",
    "</examples>",
    "",
    "<hints>",
    "- If the user passes a parameter in the form of name/otherName, it's likely in the format of <organizationSlug>/<projectSlug>.",
    "- Team access changes are handled by separate project-management tools.",
    "- If any parameter is ambiguous, you should clarify with the user what they meant.",
    "- When updating the slug, the project will be accessible at the new slug after the update",
    "- Do not update the slug from a project-scoped session; reconnect with an organization-scoped or unconstrained session first.",
    "</hints>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    projectSlug: ParamProjectSlug,
    name: z
      .string()
      .trim()
      .describe("The new name for the project")
      .nullable()
      .default(null),
    slug: ParamProjectSlug.describe(
      "The new slug for the project (must be unique)",
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

    setTagAndAttribute("organization.slug", organizationSlug);
    setTagAndAttribute("project.slug", params.projectSlug);

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
