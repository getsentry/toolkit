import { z } from "zod";
import { isLegacySpeedscopeProfile } from "../../api-client/types";
import { UserInputError } from "../../errors";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { resolveRegionUrlForOrganization } from "../../internal/tool-helpers/resolve-region-url";
import { isProfileUrl, parseSentryUrl } from "../../internal/url-helpers";
import {
  resolveScopedOrganizationSlug,
  resolveScopedProjectSlugOrId,
} from "../../internal/url-scope";
import { ParamOrganizationSlug, ParamRegionUrl } from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import {
  isNumericId,
  validateResourceId,
  validateSlugOrId,
} from "../../utils/slug-validation";
import { structuredResult } from "../../internal/tool-helpers/results";
import { buildSuggestedToolAction } from "../../internal/tool-helpers/suggested-actions";
import {
  buildContinuousProfileDetails,
  buildLegacyProfileDetails,
  buildTransactionProfileDetails,
  getProfileDetailsOutputSchema,
} from "../support/profile/details-output";

type ResolvedProfileDetailsParams =
  | {
      mode: "transaction";
      organizationSlug: string;
      projectSlugOrId: string | number;
      profileId: string;
    }
  | {
      mode: "continuous";
      organizationSlug: string;
      projectSlugOrId: string | number;
      profilerId: string;
      start: string;
      end: string;
    };

function resolveProfileDetailsParams(params: {
  profileUrl?: string | null;
  organizationSlug?: string | null;
  projectSlugOrId?: string | number | null;
  profileId?: string | null;
  profilerId?: string | null;
  start?: string | null;
  end?: string | null;
}): ResolvedProfileDetailsParams {
  if (params.profileUrl) {
    if (!isProfileUrl(params.profileUrl)) {
      throw new UserInputError(
        "Invalid profile URL. URL must point to a Sentry profile resource.",
      );
    }

    const parsed = parseSentryUrl(params.profileUrl);
    if (parsed.type !== "profile" || !parsed.projectSlugOrId) {
      throw new UserInputError(
        "Invalid profile URL. URL must point to a Sentry profile resource.",
      );
    }

    if (parsed.profileId) {
      return {
        mode: "transaction",
        organizationSlug: resolveScopedOrganizationSlug({
          resourceLabel: "Profile",
          scopedOrganizationSlug: params.organizationSlug,
          urlOrganizationSlug: parsed.organizationSlug,
        }),
        projectSlugOrId: resolveScopedProjectSlugOrId({
          resourceLabel: "Profile",
          scopedProjectSlugOrId: params.projectSlugOrId,
          urlProjectSlug: parsed.projectSlugOrId,
        }),
        profileId: parsed.profileId,
      };
    }

    if (parsed.profilerId && parsed.start && parsed.end) {
      return {
        mode: "continuous",
        organizationSlug: resolveScopedOrganizationSlug({
          resourceLabel: "Profile",
          scopedOrganizationSlug: params.organizationSlug,
          urlOrganizationSlug: parsed.organizationSlug,
        }),
        projectSlugOrId: resolveScopedProjectSlugOrId({
          resourceLabel: "Profile",
          scopedProjectSlugOrId: params.projectSlugOrId,
          urlProjectSlug: parsed.projectSlugOrId,
        }),
        profilerId: parsed.profilerId,
        start: parsed.start,
        end: parsed.end,
      };
    }

    throw new UserInputError(
      "Continuous profile URLs must include `profilerId`, `start`, and `end` query parameters.",
    );
  }

  const hasTransactionInput = Boolean(params.profileId);
  const hasAnyContinuousInput = Boolean(
    params.profilerId || params.start || params.end,
  );

  if (hasTransactionInput && hasAnyContinuousInput) {
    throw new UserInputError(
      "Provide either `profileId` for a transaction profile or `profilerId` + `start` + `end` for a continuous profile, not both.",
    );
  }

  if (!params.organizationSlug || !params.projectSlugOrId) {
    throw new UserInputError(
      "Provide either `profileUrl` or both `organizationSlug` and `projectSlugOrId`.",
    );
  }

  if (params.profileId) {
    return {
      mode: "transaction",
      organizationSlug: params.organizationSlug,
      projectSlugOrId: params.projectSlugOrId,
      profileId: params.profileId,
    };
  }

  if (params.profilerId && params.start && params.end) {
    return {
      mode: "continuous",
      organizationSlug: params.organizationSlug,
      projectSlugOrId: params.projectSlugOrId,
      profilerId: params.profilerId,
      start: params.start,
      end: params.end,
    };
  }

  throw new UserInputError(
    "Provide either `profileId` for a transaction profile, or `profilerId`, `start`, and `end` for a continuous profile.",
  );
}

