import { getActiveSpan, setAttributes, setTags } from "@sentry/core";
import { z } from "zod";
import type { SentryApiService } from "../../api-client";
import { UserInputError } from "../../errors";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { formatToolCallInstruction } from "../../internal/tool-helpers/tool-call-formatting";
import {
  type ParsedSentryUrl,
  parseSentryUrl,
} from "../../internal/url-helpers";
import {
  resolveScopedOrganizationSlug,
  resolveScopedProjectSlug,
} from "../../internal/url-scope";
import { ParamOrganizationSlug } from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import { isNumericId } from "../../utils/slug-validation";
import getAIConversationDetails from "./get-agent-conversation-details";
import getIssueDetails from "./get-issue-details";
import getMonitorDetails from "./get-monitor-details";
import getProfileDetails from "./get-profile-details";
import getReplayDetails from "./get-replay-details";
import getSnapshot from "./get-snapshot";
import getSnapshotImage from "./get-snapshot-image";
import getSpanDetails from "./get-span-details";
import getTraceDetails from "./get-trace-details";

/** Types with full API integration. */
export const FULLY_SUPPORTED_TYPES = [
  "issue",
  "event",
  "trace",
  "ai_conversation",
  "replay",
  "monitor",
  "snapshot",
] as const;
export type FullySupportedType = (typeof FULLY_SUPPORTED_TYPES)[number];

/** Recognized from URLs but not yet fully supported -- return guidance messages. */
export type RecognizedType = "release";

/** All resource types. */
export type ResolvedResourceType =
  | FullySupportedType
  | RecognizedType
  | "profile"
  | "span";

export interface ResolvedResourceParams {
  type: ResolvedResourceType;
  organizationSlug: string;
  // Issue/Event params
  issueId?: string;
  eventId?: string;
  // Trace/Span params
  traceId?: string;
  spanId?: string;
  // agent conversation params
  conversationId?: string;
  // Profile params
  projectSlugOrId?: string;
  profileId?: string;
  profilerId?: string;
  start?: string;
  end?: string;
  // Replay params
  replayId?: string;
  // Monitor params
  monitorSlug?: string;
  // Release params
  releaseVersion?: string;
  // Snapshot params
  snapshotId?: string;
  selectedSnapshot?: string;
}

export function resolveResourceParams(params: {
  url?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  organizationSlug?: string | null;
  projectSlug?: string | null;
}): ResolvedResourceParams {
  if (params.url) {
    const parsed = parseSentryUrl(params.url);
    return resolveFromParsedUrl(parsed, params);
  }

  if (!params.resourceType) {
    throw new UserInputError(
      "Either `url` or `resourceType` must be provided. " +
        "Pass a `url` to auto-detect the resource type, or specify `resourceType` with `resourceId`.",
    );
  }

  if (
    !FULLY_SUPPORTED_TYPES.includes(params.resourceType as FullySupportedType)
  ) {
    throw new UserInputError(
      `Invalid resourceType: ${params.resourceType}. ` +
        `Supported types: ${FULLY_SUPPORTED_TYPES.join(", ")}`,
    );
  }

  if (!params.organizationSlug) {
    throw new UserInputError(
      "`organizationSlug` is required when not using a URL.",
    );
  }

  const resourceType = params.resourceType as FullySupportedType;
  const organizationSlug = params.organizationSlug;

  if (!params.resourceId) {
    throw new UserInputError("`resourceId` is required when not using a URL.");
  }

  const resourceId = params.resourceId;

  switch (resourceType) {
    case "issue":
      return {
        type: "issue",
        organizationSlug,
        issueId: resourceId.toUpperCase(),
      };

    case "event":
      return {
        type: "event",
        organizationSlug,
        eventId: resourceId,
      };

    case "trace":
      return {
        type: "trace",
        organizationSlug,
        traceId: resourceId,
      };

    case "ai_conversation":
      return {
        type: "ai_conversation",
        organizationSlug,
        conversationId: resourceId,
      };

    case "replay":
      return {
        type: "replay",
        organizationSlug,
        replayId: resourceId,
      };

    case "monitor":
      return {
        type: "monitor",
        organizationSlug,
        monitorSlug: resourceId,
        projectSlugOrId: params.projectSlug ?? undefined,
      };

    case "snapshot":
      return {
        type: "snapshot",
        organizationSlug,
        snapshotId: resourceId,
      };
  }
}

