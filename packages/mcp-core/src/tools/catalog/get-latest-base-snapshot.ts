import { z } from "zod";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { ParamOrganizationSlug, ParamRegionUrl } from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import { isNumericId } from "../../utils/slug-validation";
import { renderSnapshotImageTreeSection } from "../support/snapshots/formatting";

export default defineTool({
  name: "get_latest_base_snapshot",
  skills: ["inspect"],
  requiredScopes: ["project:read"],
  description: [
    "Get the latest UI screenshots/images for an app from the preprod snapshot system.",
    "",
    "This is the primary tool for retrieving app screenshots.",
    "",
    "Use this tool when you need to:",
    "- Get screenshots, screens, golden images, or reference images for an app",
    "- Find what the current UI looks like (latest screenshots from the main/default branch)",
    "- List available snapshots or browse images before requesting specific ones",
    "- Look up dark mode, light mode, or other variant screenshots",
    "- Understand what baseline images exist when investigating snapshot test or visual regression CI failures",
    "",
    "The appId parameter is the app identifier (e.g. 'sentry-frontend', 'com.emergetools.hackernews').",
    "Returns compact image metadata (display_name, image_file_name, group, description) for every image.",
    "",
    "<examples>",
    "### Get the latest screenshots for an app",
    "",
    "```",
    'get_latest_base_snapshot(organizationSlug="sentry", appId="sentry-frontend", project="frontend")',
    "```",
    "",
    "### Get the latest screenshots for a specific branch",
    "",
    "```",
    'get_latest_base_snapshot(organizationSlug="sentry", appId="sentry-frontend", project="frontend", branch="main")',
    "```",
    "</examples>",
    "",
    "<hints>",
    "- The response includes compact metadata per image. Scan the list to find images matching what you need (e.g. filter by group or name containing 'button').",
    "- To view a specific image, use get_sentry_resource(url='<snapshot_url>?selectedSnapshot=<image_file_name>').",
    "- If you need to investigate a specific snapshot comparison, use get_sentry_resource with the snapshot URL.",
    "</hints>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    appId: z
      .string()
      .trim()
      .describe(
        "The app identifier (e.g. 'sentry-frontend', 'com.emergetools.hackernews'). Required.",
      ),
    branch: z
      .string()
      .trim()
      .describe(
        "Filter by git branch (e.g. 'main'). Omit to use the app's default branch.",
      )
      .nullable()
      .default(null),
    project: z
      .string()
      .trim()
      .describe("Project slug or numeric ID for scoping (e.g. 'frontend').")
      .nullable()
      .default(null),
    regionUrl: ParamRegionUrl.nullable().default(null),
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

    const project = params.project ?? undefined;
    const projectId = project && isNumericId(project) ? project : undefined;
    const projectSlug = project && !isNumericId(project) ? project : undefined;
    setTargetTagsAndAttributes({
      organizationSlug: params.organizationSlug,
      projectId,
      projectSlug,
    });

    const data = (await apiService.getLatestBaseSnapshot({
      organizationSlug: params.organizationSlug,
      appId: params.appId,
      branch: params.branch ?? undefined,
      project: projectId,
      projectSlug,
      compactMetadata: true,
    })) as Record<string, unknown>;

    const snapshotId = data.id as string | undefined;
    const images = (data.images as Array<Record<string, unknown>>) || [];
    const appInfo = data.app_info as Record<string, unknown> | undefined;
    const vcsInfo = data.vcs_info as Record<string, unknown> | undefined;

    const snapshotUrl = snapshotId
      ? apiService.getPreprodSnapshotUrl(params.organizationSlug, snapshotId)
      : null;

    const sections: string[] = [];

    sections.push(
      `# Latest Base Snapshot for **${params.appId}** in **${params.organizationSlug}**`,
    );

    sections.push("\n## Summary\n");
    if (snapshotUrl) sections.push(`- **URL**: ${snapshotUrl}`);
    if (snapshotId) sections.push(`- **Snapshot ID**: ${snapshotId}`);
    if (appInfo) {
      if (appInfo.name) sections.push(`- **App Name**: ${appInfo.name}`);
      if (appInfo.platform)
        sections.push(`- **Platform**: ${appInfo.platform}`);
    }
    if (vcsInfo) {
      if (vcsInfo.head_ref)
        sections.push(
          `- **Branch**: ${vcsInfo.head_ref} (\`${String(vcsInfo.head_sha ?? "").slice(0, 8)}\`)`,
        );
    }
    sections.push(`- **Total Images**: ${images.length}`);

    if (images.length > 0) {
      sections.push("\n## Images\n");
      sections.push(
        ...renderSnapshotImageTreeSection(
          "Snapshot Images",
          images.map((image) => ({ image })),
        ),
      );
    }

    sections.push(
      snapshotUrl
        ? `\n## Next Steps\n\n- To view a specific image, use \`get_sentry_resource(url="${snapshotUrl}?selectedSnapshot=<image_file_name>")\``
        : "\n## Next Steps\n\n- To view a specific image, use `get_sentry_resource` with the snapshot URL + `?selectedSnapshot=<image_file_name>`",
    );

    return sections.join("\n");
  },
});
