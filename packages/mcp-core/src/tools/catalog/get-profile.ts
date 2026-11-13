import { setAttributes, setTags } from "@sentry/core";
import { z } from "zod";
import { UserInputError } from "../../errors";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { isProfileUrl, parseSentryUrl } from "../../internal/url-helpers";
import {
  resolveScopedOrganizationSlug,
  resolveScopedProjectSlugOrId,
} from "../../internal/url-scope";
import {
  ParamOrganizationSlug,
  ParamPeriod,
  ParamRegionUrl,
} from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import { isNumericId, validateSlugOrId } from "../../utils/slug-validation";
import { structuredResult } from "../../internal/tool-helpers/results";
import { hasProfileData } from "../support/profile/analyzer";
import {
  buildFlamegraphAnalysis,
  buildFlamegraphComparison,
  getProfileOutputSchema,
} from "../support/profile/flamegraph-output";

interface ResolvedProfileParams {
  organizationSlug: string;
  projectSlugOrId?: string | number;
  transactionName?: string;
}

/**
 * Resolves profile parameters from URL or explicit params.
 * URL takes precedence if provided and valid.
 */
function resolveProfileParams(params: {
  profileUrl?: string | null;
  organizationSlug?: string | null;
  projectSlugOrId?: string | number | null;
  transactionName?: string | null;
}): ResolvedProfileParams {
  // URL-based resolution
  if (params.profileUrl) {
    if (!isProfileUrl(params.profileUrl)) {
      throw new UserInputError(
        "Invalid profile URL. URL must be a Sentry profile URL (containing /profiling/profile/).",
      );
    }
    const parsed = parseSentryUrl(params.profileUrl);
    return {
      organizationSlug: resolveScopedOrganizationSlug({
        resourceLabel: "Profile",
        scopedOrganizationSlug: params.organizationSlug,
        urlOrganizationSlug: parsed.organizationSlug,
      }),
      projectSlugOrId: parsed.projectSlugOrId
        ? resolveScopedProjectSlugOrId({
            resourceLabel: "Profile",
            scopedProjectSlugOrId: params.projectSlugOrId,
            urlProjectSlug: parsed.projectSlugOrId,
          })
        : (params.projectSlugOrId ?? undefined),
      transactionName: params.transactionName ?? undefined,
    };
  }

  // Explicit params resolution
  if (!params.organizationSlug) {
    throw new UserInputError(
      "Organization slug is required. Provide either a profileUrl or organizationSlug parameter.",
    );
  }

  return {
    organizationSlug: params.organizationSlug,
    projectSlugOrId: params.projectSlugOrId ?? undefined,
    transactionName: params.transactionName ?? undefined,
  };
}