async function resolveProjectContext(
  apiService: ReturnType<typeof apiServiceFromContext>,
  organizationSlug: string,
  projectSlugOrId: string | number,
  options: {
    requireNumericId?: boolean;
  } = {},
): Promise<{ projectId: string | number; projectSlug: string }> {
  const requireNumericId = options.requireNumericId ?? false;
  const isNumericProject =
    typeof projectSlugOrId === "number" || isNumericId(String(projectSlugOrId));

  if (!isNumericProject && !requireNumericId) {
    return {
      projectId: projectSlugOrId,
      projectSlug: String(projectSlugOrId),
    };
  }

  const project = await apiService.getProject({
    organizationSlug,
    projectSlugOrId: String(projectSlugOrId),
  });

  return {
    projectId: project.id,
    projectSlug: project.slug,
  };
}

export default defineTool({
  name: "get_profile_details",
  title: "Get Profile Details",
  skills: ["inspect"],
  requiredScopes: ["event:read"],
  requiredCapabilities: ["profiles"],
  hideInExperimentalMode: true,

  description: [
    "Inspect one specific Sentry profile in detail, by profile ID, profiler ID or URL.",
    "For aggregated hot paths across a transaction, use get_profile.",
    "",
    "USE THIS TOOL WHEN:",
    "- User shares a transaction profile URL and wants the details",
    "- User has a profile ID and wants a concise summary plus raw sample structure",
    "- User needs to inspect a continuous profile session by profiler ID and time range",
    "",
    "RETURNS:",
    "- `profile.profileType`: `transaction`, `legacy`, or `continuous`",
    "- Transaction profile summary with profile URL, transaction, trace, release, and runtime details",
    "- Sample structure summaries such as frame count, sample count, stacks, and thread breakdown",
    "- Top frames by occurrence for a quick hotspot overview",
    "- Legacy profiles (for example Android) return summary metadata only, with `samples: null` and a suggested get_profile call",
    "",
    "NOTE: This tool supports two profile modes.",
    "- Transaction profiles: pass `profileUrl` or `organizationSlug` + `projectSlugOrId` + `profileId`",
    "- Continuous profiles: pass `profileUrl` or `organizationSlug` + `projectSlugOrId` + `profilerId` + `start` + `end`",
    "",
    "<examples>",
    "### Transaction profile URL",
    "```",
    "get_profile_details(",
    "  profileUrl='https://my-org.sentry.io/explore/profiling/profile/backend/cfe78a5c892d4a64a962d837673398d2/flamegraph/'",
    ")",
    "```",
    "",
    "### Transaction profile by ID",
    "```",
    "get_profile_details(",
    "  organizationSlug='my-org',",
    "  projectSlugOrId='backend',",
    "  profileId='cfe78a5c892d4a64a962d837673398d2'",
    ")",
    "```",
    "",
    "### Continuous profile by session",
    "```",
    "get_profile_details(",
    "  organizationSlug='my-org',",
    "  projectSlugOrId='backend',",
    "  profilerId='041bde57b9844e36b8b7e5734efae5f7',",
    "  start='2024-01-01T00:00:00Z',",
    "  end='2024-01-01T01:00:00Z'",
    ")",
    "```",
    "</examples>",
    "",
    "<hints>",
    "- Open `profileUrl` in Sentry for the full flamegraph, and `traceUrl` to inspect the end-to-end request",
    "- Use search_profiles to find similar profiles",
    "</hints>",
  ].join("\n"),

  inputSchema: {
    profileUrl: z
      .string()
      .url()
      .optional()
      .describe(
        "Sentry transaction profile or continuous profile URL. If provided, organization, project, and profile identifiers are extracted from the URL.",
      ),
    organizationSlug: ParamOrganizationSlug.optional(),
    regionUrl: ParamRegionUrl.nullable().default(null),
    projectSlugOrId: z
      .union([z.string().trim().superRefine(validateSlugOrId), z.number()])
      .optional()
      .describe("Project slug or numeric ID"),
    profileId: z
      .string()
      .trim()
      .superRefine(validateResourceId)
      .optional()
      .describe("Transaction profile ID from a profile flamegraph URL"),
    profilerId: z
      .string()
      .trim()
      .superRefine(validateResourceId)
      .optional()
      .describe("Continuous profiler session ID"),
    start: z
      .string()
      .trim()
      .optional()
      .describe(
        "Continuous profile start time in ISO 8601 format, for example '2024-01-01T00:00:00Z'",
      ),
    end: z
      .string()
      .trim()
      .optional()
      .describe(
        "Continuous profile end time in ISO 8601 format, for example '2024-01-01T01:00:00Z'",
      ),
    focusOnUserCode: z
      .boolean()
      .default(true)
      .describe(
        "Show only user code frames in the hotspot table. Set to false to include library frames.",
      ),
  },

  outputSchema: getProfileDetailsOutputSchema,

  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },

  async handler(params, context: ServerContext) {
    const resolved = resolveProfileDetailsParams({
      profileUrl: params.profileUrl,
      organizationSlug: params.organizationSlug,
      projectSlugOrId: params.projectSlugOrId,
      profileId: params.profileId,
      profilerId: params.profilerId,
      start: params.start,
      end: params.end,
    });

    const regionUrl = await resolveRegionUrlForOrganization({
      context,
      organizationSlug: resolved.organizationSlug,
      regionUrl: params.regionUrl,
    });

    const apiService = apiServiceFromContext(context, {
      regionUrl: regionUrl ?? undefined,
    });

    setTargetTagsAndAttributes({ organizationSlug: resolved.organizationSlug });

    if (resolved.mode === "transaction") {
      setTargetTagsAndAttributes({
        organizationSlug: resolved.organizationSlug,
        profileId: resolved.profileId,
      });
      const isNumericProjectInput =
        typeof resolved.projectSlugOrId === "number" ||
        isNumericId(String(resolved.projectSlugOrId));
      let projectSlug: string;
      let profile: Awaited<ReturnType<typeof apiService.getTransactionProfile>>;

      if (isNumericProjectInput) {
        const [project, fetchedProfile] = await Promise.all([
          apiService.getProject({
            organizationSlug: resolved.organizationSlug,
            projectSlugOrId: String(resolved.projectSlugOrId),
          }),
          apiService.getTransactionProfile({
            organizationSlug: resolved.organizationSlug,
            projectSlugOrId: resolved.projectSlugOrId,
            profileId: resolved.profileId,
          }),
        ]);

        projectSlug = project.slug;
        profile = fetchedProfile;
      } else {
        projectSlug = String(resolved.projectSlugOrId);
        profile = await apiService.getTransactionProfile({
          organizationSlug: resolved.organizationSlug,
          projectSlugOrId: resolved.projectSlugOrId,
          profileId: resolved.profileId,
        });
      }

      setTargetTagsAndAttributes({
        organizationSlug: resolved.organizationSlug,
        projectSlug,
      });

      const profileUrl =
        params.profileUrl ??
        apiService.getProfileUrl(
          resolved.organizationSlug,
          projectSlug,
          resolved.profileId,
        );

      if (isLegacySpeedscopeProfile(profile)) {
        const legacyTraceId = profile.metadata?.traceID;
        const details = buildLegacyProfileDetails(profile, {
          profileUrl,
          project: projectSlug,
          profileId: resolved.profileId,
          traceUrl: legacyTraceId
            ? apiService.getTraceUrl(resolved.organizationSlug, legacyTraceId)
            : null,
        });
        // Legacy profiles have no sample data, so the aggregated flamegraph is
        // the next step. Profile URLs also reach this handler through
        // get_sentry_resource, so only suggest it when get_profile is callable.
        const transactionName = details.profile.transactionName;
        const flamegraphAction = transactionName
          ? buildSuggestedToolAction({
              toolName: "get_profile",
              arguments: {
                organizationSlug: resolved.organizationSlug,
                projectSlugOrId: projectSlug,
                transactionName,
                ...(regionUrl ? { regionUrl } : {}),
              },
              reason:
                "Legacy profiles have no sample data; the aggregated transaction flamegraph shows hot paths.",
              experimentalMode: context.experimentalMode ?? false,
              availableToolNames: context.availableToolNames,
              directToolNames: context.directToolNames,
            })
          : null;
        return structuredResult({
          ...details,
          suggestedActions: flamegraphAction ? [flamegraphAction] : [],
        });
      }

      const traceId = profile.transaction?.trace_id;
      return structuredResult({
        ...buildTransactionProfileDetails(
          profile,
          {
            profileUrl,
            project: projectSlug,
            profileId: resolved.profileId,
            traceUrl: traceId
              ? apiService.getTraceUrl(resolved.organizationSlug, traceId)
              : null,
          },
          { focusOnUserCode: params.focusOnUserCode },
        ),
        suggestedActions: [],
      });
    }

    setTargetTagsAndAttributes({
      organizationSlug: resolved.organizationSlug,
      profilerId: resolved.profilerId,
    });

    const { projectId, projectSlug } = await resolveProjectContext(
      apiService,
      resolved.organizationSlug,
      resolved.projectSlugOrId,
      { requireNumericId: true },
    );

    setTargetTagsAndAttributes({
      organizationSlug: resolved.organizationSlug,
      projectSlug,
      projectId,
    });

    const chunk = await apiService.getProfileChunk({
      organizationSlug: resolved.organizationSlug,
      profilerId: resolved.profilerId,
      projectId,
      start: resolved.start,
      end: resolved.end,
    });

    const profileUrl =
      params.profileUrl ??
      apiService.getContinuousProfileUrl(
        resolved.organizationSlug,
        projectSlug,
        {
          profilerId: resolved.profilerId,
          start: resolved.start,
          end: resolved.end,
        },
      );

    return structuredResult({
      ...buildContinuousProfileDetails(
        chunk,
        {
          profileUrl,
          project: projectSlug,
          profilerId: resolved.profilerId,
          start: resolved.start,
          end: resolved.end,
        },
        { focusOnUserCode: params.focusOnUserCode },
      ),
      suggestedActions: [],
    });
  },
});