/**
 * When resourceType is provided alongside a URL, it can override a span-focused
 * trace URL to fetch the full trace.
 */
function resolveFromParsedUrl(
  parsed: ParsedSentryUrl,
  params: {
    resourceType?: string | null;
    organizationSlug?: string | null;
    projectSlug?: string | null;
  },
): ResolvedResourceParams {
  const detectedType: ResolvedResourceType | "unknown" =
    parsed.type === "trace" && parsed.spanId ? "span" : parsed.type;
  const organizationSlug = resolveScopedOrganizationSlug({
    resourceLabel: "Sentry resource",
    scopedOrganizationSlug: params.organizationSlug,
    urlOrganizationSlug: parsed.organizationSlug,
  });

  if (detectedType === "unknown") {
    if (parsed.transaction) {
      throw new UserInputError(
        `Detected a performance summary URL for transaction "${parsed.transaction}". Use \`search_traces\` to find traces and performance data for this transaction.`,
      );
    }
    throw new UserInputError(
      "Could not determine resource type from URL. " +
        "Supported URL patterns: issues, events, traces, agent conversations, profiles, replays, monitors, and releases.",
    );
  }

  if (params.resourceType && params.resourceType !== detectedType) {
    if (params.resourceType === "trace" && detectedType === "span") {
      if (!parsed.traceId) {
        throw new UserInputError("Could not extract trace ID from URL.");
      }
      return {
        type: "trace",
        organizationSlug,
        traceId: parsed.traceId,
      };
    }
    throw new UserInputError(
      `Cannot override URL type with resourceType '${params.resourceType}'. Only 'trace' on a span URL can be used as a resourceType override with a URL.`,
    );
  }

  switch (detectedType) {
    case "issue":
      if (!parsed.issueId) {
        throw new UserInputError("Could not extract issue ID from URL.");
      }
      return {
        type: "issue",
        organizationSlug,
        issueId: parsed.issueId,
      };

    case "event":
      if (!parsed.issueId || !parsed.eventId) {
        throw new UserInputError(
          "Could not extract issue ID and event ID from URL.",
        );
      }
      return {
        type: "event",
        organizationSlug,
        issueId: parsed.issueId,
        eventId: parsed.eventId,
      };

    case "trace":
      if (!parsed.traceId) {
        throw new UserInputError("Could not extract trace ID from URL.");
      }
      return {
        type: "trace",
        organizationSlug,
        traceId: parsed.traceId,
      };

    case "span":
      if (!parsed.traceId || !parsed.spanId) {
        throw new UserInputError(
          "Could not extract trace ID and span ID from URL.",
        );
      }
      return {
        type: "span",
        organizationSlug,
        traceId: parsed.traceId,
        spanId: parsed.spanId,
      };

    case "ai_conversation":
      if (!parsed.conversationId) {
        throw new UserInputError(
          "Could not extract agent conversation ID from URL.",
        );
      }
      return {
        type: "ai_conversation",
        organizationSlug,
        conversationId: parsed.conversationId,
        projectSlugOrId: parsed.projectSlugOrId,
        start: parsed.start,
        end: parsed.end,
      };

    case "profile":
      if (!parsed.projectSlugOrId) {
        throw new UserInputError(
          "Could not extract project slug from profile URL.",
        );
      }
      return {
        type: "profile",
        organizationSlug,
        projectSlugOrId: resolveScopedProjectSlug({
          resourceLabel: "Profile",
          scopedProjectSlug: params.projectSlug,
          urlProjectSlug: parsed.projectSlugOrId,
        }),
        profileId: parsed.profileId,
        profilerId: parsed.profilerId,
        start: parsed.start,
        end: parsed.end,
      };

    case "replay":
      if (!parsed.replayId) {
        throw new UserInputError("Could not extract replay ID from URL.");
      }
      return {
        type: "replay",
        organizationSlug,
        replayId: parsed.replayId,
      };

    case "monitor":
      if (!parsed.monitorSlug) {
        throw new UserInputError("Could not extract monitor slug from URL.");
      }
      return {
        type: "monitor",
        organizationSlug,
        monitorSlug: parsed.monitorSlug,
        projectSlugOrId: parsed.projectSlugOrId
          ? isNumericId(parsed.projectSlugOrId)
            ? parsed.projectSlugOrId
            : resolveScopedProjectSlug({
                resourceLabel: "Monitor",
                scopedProjectSlug: params.projectSlug,
                urlProjectSlug: parsed.projectSlugOrId,
              })
          : undefined,
      };

    case "release":
      if (!parsed.releaseVersion) {
        throw new UserInputError("Could not extract release version from URL.");
      }
      return {
        type: "release",
        organizationSlug,
        releaseVersion: parsed.releaseVersion,
      };

    case "snapshot":
      if (!parsed.snapshotId) {
        throw new UserInputError("Could not extract snapshot ID from URL.");
      }
      return {
        type: "snapshot",
        organizationSlug,
        snapshotId: parsed.snapshotId,
        selectedSnapshot: parsed.selectedSnapshot,
      };
  }
}