export default defineTool({
  name: "get_profile",
  title: "Get Transaction Profile",
  skills: ["inspect"],
  requiredScopes: ["event:read"],
  requiredCapabilities: ["profiles"],
  hideInExperimentalMode: true, // Replaced by get_sentry_resource in experimental mode

  description:
    "Analyze aggregated CPU profiles (flamegraph) for one Sentry transaction: hot paths, per-function p75/p95/p99, user versus library code, and regressions against a baseline period. For one profile by ID or URL, use get_profile_details.",

  inputSchema: {
    // URL-based input (preferred)
    profileUrl: z
      .string()
      .url()
      .optional()
      .describe(
        "Sentry profile URL; the organization and project come from it. transactionName is still required.",
      ),

    // Explicit params (fallback)
    organizationSlug: ParamOrganizationSlug.optional(),
    regionUrl: ParamRegionUrl.nullable().default(null),
    projectSlugOrId: z
      .union([z.string().trim().superRefine(validateSlugOrId), z.number()])
      .optional()
      .describe(
        "Project slug or numeric ID; required unless profileUrl has it.",
      ),
    transactionName: z
      .string()
      .trim()
      .optional()
      .describe(
        "Exact, case-sensitive transaction name, such as /api/users or POST /graphql. Required; find names with search_traces.",
      ),

    // Time params
    period: ParamPeriod.default("7d"),

    // Comparison mode
    compareAgainstPeriod: ParamPeriod.optional().describe(
      "Baseline time window to compare against, for regression detection.",
    ),

    // Analysis options
    focusOnUserCode: z
      .boolean()
      .default(true)
      .describe("Show only application code; false includes library code."),
    maxHotPaths: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(10)
      .describe("Number of hot paths to show."),
  },

  outputSchema: getProfileOutputSchema,

  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },

  async handler(params, context: ServerContext) {
    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });

    // Resolve params from URL or explicit values
    const resolved = resolveProfileParams({
      profileUrl: params.profileUrl,
      organizationSlug: params.organizationSlug,
      projectSlugOrId: params.projectSlugOrId,
      transactionName: params.transactionName,
    });

    const { organizationSlug, projectSlugOrId, transactionName } = resolved;

    if (!projectSlugOrId) {
      throw new UserInputError(
        "Project is required. Please provide a projectSlugOrId parameter or include it in the profile URL.",
      );
    }

    if (!transactionName) {
      throw new UserInputError(
        "Transaction name is required for flamegraph analysis. Please provide a transactionName parameter.",
      );
    }

    // Resolve project slug to numeric ID if needed (flamegraph API requires numeric ID)
    let projectId: string | number;
    if (
      typeof projectSlugOrId === "number" ||
      isNumericId(String(projectSlugOrId))
    ) {
      projectId = projectSlugOrId;
    } else {
      // It's a slug, resolve to ID
      const project = await apiService.getProject({
        organizationSlug,
        projectSlugOrId: String(projectSlugOrId),
      });
      projectId = project.id;
    }

    setTargetTagsAndAttributes({
      organizationSlug,
      projectSlugOrId: String(projectSlugOrId),
      projectId,
    });
    const profileContext = {
      "transaction.name": transactionName,
      ...(params.compareAgainstPeriod
        ? {
            "baseline.period": params.compareAgainstPeriod,
            "current.period": params.period,
          }
        : {}),
    };
    setTags(profileContext);
    setAttributes(profileContext);

    const baseOutput = {
      transactionName,
      projectId: String(projectId),
      period: params.period,
      baselinePeriod: params.compareAgainstPeriod ?? null,
      focusOnUserCode: params.focusOnUserCode,
    };

    // Comparison mode: compare two time periods
    if (params.compareAgainstPeriod) {
      // Fetch both flamegraphs in parallel
      const [baselineFlamegraph, currentFlamegraph] = await Promise.all([
        apiService.getFlamegraph({
          organizationSlug,
          projectId,
          transactionName,
          statsPeriod: params.compareAgainstPeriod,
        }),
        apiService.getFlamegraph({
          organizationSlug,
          projectId,
          transactionName,
          statsPeriod: params.period,
        }),
      ]);

      const hasBaselineData = hasProfileData(baselineFlamegraph);
      const hasCurrentData = hasProfileData(currentFlamegraph);

      return structuredResult({
        ...baseOutput,
        hasCurrentData,
        hasBaselineData,
        analysis: null,
        comparison:
          hasBaselineData && hasCurrentData
            ? buildFlamegraphComparison(baselineFlamegraph, currentFlamegraph, {
                focusOnUserCode: params.focusOnUserCode,
              })
            : null,
      });
    }

    // Single period analysis mode
    const flamegraph = await apiService.getFlamegraph({
      organizationSlug,
      projectId,
      transactionName,
      statsPeriod: params.period,
    });
    const hasCurrentData = hasProfileData(flamegraph);

    return structuredResult({
      ...baseOutput,
      hasCurrentData,
      hasBaselineData: null,
      analysis: hasCurrentData
        ? buildFlamegraphAnalysis(flamegraph, {
            focusOnUserCode: params.focusOnUserCode,
            maxHotPaths: params.maxHotPaths,
          })
        : null,
      comparison: null,
    });
  },
});
