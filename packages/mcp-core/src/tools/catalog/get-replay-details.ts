import type {
  Issue,
  ReplayDetails,
  ReplayRecordingEvent,
  ReplayRecordingSegments,
  SentryApiService,
  TraceMeta,
} from "../../api-client";
import { UserInputError } from "../../errors";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { resolveRegionUrlForOrganization } from "../../internal/tool-helpers/resolve-region-url";
import { parseSentryUrl } from "../../internal/url-helpers";
import { resolveScopedOrganizationSlug } from "../../internal/url-scope";
import {
  ParamOrganizationSlug,
  ParamRegionUrl,
  ParamReplayId,
  ParamReplayUrl,
} from "../../schema";
import { setTagAndAttribute } from "../../telem/scope";
import type { ServerContext } from "../../types";

interface ResolvedReplayParams {
  organizationSlug: string;
  replayId: string;
}

interface ReplayActivityEvent {
  timestampMs: number | null;
  label: string;
  details: string[];
}

type ReplayRecordingPayload = NonNullable<
  NonNullable<ReplayRecordingEvent["data"]>["payload"]
>;

interface RelatedReplayIssue {
  eventId: string;
  issue: Issue | null;
}

interface RelatedReplayTrace {
  traceId: string;
  traceMeta: TraceMeta | null;
}

const MAX_ACTIVITY_EVENTS = 6;
const MAX_RELATED_ERRORS = 3;
const MAX_RELATED_TRACES = 2;

