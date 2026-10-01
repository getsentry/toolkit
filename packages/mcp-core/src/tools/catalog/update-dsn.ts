import { z } from "zod";
import { UserInputError } from "../../errors";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import {
  ParamOrganizationSlug,
  ParamProjectSlug,
  ParamRegionUrl,
} from "../../schema";
import { setTagAndAttribute } from "../../telem/scope";
import type { ServerContext } from "../../types";
import { validateResourceId } from "../../utils/slug-validation";

export default defineTool({
  name: "update_dsn",
  skills: ["project-management"], // DSN management is part of project setup
  requiredScopes: ["project:write"],
  description: [
    "Update settings for an existing DSN (client key) in a project, such as name, active status, rate limit, and loader script options.",
    "",
    "USE THIS TOOL WHEN:",
    "- Deactivating or activating a DSN/client key",
    "- Setting or removing DSN rate limits ('set rate limit of 1000 per hour on DSN X')",
    "- Renaming a DSN ('rename DSN X to Production')",
    "- Configuring Javascript SDK loader script options (session replay, performance, debug, feedback, etc.)",
    "",
    "Be careful when using this tool!",
    "",
    "<examples>",
    "### Rename DSN and set rate limit",
    "```",
    "update_dsn(organizationSlug='my-organization', projectSlug='my-project', keyId='d20df0a1ab5031c7f3c7edca9c02814d', name='Production Key', rateLimitWindow=3600, rateLimitCount=500)",
    "```",
    "",
    "### Deactivate a DSN",
    "```",
    "update_dsn(organizationSlug='my-organization', projectSlug='my-project', keyId='d20df0a1ab5031c7f3c7edca9c02814d', isActive=false)",
    "```",
    "",
    "### Disable rate limit entirely",
    "```",
    "update_dsn(organizationSlug='my-organization', projectSlug='my-project', keyId='d20df0a1ab5031c7f3c7edca9c02814d', disableRateLimit=true)",
    "```",
    "</examples>",
    "",
    "<hints>",
    "- Use `find_dsns()` first to find the `keyId` for the DSN you want to update.",
    "- Both `rateLimitWindow` (seconds) and `rateLimitCount` (error cap) must be provided together to set a rate limit.",
    "</hints>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    projectSlug: ParamProjectSlug,
    keyId: z
      .string()
      .trim()
      .superRefine(validateResourceId)
      .describe(
        "The ID of the DSN (client key) to update. Use find_dsns() to retrieve this ID first.",
      ),
    name: z
      .string()
      .trim()
      .max(64)
      .describe("The new name for the DSN.")
      .optional(),
    isActive: z
      .boolean()
      .describe("Activate or deactivate the DSN.")
      .optional(),
    rateLimitWindow: z
      .number()
      .int()
      .min(0)
      .max(60 * 60 * 24)
      .describe("The time window in seconds for the rate limit.")
      .optional(),
    rateLimitCount: z
      .number()
      .int()
      .min(0)
      .describe(
        "The maximum number of errors allowed within the rate limit window.",
      )
      .optional(),
    disableRateLimit: z
      .boolean()
      .describe(
        "Set to true to disable the rate limit entirely (removes the cap).",
      )
      .optional(),
    browserSdkVersion: z
      .string()
      .trim()
      .describe(
        "The Sentry Javascript SDK version to use (e.g. 'latest', '7.x').",
      )
      .optional(),
    loaderHasReplay: z
      .boolean()
      .describe("Configure Session Replay for the Javascript Loader Script.")
      .optional(),
    loaderHasPerformance: z
      .boolean()
      .describe(
        "Configure Performance Monitoring for the Javascript Loader Script.",
      )
      .optional(),
    loaderHasDebug: z
      .boolean()
      .describe(
        "Configure Debug Bundles & Logging for the Javascript Loader Script.",
      )
      .optional(),
    loaderHasFeedback: z
      .boolean()
      .describe("Configure User Feedback for the Javascript Loader Script.")
      .optional(),
    loaderHasLogsAndMetrics: z
      .boolean()
      .describe(
        "Configure Logs and Metrics for the Javascript Loader Script (requires SDK >= 10.0.0).",
      )
      .optional(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(params, context: ServerContext) {
    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    const organizationSlug = params.organizationSlug;

    setTagAndAttribute("organization.slug", organizationSlug);
    setTagAndAttribute("project.slug", params.projectSlug);

    const hasUpdates =
      params.name !== undefined ||
      params.isActive !== undefined ||
      params.disableRateLimit !== undefined ||
      params.rateLimitWindow !== undefined ||
      params.rateLimitCount !== undefined ||
      params.browserSdkVersion !== undefined ||
      params.loaderHasReplay !== undefined ||
      params.loaderHasPerformance !== undefined ||
      params.loaderHasDebug !== undefined ||
      params.loaderHasFeedback !== undefined ||
      params.loaderHasLogsAndMetrics !== undefined;

    if (!hasUpdates) {
      throw new UserInputError(
        "At least one setting must be provided to update. Provide one or more of: name, isActive, rateLimitWindow + rateLimitCount, disableRateLimit, browserSdkVersion, or loader options.",
      );
    }

    if (
      (params.rateLimitWindow !== undefined &&
        params.rateLimitCount === undefined) ||
      (params.rateLimitWindow === undefined &&
        params.rateLimitCount !== undefined)
    ) {
      throw new UserInputError(
        "Both rateLimitWindow and rateLimitCount must be provided together to set a rate limit.",
      );
    }

    if (
      params.disableRateLimit &&
      (params.rateLimitWindow !== undefined ||
        params.rateLimitCount !== undefined)
    ) {
      throw new UserInputError(
        "Cannot both set a rate limit and disable it at the same time.",
      );
    }

    const zeroRateLimit =
      params.rateLimitWindow !== undefined &&
      params.rateLimitCount !== undefined &&
      (params.rateLimitWindow === 0 || params.rateLimitCount === 0);

    let rateLimit: { window: number; count: number } | null | undefined =
      undefined;
    if (params.disableRateLimit === true || zeroRateLimit) {
      rateLimit = null;
    } else if (
      params.rateLimitWindow !== undefined &&
      params.rateLimitCount !== undefined
    ) {
      rateLimit = {
        window: params.rateLimitWindow,
        count: params.rateLimitCount,
      };
    }

    let dynamicSdkLoaderOptions:
      | {
          hasReplay?: boolean;
          hasPerformance?: boolean;
          hasDebug?: boolean;
          hasFeedback?: boolean;
          hasLogsAndMetrics?: boolean;
        }
      | undefined = undefined;

    if (
      params.loaderHasReplay !== undefined ||
      params.loaderHasPerformance !== undefined ||
      params.loaderHasDebug !== undefined ||
      params.loaderHasFeedback !== undefined ||
      params.loaderHasLogsAndMetrics !== undefined
    ) {
      dynamicSdkLoaderOptions = {};
      if (params.loaderHasReplay !== undefined)
        dynamicSdkLoaderOptions.hasReplay = params.loaderHasReplay;
      if (params.loaderHasPerformance !== undefined)
        dynamicSdkLoaderOptions.hasPerformance = params.loaderHasPerformance;
      if (params.loaderHasDebug !== undefined)
        dynamicSdkLoaderOptions.hasDebug = params.loaderHasDebug;
      if (params.loaderHasFeedback !== undefined)
        dynamicSdkLoaderOptions.hasFeedback = params.loaderHasFeedback;
      if (params.loaderHasLogsAndMetrics !== undefined)
        dynamicSdkLoaderOptions.hasLogsAndMetrics =
          params.loaderHasLogsAndMetrics;
    }

    const clientKey = await apiService.updateClientKey({
      organizationSlug,
      projectSlug: params.projectSlug,
      keyId: params.keyId,
      name: params.name,
      isActive: params.isActive,
      rateLimit,
      browserSdkVersion: params.browserSdkVersion,
      dynamicSdkLoaderOptions,
    });

    let output = `# Updated DSN in **${organizationSlug}/${params.projectSlug}**\n\n`;
    output += `**DSN ID**: ${clientKey.id}\n`;
    output += `**DSN**: ${clientKey.dsn.public}\n`;
    output += `**Name**: ${clientKey.name}\n`;
    output += `**Status**: ${clientKey.isActive ? "Active" : "Inactive"}\n`;

    if (
      clientKey.rateLimit &&
      clientKey.rateLimit.count > 0 &&
      clientKey.rateLimit.window > 0
    ) {
      output += `**Rate Limit**: ${clientKey.rateLimit.count} events per ${clientKey.rateLimit.window} seconds\n`;
    } else {
      output += `**Rate Limit**: Disabled\n`;
    }

    if (clientKey.browserSdkVersion) {
      output += `**Browser SDK Version**: ${clientKey.browserSdkVersion}\n`;
    }

    if (clientKey.dynamicSdkLoaderOptions) {
      const loader = clientKey.dynamicSdkLoaderOptions;
      const optionsStr = [
        `Replay: ${loader.hasReplay ? "Enabled" : "Disabled"}`,
        `Performance: ${loader.hasPerformance ? "Enabled" : "Disabled"}`,
        `Debug: ${loader.hasDebug ? "Enabled" : "Disabled"}`,
        loader.hasFeedback !== undefined
          ? `Feedback: ${loader.hasFeedback ? "Enabled" : "Disabled"}`
          : null,
        loader.hasLogsAndMetrics !== undefined
          ? `Logs & Metrics: ${loader.hasLogsAndMetrics ? "Enabled" : "Disabled"}`
          : null,
      ]
        .filter((val): val is string => val !== null)
        .join(", ");
      output += `**Loader Options**: ${optionsStr}\n`;
    }

    const updates: string[] = [];
    if (params.name) updates.push(`name to "${params.name}"`);
    if (params.isActive !== undefined)
      updates.push(`status to ${params.isActive ? "active" : "inactive"}`);
    if (params.disableRateLimit || zeroRateLimit)
      updates.push("rate limit disabled");
    else if (params.rateLimitWindow !== undefined) {
      updates.push(
        `rate limit to ${params.rateLimitCount} events per ${params.rateLimitWindow}s`,
      );
    }
    if (params.browserSdkVersion)
      updates.push(`browser SDK version to "${params.browserSdkVersion}"`);
    if (dynamicSdkLoaderOptions) {
      updates.push("loader options updated");
    }

    if (updates.length > 0) {
      output += `\n## Updates Applied\n`;
      output += updates.map((update) => `- Updated ${update}`).join("\n");
      output += `\n`;
    }

    output += "\n## Response Notes\n\n";
    output += "- Please tell the user the updated DSN settings.\n";

    return output;
  },
});
