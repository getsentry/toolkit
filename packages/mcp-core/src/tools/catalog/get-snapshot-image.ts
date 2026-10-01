import { z } from "zod";
import { UserInputError } from "../../errors";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { ParamOrganizationSlug, ParamRegionUrl } from "../../schema";
import { setTagAndAttribute } from "../../telem/scope";
import type { ServerContext } from "../../types";
import { fetchSnapshotImage } from "../support/snapshots/handlers";

export default defineTool({
  name: "get_snapshot_image",
  skills: ["inspect"],
  requiredScopes: ["project:read"],
  description: [
    "Get metadata and image content for one image in a preprod snapshot.",
    "",
    "Use this tool when you need to:",
    "- View the current, previous, or diff image for a snapshot entry",
    "- Inspect metadata and context for a specific snapshot image",
    "- Fetch full-resolution image bytes when preview images are insufficient; full-resolution images can substantially increase response size and token usage",
    "",
    "Pass organizationSlug, snapshotId, and imageIdentifier. Use get_sentry_resource for snapshot URLs.",
    "Preview images are returned by default; set imageResolution=full for original bytes when needed, but expect higher response size and token usage.",
    "",
    "<examples>",
    "### View a preview image",
    "",
    "```",
    'get_snapshot_image(organizationSlug="sentry", snapshotId="231949", imageIdentifier="login_screen.png")',
    "```",
    "",
    "### Fetch original full-resolution bytes",
    "",
    "```",
    'get_snapshot_image(organizationSlug="sentry", snapshotId="231949", imageIdentifier="login_screen.png", imageResolution="full")',
    "```",
    "</examples>",
    "",
    "<hints>",
    "- Use get_snapshot first if you need to discover available image file names.",
    "- Use get_sentry_resource when starting from a Sentry snapshot URL.",
    "- imageIdentifier values may include slashes; pass the full image_file_name exactly as shown by get_snapshot.",
    "</hints>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    snapshotId: z
      .string()
      .trim()
      .min(1)
      .describe("The numeric snapshot artifact ID."),
    imageIdentifier: z
      .string()
      .trim()
      .min(1)
      .describe("The snapshot image file name or identifier to fetch."),
    imageResolution: z
      .enum(["preview", "full"])
      .describe(
        "Return locally generated previews or original full-resolution bytes. Full-resolution images can substantially increase response size and token usage.",
      )
      .default("preview"),
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

    return fetchSnapshotImage(
      apiService,
      params.organizationSlug,
      params.snapshotId,
      params.imageIdentifier,
      params.imageResolution,
      {
        experimentalMode: context.experimentalMode ?? false,
        availableToolNames: context.availableToolNames,
        directToolNames: context.directToolNames,
      },
    );
  },
});
