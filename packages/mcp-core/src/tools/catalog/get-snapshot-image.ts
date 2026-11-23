import { z } from "zod";
import { UserInputError } from "../../errors";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { ParamOrganizationSlug, ParamRegionUrl } from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import { fetchSnapshotImage } from "../support/snapshots/handlers";

export default defineTool({
  name: "get_snapshot_image",
  title: "Get Snapshot Image",
  skills: ["inspect"],
  requiredScopes: ["project:read"],
  description:
    "Get one image from a preprod snapshot: the current, previous, or diff screenshot, with its metadata. Returns a preview image unless full resolution is requested. Get image file names from get_snapshot or get_latest_base_snapshot.",
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    snapshotId: z
      .string()
      .trim()
      .min(1)
      .describe("Numeric snapshot artifact ID."),
    imageIdentifier: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Image file name exactly as get_snapshot lists it, including any slashes.",
      ),
    imageResolution: z
      .enum(["preview", "full"])
      .describe(
        "`full` returns the original bytes, which can make the response much larger.",
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

    setTargetTagsAndAttributes(params);

    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });

    return await fetchSnapshotImage(
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