export default defineTool({
  name: "get_replay_details",
  skills: ["inspect"],
  requiredScopes: ["org:read", "project:read", "event:read"],
  requiredCapabilities: ["replays"],
  description: [
    "Get high-level information about a specific Sentry replay by URL or replay ID.",
    "",
    "USE THIS TOOL WHEN USERS:",
    "- Share a replay URL",
    "- Ask what happened in a specific replay",
    "- Want a concise replay summary plus the next issue or trace lookups to run",
    "",
    "<examples>",
    "### With replay URL",
    "```",
    "get_replay_details(replayUrl='https://my-organization.sentry.io/explore/replays/7e07485f-12f9-416b-8b14-26260799b51f/')",
    "```",
    "",
    "### With organization and replay ID",
    "```",
    "get_replay_details(organizationSlug='my-organization', replayId='7e07485f-12f9-416b-8b14-26260799b51f')",
    "```",
    "</examples>",
  ].join("\n"),
  inputSchema: {
    replayUrl: ParamReplayUrl.optional(),
    organizationSlug: ParamOrganizationSlug.optional(),
    replayId: ParamReplayId.optional(),
    regionUrl: ParamRegionUrl.nullable().optional(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(params, context: ServerContext) {
    const resolved = resolveReplayParams(params);
    const regionUrl = await resolveRegionUrlForOrganization({
      context,
      organizationSlug: resolved.organizationSlug,
      regionUrl: params.regionUrl,
    });
    const apiService = apiServiceFromContext(context, {
      regionUrl: regionUrl ?? undefined,
    });

    setTagAndAttribute("organization.slug", resolved.organizationSlug);
    setTagAndAttribute("replay.id", resolved.replayId);

    const replay = await apiService.getReplayDetails({
      organizationSlug: resolved.organizationSlug,
      replayId: resolved.replayId,
    });
    await assertReplayWithinProjectConstraint({
      apiService,
      organizationSlug: resolved.organizationSlug,
      replay,
      projectSlug: context.constraints.projectSlug,
    });

    const isArchived = replay.is_archived === true;
    const projectId =
      replay.project_id != null ? String(replay.project_id) : null;
    const hasSegments = (replay.count_segments ?? 0) > 0;

    const [{ segments }, relatedIssues, relatedTraces] = await Promise.all([
      fetchReplaySegments({
        apiService,
        organizationSlug: resolved.organizationSlug,
        replayId: resolved.replayId,
        projectId,
        isArchived,
        hasSegments,
      }),
      fetchReplayIssues({
        apiService,
        organizationSlug: resolved.organizationSlug,
        errorIds: replay.error_ids,
      }),
      fetchReplayTraces({
        apiService,
        organizationSlug: resolved.organizationSlug,
        traceIds: replay.trace_ids,
      }),
    ]);

    return formatReplayOutput({
      replay,
      organizationSlug: resolved.organizationSlug,
      replayUrl:
        params.replayUrl ??
        apiService.getReplayUrl(resolved.organizationSlug, replay.id),
      segments,
      isArchived,
      relatedIssues,
      relatedTraces,
    });
  },
});

export function resolveReplayParams(params: {
  replayUrl?: string | null;
  organizationSlug?: string | null;
  replayId?: string | null;
}): ResolvedReplayParams {
  if (params.replayUrl) {
    const parsed = parseSentryUrl(params.replayUrl);
    if (parsed.type !== "replay" || !parsed.replayId) {
      throw new UserInputError(
        "Invalid replay URL. URL must point to a Sentry replay resource.",
      );
    }
    return {
      organizationSlug: resolveScopedOrganizationSlug({
        resourceLabel: "Replay",
        scopedOrganizationSlug: params.organizationSlug,
        urlOrganizationSlug: parsed.organizationSlug,
      }),
      replayId: parsed.replayId,
    };
  }

  if (!params.organizationSlug || !params.replayId) {
    throw new UserInputError(
      "Provide either `replayUrl` or both `organizationSlug` and `replayId`.",
    );
  }

  return {
    organizationSlug: params.organizationSlug,
    replayId: params.replayId,
  };
}

async function assertReplayWithinProjectConstraint({
  apiService,
  organizationSlug,
  replay,
  projectSlug,
}: {
  apiService: SentryApiService;
  organizationSlug: string;
  replay: ReplayDetails;
  projectSlug?: string | null;
}): Promise<void> {
  if (!projectSlug) {
    return;
  }

  if (replay.project_id == null) {
    throw new UserInputError(
      `Replay is outside the active project constraint. Expected project "${projectSlug}".`,
    );
  }

  const project = await apiService.getProject({
    organizationSlug,
    projectSlugOrId: projectSlug,
  });

  if (String(project.id) !== String(replay.project_id)) {
    throw new UserInputError(
      `Replay is outside the active project constraint. Expected project "${projectSlug}".`,
    );
  }
}

function formatReplayOutput({
  replay,
  organizationSlug,
  replayUrl,
  segments,
  isArchived,
  relatedIssues,
  relatedTraces,
}: {
  replay: ReplayDetails;
  organizationSlug: string;
  replayUrl: string;
  segments: ReplayRecordingSegments | null;
  isArchived: boolean;
  relatedIssues: RelatedReplayIssue[];
  relatedTraces: RelatedReplayTrace[];
}): string {
  const lines: string[] = [];
  const user =
    replay.user?.display_name ??
    replay.user?.email ??
    replay.user?.username ??
    replay.user?.id ??
    "Anonymous User";
  const device =
    replay.device?.name ??
    replay.device?.model ??
    replay.device?.family ??
    null;
  const activityEvents = extractReplayActivityEvents(segments);

  // Summary
  lines.push(`# Replay ${replay.id} in **${organizationSlug}**`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- **Replay URL**: ${replayUrl}`);
  lines.push(
    `- **Duration**: ${replay.duration != null ? formatDurationSeconds(replay.duration) : "Unknown"}`,
  );
  lines.push(`- **Environment**: ${replay.environment ?? "Unknown"}`);
  lines.push(
    `- **Browser**: ${formatNameVersion(replay.browser?.name, replay.browser?.version)}`,
  );
  lines.push(
    `- **OS**: ${formatNameVersion(replay.os?.name, replay.os?.version)}`,
  );
  lines.push(`- **User**: ${user}`);
  if (replay.urls.length > 0) {
    lines.push(`- **URLs**: ${replay.urls.slice(0, 3).join(", ")}`);
  }
  if (device) {
    lines.push(`- **Device**: ${device}`);
  }
  if (replay.releases && replay.releases.length > 0) {
    lines.push(`- **Release**: ${replay.releases[0]}`);
  }
  if (replay.replay_type) {
    lines.push(`- **Replay Type**: ${replay.replay_type}`);
  }
  lines.push(`- **Errors**: ${replay.count_errors ?? 0}`);
  lines.push(`- **Rage Clicks**: ${replay.count_rage_clicks ?? 0}`);
  lines.push(`- **Dead Clicks**: ${replay.count_dead_clicks ?? 0}`);
  lines.push(`- **Warnings**: ${replay.count_warnings ?? 0}`);
  lines.push(`- **Infos**: ${replay.count_infos ?? 0}`);
  if (replay.count_segments != null) {
    lines.push(`- **Recording Segments**: ${replay.count_segments}`);
  }
  lines.push(`- **Archived**: ${isArchived ? "Yes" : "No"}`);
  if (replay.has_viewed != null) {
    lines.push(`- **Viewed**: ${replay.has_viewed ? "Yes" : "No"}`);
  }

  // Activity
  lines.push("");
  lines.push("## Activity");
  lines.push("");

  if (isArchived) {
    lines.push("Recording is archived and not available for playback.");
  } else if (activityEvents.length > 0) {
    const startTime = activityEvents[0]?.timestampMs ?? null;
    for (const event of activityEvents) {
      const prefix =
        event.timestampMs !== null && startTime !== null
          ? `${formatRelativeTime(event.timestampMs - startTime)} · `
          : "";
      const details =
        event.details.length > 0 ? ` · ${event.details.join(" · ")}` : "";
      lines.push(`- ${prefix}\`${event.label}\`${details}`);
    }
  } else {
    lines.push("No activity events recorded.");
  }

  // Related
  const hasRelated = relatedIssues.length > 0 || relatedTraces.length > 0;
  if (hasRelated) {
    lines.push("");
    lines.push("## Related");
    lines.push("");

    for (const ri of relatedIssues) {
      if (ri.issue) {
        lines.push(`- **${ri.issue.shortId}**: ${ri.issue.title}`);
      } else {
        lines.push(`- Event \`${ri.eventId}\``);
      }
    }

    for (const rt of relatedTraces) {
      const spanInfo = rt.traceMeta
        ? ` (${rt.traceMeta.span_count} spans)`
        : "";
      lines.push(`- Trace \`${rt.traceId}\`${spanInfo}`);
    }

    lines.push("");
    lines.push(
      "Use `get_sentry_resource` to inspect any issue or trace listed above.",
    );
  }

  return lines.join("\n");
}

