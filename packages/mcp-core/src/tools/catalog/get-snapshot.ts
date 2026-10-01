import { z } from "zod";
import { UserInputError } from "../../errors";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { formatToolCallInstruction } from "../../internal/tool-helpers/tool-call-formatting";
import { ParamOrganizationSlug, ParamRegionUrl } from "../../schema";
import { setTagAndAttribute } from "../../telem/scope";
import type { ServerContext } from "../../types";
import { fetchSnapshotSummary } from "../support/snapshots/handlers";

export default defineTool({
  name: "get_snapshot",
  skills: ["inspect"],
  requiredScopes: ["project:read"],
  description: ({ experimentalMode, availableToolNames, directToolNames }) => {
    const imageInstruction = formatToolCallInstruction({
      toolName: "get_snapshot_image",
      arguments: {
        organizationSlug: "<organization_slug>",
        snapshotId: "<snapshot_id>",
        imageIdentifier: "<image_file_name>",
      },
      experimentalMode,
      availableToolNames,
      directToolNames,
      fallbackInstruction: "Use the Sentry tool `get_sentry_resource`",
    });
    const imageInstructionSuffix = imageInstruction.includes(
      "get_snapshot_image",
    )
      ? " to view a specific image preview or full-resolution image bytes."
      : " to view a specific image preview.";

    return [
      "Get a preprod snapshot comparison summary, including metadata, counts, and changed image sections.",
      "",
      "Use this tool when you need to:",
      "- Investigate a failed snapshot test from CI",
      "- Review what changed in a specific preprod snapshot",
      "- Browse snapshot image file names before viewing a specific image",
      "",
      "Pass organizationSlug and snapshotId. Use get_sentry_resource for snapshot URLs.",
      "Compact output is returned by default. Set showUnmodified=true to list unchanged and skipped images separately.",
      "",
      "<examples>",
      "### Browse a snapshot",
      "",
      "```",
      'get_snapshot(organizationSlug="sentry", snapshotId="231949")',
      "```",
      "",
      "### Include unchanged and skipped images",
      "",
      "```",
      'get_snapshot(organizationSlug="sentry", snapshotId="231949", showUnmodified=true)',
      "```",
      "</examples>",
      "",
      "<hints>",
      `- ${imageInstruction}${imageInstructionSuffix}`,
      "- Use get_sentry_resource when starting from a Sentry snapshot URL.",
      "- The diff percent field shows what percentage of pixels changed (0-100).",
      "- showUnmodified=true is useful when a diff snapshot has no changed image sections.",
      "</hints>",
    ].join("\n");
  },
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    snapshotId: z
      .string()
      .trim()
      .min(1)
      .describe("The numeric snapshot artifact ID."),
    showUnmodified: z
      .boolean()
      .describe(
        "When true, include unchanged and skipped image sections. This can substantially increase response size and token usage for large snapshots.",
      )
      .default(false),
    regionUrl: ParamRegionUrl.nullable().default(null),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(params, context: ServerContext) {
    if (!params.organizationSlug || !params.snapshotId) {
      throw new UserInputError(
        "Provide both organizationSlug and snapshotId. Use get_sentry_resource for snapshot URLs.",
      );
    }

    setTagAndAttribute("organization.slug", params.organizationSlug);

    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });

    return fetchSnapshotSummary(
      apiService,
      params.organizationSlug,
      params.snapshotId,
      null,
      {
        showUnmodified: params.showUnmodified,
        listImagesWhenNoDiffs: true,
        experimentalMode: context.experimentalMode ?? false,
        availableToolNames: context.availableToolNames,
        directToolNames: context.directToolNames,
      },
    );
  },
});