function assertCatalogToolAvailable(
  context: ServerContext,
  toolName: string,
  resourceLabel: string,
) {
  if (!isToolAvailable(toolName, context.availableToolNames)) {
    throw new UserInputError(
      `${resourceLabel} resources require the inspect skill. Enable inspect tools or call ${toolName} in a session where it is available.`,
    );
  }
}

function isToolAvailable(
  toolName: string,
  availableToolNames?: ReadonlySet<string>,
): boolean {
  return !availableToolNames || availableToolNames.has(toolName);
}

function generateUnsupportedResourceMessage(
  resolved: ResolvedResourceParams,
  apiService: SentryApiService,
  experimentalMode: boolean,
  availableToolNames?: ReadonlySet<string>,
  directToolNames?: ReadonlySet<string>,
): string {
  const { type, organizationSlug } = resolved;

  switch (type) {
    case "release": {
      const releaseUrl = apiService.getReleaseUrl(
        organizationSlug,
        resolved.releaseVersion ?? "",
      );
      const findReleasesInstruction = formatToolCallInstruction({
        toolName: "find_releases",
        arguments: { organizationSlug },
        experimentalMode,
        availableToolNames,
        directToolNames,
        fallbackInstruction: "Release listing is not available in this session",
        purpose: "to list releases and their details",
      });
      return [
        "# Release Detected",
        "",
        `**Organization**: ${organizationSlug}`,
        `**Release**: ${resolved.releaseVersion}`,
        "",
        "To get release information:",
        "",
        `- **View in Sentry**: [Open Release](${releaseUrl})`,
        `- **Find releases**: ${findReleasesInstruction}`,
        `- **Search issues**: Use \`search_issues\` with query \`release:${resolved.releaseVersion}\` to find issues in this release`,
      ].join("\n");
    }

    default:
      // This should never happen due to TypeScript exhaustiveness
      return `Unsupported resource type: ${type}`;
  }
}