function formatDurationSeconds(durationSeconds: number): string {
  if (durationSeconds < 60) {
    return `${durationSeconds}s`;
  }

  const minutes = Math.floor(durationSeconds / 60);
  const seconds = durationSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

async function fetchReplaySegments({
  apiService,
  organizationSlug,
  replayId,
  projectId,
  isArchived,
  hasSegments,
}: {
  apiService: SentryApiService;
  organizationSlug: string;
  replayId: string;
  projectId: string | null;
  isArchived: boolean;
  hasSegments: boolean;
}): Promise<{
  segments: ReplayRecordingSegments | null;
}> {
  if (isArchived || !projectId || !hasSegments) {
    return { segments: null };
  }

  try {
    const segments = await apiService.getReplayRecordingSegments({
      organizationSlug,
      projectSlugOrId: projectId,
      replayId,
    });
    return { segments };
  } catch {
    return { segments: null };
  }
}

async function fetchReplayIssues({
  apiService,
  organizationSlug,
  errorIds,
}: {
  apiService: SentryApiService;
  organizationSlug: string;
  errorIds: string[];
}): Promise<RelatedReplayIssue[]> {
  const ids = errorIds.slice(0, MAX_RELATED_ERRORS);

  return Promise.all(
    ids.map(async (eventId) => {
      try {
        const [issue] = await apiService.listIssues({
          organizationSlug,
          query: eventId,
          limit: 1,
        });
        return { eventId, issue: issue ?? null };
      } catch {
        return { eventId, issue: null };
      }
    }),
  );
}

async function fetchReplayTraces({
  apiService,
  organizationSlug,
  traceIds,
}: {
  apiService: SentryApiService;
  organizationSlug: string;
  traceIds: string[];
}): Promise<RelatedReplayTrace[]> {
  const ids = traceIds.slice(0, MAX_RELATED_TRACES);

  return Promise.all(
    ids.map(async (traceId) => {
      try {
        const traceMeta = await apiService.getTraceMeta({
          organizationSlug,
          traceId,
        });
        return { traceId, traceMeta };
      } catch {
        return { traceId, traceMeta: null };
      }
    }),
  );
}

function formatNameVersion(
  name?: string | null,
  version?: string | null,
): string {
  if (name && version) {
    return `${name} ${version}`;
  }
  return name ?? version ?? "Unknown";
}

function extractReplayActivityEvents(
  segments: ReplayRecordingSegments | null,
): ReplayActivityEvent[] {
  if (!segments) {
    return [];
  }

  const events: ReplayActivityEvent[] = [];

  for (const segment of segments) {
    for (const event of segment) {
      const replayEvent = summarizeReplayEvent(event);
      if (replayEvent) {
        events.push(replayEvent);
      }
      if (events.length >= MAX_ACTIVITY_EVENTS) {
        return events;
      }
    }
  }

  return events;
}

function summarizeReplayEvent(
  event: ReplayRecordingEvent,
): ReplayActivityEvent | null {
  const timestampMs = getEventTimestampMillis(event.timestamp);
  const data = event.data;
  const tag = data?.tag ?? "";
  const payload = data?.payload ?? null;

  if (tag) {
    const replayEvent = summarizeTaggedReplayEvent(tag, payload);
    if (replayEvent) {
      return { timestampMs, ...replayEvent };
    }
  }

  if (event.type !== undefined && data) {
    const href = data.href ?? null;
    if (href) {
      return {
        timestampMs,
        label: "page.view",
        details: [`href=${href}`],
      };
    }
  }

  return null;
}

function summarizeTaggedReplayEvent(
  tag: string,
  payload: ReplayRecordingPayload | null,
): Omit<ReplayActivityEvent, "timestampMs"> | null {
  if (tag === "performanceSpan") {
    const op = firstString(payload?.op);
    const description = firstString(payload?.description);
    const durationMs = payload?.data?.duration ?? null;

    if (description || op) {
      return {
        label: op ?? "performanceSpan",
        details: [
          description ? `description=${description}` : null,
          durationMs !== null ? `duration_ms=${durationMs}` : null,
        ].filter((value): value is string => value !== null),
      };
    }
  }

  if (tag === "ui.click") {
    const message = firstString(payload?.message, payload?.description);
    if (message) {
      return {
        label: tag,
        details: [`message=${quoteDetail(message)}`],
      };
    }
  }

  const knownKeys = ["message", "description", "category", "type"] as const;
  const details: string[] = [];
  for (const key of knownKeys) {
    const value = firstString(payload?.[key]);
    if (value) {
      details.push(`${key}=${quoteDetail(value)}`);
    }
  }
  const extra = summarizeObject(payload, new Set<string>(knownKeys));
  if (extra) {
    details.push(extra);
  }

  return details.length > 0 ? { label: tag, details } : null;
}

function getEventTimestampMillis(value: unknown): number | null {
  if (typeof value !== "number") {
    return null;
  }
  return value > 1e12 ? value : value * 1000;
}

function formatRelativeTime(offsetMs: number): string {
  const offsetSeconds = Math.max(0, Math.round(offsetMs / 1000));
  if (offsetSeconds < 60) {
    return `T+${offsetSeconds}s`;
  }

  const minutes = Math.floor(offsetSeconds / 60);
  const seconds = offsetSeconds % 60;
  return seconds > 0 ? `T+${minutes}m ${seconds}s` : `T+${minutes}m`;
}

function summarizeObject(
  value: Record<string, unknown> | null,
  excludedKeys: ReadonlySet<string> = new Set(),
): string | null {
  if (!value) {
    return null;
  }

  const entries = Object.entries(value)
    .filter(
      ([key, nested]) =>
        !excludedKeys.has(key) &&
        (typeof nested === "string" || typeof nested === "number"),
    )
    .slice(0, 3)
    .map(([key, nested]) => `${key}=${nested}`);

  return entries.length > 0
    ? `payload=${quoteDetail(entries.join(", "))}`
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function quoteDetail(value: string): string {
  return JSON.stringify(value.trim());
}
