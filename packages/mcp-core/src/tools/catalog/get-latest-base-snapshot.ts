import { z } from "zod";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import { formatToolCallInstruction } from "../../internal/tool-helpers/tool-call-formatting";
import { ParamOrganizationSlug, ParamRegionUrl } from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import { isNumericId } from "../../utils/slug-validation";
import type { SnapshotVcsInfo } from "../support/snapshots/formatting";
import {
  snapshotImageEntries,
  snapshotImageGroupsSchema,
  snapshotString,
  snapshotVcsSchema,
  toSnapshotImageGroups,
  toSnapshotVcs,
} from "../support/snapshots/structured";

interface InstructionContext {
  experimentalMode: boolean;
  availableToolNames?: ReadonlySet<string>;
  directToolNames?: ReadonlySet<string>;
}

function viewImageInstruction(
  args: { organizationSlug: string; snapshotId: string; snapshotUrl: string },
  context: InstructionContext,
): string {
  return formatToolCallInstruction({
    toolName: "get_snapshot_image",
    arguments: {
      organizationSlug: args.organizationSlug,
      snapshotId: args.snapshotId,
      imageIdentifier: "<imageFileName>",
    },
    showArguments: true,
    ...context,
    purpose: "to view one image; pass its imageFileName as imageIdentifier.",
    fallbackInstruction: `Use the Sentry tool \`get_sentry_resource(url="${args.snapshotUrl}?selectedSnapshot=<URL-encoded imageFileName>")\` to view one image.`,
  });
}

export const getLatestBaseSnapshotOutputSchema = z.object({
  organizationSlug: z.string(),
  appId: z.string(),
  snapshotId: z.string().nullable(),
  url: z.string().nullable(),
  app: z
    .object({
      name: z.string().nullable(),
      platform: z.string().nullable(),
    })
    .nullable(),
  vcs: snapshotVcsSchema.nullable(),
  totalImages: z.number(),
  groups: snapshotImageGroupsSchema,
  responseNotes: z.array(z.string()),
});

export default defineTool({
  name: "get_latest_base_snapshot",
  title: "Get Latest Base Snapshot",
  skills: ["inspect"],
  requiredScopes: ["project:read"],
  description: ({ experimentalMode, availableToolNames, directToolNames }) =>
    [
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
      "Returns compact metadata (imageFileName, displayName, description) for every image, bucketed by group.",
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
      "- The response includes compact metadata per image. Scan the groups to find images matching what you need (e.g. filter by group or name containing 'button').",
      `- ${viewImageInstruction(
        {
          organizationSlug: "<organizationSlug>",
          snapshotId: "<snapshotId>",
          snapshotUrl: "<url>",
        },
        { experimentalMode, availableToolNames, directToolNames },
      )}`,
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
  outputSchema: getLatestBaseSnapshotOutputSchema,
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

    const snapshotId = snapshotString(data.id) ?? null;
    const images = snapshotImageEntries(data.images);
    const appInfo = data.app_info as
      | { name?: unknown; platform?: unknown }
      | null
      | undefined;

    const snapshotUrl = snapshotId
      ? apiService.getPreprodSnapshotUrl(params.organizationSlug, snapshotId)
      : null;

    return structuredResult({
      organizationSlug: params.organizationSlug,
      appId: params.appId,
      snapshotId,
      url: snapshotUrl,
      app:
        appInfo && typeof appInfo === "object"
          ? {
              name: snapshotString(appInfo.name) ?? null,
              platform: snapshotString(appInfo.platform) ?? null,
            }
          : null,
      vcs: toSnapshotVcs(data.vcs_info as SnapshotVcsInfo | undefined),
      totalImages: images.length,
      groups: toSnapshotImageGroups(images),
      responseNotes:
        snapshotId && snapshotUrl
          ? [
              viewImageInstruction(
                {
                  organizationSlug: params.organizationSlug,
                  snapshotId,
                  snapshotUrl,
                },
                {
                  experimentalMode: context.experimentalMode ?? false,
                  availableToolNames: context.availableToolNames,
                  directToolNames: context.directToolNames,
                },
              ),
            ]
          : [],
    });
  },
});