export default defineTool({
  name: "get_sentry_resource",
  skills: ["inspect", "triage", "seer"],
  requiredScopes: ["event:read", "project:read"],

  description: ({ experimentalMode, availableToolNames, directToolNames }) => {
    const monitorResourcesAvailable = isToolAvailable(
      "get_monitor_details",
      availableToolNames,
    );
    const fullResolutionInstruction = formatToolCallInstruction({
      toolName: "get_snapshot_image",
      arguments: {
        organizationSlug: "<organization_slug>",
        snapshotId: "<snapshot_id>",
        imageIdentifier: "<image_file_name>",
        imageResolution: "full",
      },
      experimentalMode,
      availableToolNames,
      directToolNames,
      fallbackInstruction:
        "Full-resolution snapshot image bytes are not available in this session",
      purpose: "for full-resolution image bytes",
    });
    const supportedResources = monitorResourcesAvailable
      ? "issues, events, traces, spans, agent conversations, replays, monitors, preprod snapshots, and snapshot images."
      : "issues, events, traces, spans, agent conversations, replays, preprod snapshots, and snapshot images.";
    const resourceIds = [
      ...(monitorResourcesAvailable ? ["- monitor: <monitorSlug>"] : []),
      "- snapshot: <snapshotId>",
    ];

    return [
      "Fetch a Sentry resource by URL, or by resourceType plus resourceId.",
      "Pass a Sentry URL directly when possible; the resource type is auto-detected.",
      "",
      `Supports ${supportedResources}`,
      "Trace lookups return a condensed overview by default.",
      "",
      "Agent Conversations: A conversation is a set of spans sharing the same gen_ai.conversation.id. Use resourceType='ai_conversation' with a conversation ID, or pass a Sentry conversation URL, to fetch the transcript/details. To discover or list conversations, use search_agent_conversations. Conversations are NOT issues — do not use search_issues for conversation queries.",
      "",
      "For preprod snapshot URLs (matching 'sentry.io/preprod/snapshots/'):",
      "- Without ?selectedSnapshot=: returns the snapshot diff summary (changed, added, removed images)",
      `- With ?selectedSnapshot=<image_file_name>: returns the image preview and metadata. ${fullResolutionInstruction}.`,
      "",
      "Resource IDs:",
      ...resourceIds,
      "",
      "<examples>",
      "get_sentry_resource(url='https://sentry.io/issues/PROJECT-123/')",
      "get_sentry_resource(resourceType='issue', organizationSlug='my-org', resourceId='PROJECT-123')",
      "get_sentry_resource(resourceType='ai_conversation', organizationSlug='my-org', resourceId='conversation-123')",
      "get_sentry_resource(url='https://sentry.sentry.io/preprod/snapshots/123/')",
      "get_sentry_resource(url='https://sentry.sentry.io/preprod/snapshots/123/?selectedSnapshot=login_screen.png')",
      "</examples>",
    ].join("\n");
  },

  inputSchema: {
    url: z
      .string()
      .url()
      .optional()
      .describe(
        "Sentry URL. The resource type is auto-detected from the URL pattern.",
      ),

    resourceType: z
      .enum([
        "issue",
        "event",
        "trace",
        "ai_conversation",
        "replay",
        "monitor",
        "snapshot",
      ])
      .optional()
      .describe(
        "Resource type. With a URL, can override a span-focused trace URL with `trace`. Use `monitor` with a monitor slug only when inspect monitor tools are available or `snapshot` with a snapshot artifact ID.",
      ),

    resourceId: z
      .string()
      .trim()
      .optional()
      .describe(
        "Resource identifier: issue shortId (e.g., 'PROJECT-123'), event ID, trace ID, agent conversation ID, replay ID, monitor slug when inspect monitor tools are available, or snapshot artifact ID. Required when not using a URL.",
      ),

    organizationSlug: ParamOrganizationSlug.optional(),
  },

  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },

  async handler(params, context: ServerContext) {
    const resolved = resolveResourceParams({
      url: params.url,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      organizationSlug:
        params.organizationSlug ?? context.constraints.organizationSlug,
      projectSlug: context.constraints.projectSlug,
    });

    const resourceContext = { "resource.type": resolved.type };
    setTags(resourceContext);
    setAttributes(resourceContext);
    setTargetTagsAndAttributes({
      organizationSlug: resolved.organizationSlug,
      spanId: resolved.spanId,
    });

    getActiveSpan()?.setAttribute("app.resource.type", resolved.type);

    // Recognized but not yet fully supported types return guidance messages
    if (resolved.type === "release") {
      const apiService = apiServiceFromContext(context, {
        regionUrl: context.constraints.regionUrl ?? undefined,
      });
      return generateUnsupportedResourceMessage(
        resolved,
        apiService,
        context.experimentalMode ?? false,
        context.availableToolNames,
        context.directToolNames,
      );
    }

    switch (resolved.type) {
      case "issue":
        return getIssueDetails.handler(
          {
            organizationSlug: resolved.organizationSlug,
            issueId: resolved.issueId,
            regionUrl: context.constraints.regionUrl ?? null,
          },
          context,
        );

      case "event":
        return getIssueDetails.handler(
          {
            organizationSlug: resolved.organizationSlug,
            issueId: resolved.issueId,
            eventId: resolved.eventId,
            regionUrl: context.constraints.regionUrl ?? null,
          },
          context,
        );

      case "trace":
        return getTraceDetails.handler(
          {
            organizationSlug: resolved.organizationSlug,
            traceId: resolved.traceId!,
            regionUrl: context.constraints.regionUrl ?? null,
          },
          context,
        );

      case "span":
        return getSpanDetails.handler(
          {
            organizationSlug: resolved.organizationSlug,
            traceId: resolved.traceId!,
            spanId: resolved.spanId!,
            regionUrl: context.constraints.regionUrl ?? null,
          },
          context,
        );

      case "ai_conversation":
        return getAIConversationDetails.handler(
          {
            organizationSlug: resolved.organizationSlug,
            conversationId: resolved.conversationId!,
            project: resolved.projectSlugOrId,
            start: resolved.start,
            end: resolved.end,
            regionUrl: context.constraints.regionUrl ?? undefined,
          },
          context,
        );

      case "replay":
        return getReplayDetails.handler(
          {
            replayUrl: params.url,
            organizationSlug: resolved.organizationSlug,
            replayId: resolved.replayId,
            regionUrl: context.constraints.regionUrl ?? undefined,
          },
          context,
        );

      case "monitor":
        assertCatalogToolAvailable(context, "get_monitor_details", "Monitor");
        return getMonitorDetails.handler(
          {
            organizationSlug: resolved.organizationSlug,
            projectSlugOrId: resolved.projectSlugOrId ?? null,
            monitorSlug: resolved.monitorSlug!,
            regionUrl: context.constraints.regionUrl ?? null,
            environment: null,
            period: "24h",
            start: null,
            end: null,
            checkInLimit: 10,
            includeStats: true,
            rollupSeconds: null,
          },
          context,
        );

      case "profile":
        return getProfileDetails.handler(
          {
            profileUrl: params.url,
            organizationSlug: resolved.organizationSlug,
            projectSlugOrId: resolved.projectSlugOrId,
            profileId: resolved.profileId,
            profilerId: resolved.profilerId,
            start: resolved.start,
            end: resolved.end,
            regionUrl: context.constraints.regionUrl ?? null,
            focusOnUserCode: true,
          },
          context,
        );

      case "snapshot":
        if (resolved.selectedSnapshot) {
          return getSnapshotImage.handler(
            {
              organizationSlug: resolved.organizationSlug,
              snapshotId: resolved.snapshotId!,
              imageIdentifier: resolved.selectedSnapshot,
              imageResolution: "preview",
              regionUrl: context.constraints.regionUrl ?? null,
            },
            context,
          );
        }

        return getSnapshot.handler(
          {
            organizationSlug: resolved.organizationSlug,
            snapshotId: resolved.snapshotId!,
            showUnmodified: false,
            regionUrl: context.constraints.regionUrl ?? null,
          },
          context,
        );

      default: {
        const _exhaustiveCheck: never = resolved.type;
        throw new Error(`Unhandled resource type: ${_exhaustiveCheck}`);
      }
    }
  },
});
