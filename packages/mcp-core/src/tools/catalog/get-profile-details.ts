import { z } from "zod";
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
import {
  formatProfileChunkAnalysis,
  formatTransactionProfileAnalysis,
} from "../support/profile/formatter";

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
  skills: ["inspect"],
  requiredScopes: ["event:read"],
  requiredCapabilities: ["profiles"],
  hideInExperimentalMode: true,

  description: [
    "Inspect a specific Sentry profile in detail.",
    "",
    "USE THIS TOOL WHEN:",
    "- User shares a transaction profile URL and wants the details",
    "- User has a profile ID and wants a concise summary plus raw sample structure",
    "- User needs to inspect a continuous profile session by profiler ID and time range",
    "",
    "RETURNS:",
    "- Transaction profile summary with profile URL, transaction, trace, release, and runtime details",
    "- Sample structure summaries such as frame count, sample count, stacks, and thread breakdown",
    "- Top frames by occurrence for a quick hotspot overview",
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

      const traceUrl = profile.transaction?.trace_id
        ? apiService.getTraceUrl(
            resolved.organizationSlug,
            profile.transaction.trace_id,
          )
        : undefined;

      return formatTransactionProfileAnalysis(profile, {
        focusOnUserCode: params.focusOnUserCode,
        profileUrl,
        projectSlug,
        traceUrl,
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

    const chunkAnalysis = formatProfileChunkAnalysis(chunk, {
      focusOnUserCode: params.focusOnUserCode,
    }).replace("# Profile Chunk Details", "## Raw Sample Analysis");

    return [
      `# Continuous Profile ${resolved.profilerId}`,
      "",
      "## Summary",
      `- **Profile URL**: ${profileUrl}`,
      `- **Project**: ${projectSlug}`,
      `- **Profiler ID**: ${resolved.profilerId}`,
      `- **Time Range**: ${resolved.start} to ${resolved.end}`,
      `- **Platform**: ${chunk.platform}`,
      `- **Release**: ${chunk.release}`,
      chunk.environment ? `- **Environment**: ${chunk.environment}` : "",
      "",
      chunkAnalysis,
    ]
      .filter(Boolean)
      .join("\n");
  },
});
