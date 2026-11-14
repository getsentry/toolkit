import { z } from "zod";
import { UserInputError } from "../../errors";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  ParamOrganizationSlug,
  ParamProjectSlug,
  ParamRegionUrl,
} from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import { validateResourceId } from "../../utils/slug-validation";

export const updateDsnOutputSchema = z.object({
  dsn: z.object({
    id: z.string(),
    name: z.string(),
    dsn: z.string(),
    isActive: z.boolean(),
    rateLimit: z
      .object({
        count: z.number(),
        windowSeconds: z.number(),
      })
      .nullable()
      .describe("Null when rate limiting is disabled."),
    browserSdkVersion: z.string().nullable(),
    loaderOptions: z
      .object({
        hasReplay: z.boolean(),
        hasPerformance: z.boolean(),
        hasDebug: z.boolean(),
        hasFeedback: z.boolean().optional(),
        hasLogsAndMetrics: z.boolean().optional(),
      })
      .nullable(),
  }),
});

export default defineTool({
  name: "update_dsn",
  title: "Update DSN",
  skills: ["project-management"], // DSN management is part of project setup
  requiredScopes: ["project:write"],
  description:
    "Update a DSN (client key) on a Sentry project: rename it, activate or deactivate it, set or remove its rate limit, or change JavaScript Loader Script options. Returns the settings Sentry saved; tell the user if any requested setting did not change.",
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    projectSlug: ParamProjectSlug,
    keyId: z
      .string()
      .trim()
      .superRefine(validateResourceId)
      .describe("Client key ID from find_dsns."),
    name: z.string().trim().max(64).describe("New key name.").optional(),
    isActive: z
      .boolean()
      .describe("False stops the key from accepting events.")
      .optional(),
    rateLimitWindow: z
      .number()
      .int()
      .min(0)
      .max(60 * 60 * 24)
      .describe("Rate limit window in seconds. Requires rateLimitCount.")
      .optional(),
    rateLimitCount: z
      .number()
      .int()
      .min(0)
      .describe("Maximum events accepted per window. Requires rateLimitWindow.")
      .optional(),
    disableRateLimit: z
      .boolean()
      .describe(
        "True removes the rate limit. Do not combine with rateLimitWindow or rateLimitCount.",
      )
      .optional(),
    browserSdkVersion: z
      .string()
      .trim()
      .describe(
        "JavaScript SDK version the Loader Script serves, such as `latest` or `8.x`.",
      )
      .optional(),
    loaderHasReplay: z
      .boolean()
      .describe("Loader Script: enable Session Replay.")
      .optional(),
    loaderHasPerformance: z
      .boolean()
      .describe("Loader Script: enable tracing (performance monitoring).")
      .optional(),
    loaderHasDebug: z
      .boolean()
      .describe("Loader Script: use the debug bundle with SDK logging.")
      .optional(),
    loaderHasFeedback: z
      .boolean()
      .describe("Loader Script: enable User Feedback.")
      .optional(),
    loaderHasLogsAndMetrics: z
      .boolean()
      .describe(
        "Loader Script: enable logs and metrics. Requires SDK 10.0.0 or later.",
      )
      .optional(),
  },
  outputSchema: updateDsnOutputSchema,
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

    setTargetTagsAndAttributes(params);

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

    const { rateLimit: appliedRateLimit, dynamicSdkLoaderOptions: loader } =
      clientKey;
    return structuredResult({
      dsn: {
        id: String(clientKey.id),
        name: clientKey.name,
        dsn: clientKey.dsn.public,
        isActive: clientKey.isActive,
        rateLimit:
          appliedRateLimit &&
          appliedRateLimit.count > 0 &&
          appliedRateLimit.window > 0
            ? {
                count: appliedRateLimit.count,
                windowSeconds: appliedRateLimit.window,
              }
            : null,
        browserSdkVersion: clientKey.browserSdkVersion || null,
        loaderOptions: loader
          ? {
              hasReplay: loader.hasReplay,
              hasPerformance: loader.hasPerformance,
              hasDebug: loader.hasDebug,
              ...(loader.hasFeedback === undefined
                ? {}
                : { hasFeedback: loader.hasFeedback }),
              ...(loader.hasLogsAndMetrics === undefined
                ? {}
                : { hasLogsAndMetrics: loader.hasLogsAndMetrics }),
            }
          : null,
      },
    });
  },
});
