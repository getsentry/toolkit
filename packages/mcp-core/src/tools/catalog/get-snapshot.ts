import { z } from "zod";
import { UserInputError } from "../../errors";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import { ParamOrganizationSlug, ParamRegionUrl } from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import {
  getSnapshotOutputSchema,
  getSnapshotSummary,
} from "../support/snapshots/summary";

export default defineTool({
  name: "get_snapshot",
  title: "Get Snapshot",
  skills: ["inspect"],
  requiredScopes: ["project:read"],
  description: ({ availableToolNames }) =>
    [
      "Get a preprod snapshot comparison by ID, such as a failed visual regression or screenshot test from CI: its metadata, image counts, and changed images with the percent of pixels that differ. For an app's latest baseline screenshots, use get_latest_base_snapshot.",
      ...(!availableToolNames || availableToolNames.has("get_sentry_resource")
        ? ["For a snapshot URL, use get_sentry_resource."]
        : []),
    ].join(" "),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    snapshotId: z
      .string()
      .trim()
      .min(1)
      .describe("Numeric snapshot artifact ID."),
    showUnmodified: z
      .boolean()
      .describe(
        "Also list unchanged and skipped images. Can make large snapshots much bigger.",
      )
      .default(false),
    regionUrl: ParamRegionUrl.nullable().default(null),
  },
  outputSchema: getSnapshotOutputSchema,
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

    return structuredResult(
      await getSnapshotSummary(
        apiService,
        params.organizationSlug,
        params.snapshotId,
        {
          showUnmodified: params.showUnmodified,
          experimentalMode: context.experimentalMode ?? false,
          availableToolNames: context.availableToolNames,
          directToolNames: context.directToolNames,
        },
      ),
    );
  },
});
