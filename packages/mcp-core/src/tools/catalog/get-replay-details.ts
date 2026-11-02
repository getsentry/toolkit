import { z } from "zod";
import { inlineCode } from "@sentry/toolkit-core/markdown";
import type {
  Issue,
  ReplayDetails,
  SentryApiService,
  TraceMeta,
} from "../../api-client";
import { ApiClientError } from "../../api-client";
import { ConfigurationError, UserInputError } from "../../errors";
import {
  REPLAY_TIMELINE_CATEGORIES,
  ReplayTimelineBuilder,
  type ReplayTimelineCategory,
  type ReplayTimelineEvent,
} from "../../internal/replay-timeline";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { resolveRegionUrlForOrganization } from "../../internal/tool-helpers/resolve-region-url";
import { formatAvailableToolCallInstruction } from "../../internal/tool-helpers/tool-call-formatting";
import { parseSentryUrl } from "../../internal/url-helpers";
import { resolveScopedOrganizationSlug } from "../../internal/url-scope";
import {
  ParamOrganizationSlug,
  ParamRegionUrl,
  ParamReplayId,
  ParamReplayUrl,
} from "../../schema";
import { logIssue } from "../../telem/logging";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import { formatReplayUser } from "../support/search-events/replays";

interface ResolvedReplayParams {
  organizationSlug: string;
  replayId: string;
}

interface RelatedReplayIssue {
  eventId: string;
  issue: Issue | null;
}

interface RelatedReplayTrace {
  traceId: string;
  traceMeta: TraceMeta | null;
}

type ReplayRecording =
  | { status: "unavailable"; reason: string }
  | {
      status: "loaded";
      events: ReplayTimelineEvent[];
      segmentsRead: number;
      truncated: boolean;
    };

interface TimelineRequest {
  categories: ReplayTimelineCategory[] | null;
  startOffsetSeconds: number | null;
  endOffsetSeconds: number | null;
  limit: number;
  skip: number;
}

const MAX_RELATED_ERRORS = 3;
const MAX_RELATED_TRACES = 2;
const DEFAULT_TIMELINE_LIMIT = 50;
const MAX_TIMELINE_LIMIT = 200;
// Five pages of the recording-segments endpoint. Long sessions can exceed
// this; the response says so instead of presenting a partial timeline as whole.
const MAX_REPLAY_SEGMENTS = 500;

export default defineTool({
  name: "get_replay_details",
  skills: ["inspect"],
  requiredScopes: ["org:read", "project:read", "event:read"],
  requiredCapabilities: ["replays"],
  description: [
    "Get a Sentry replay's summary and a timeline of what the user did: page loads and navigations, clicks (including dead and rage clicks), inputs and key presses, console warnings and errors, failed requests, and feedback.",
    "",
    "USE THIS TOOL WHEN USERS:",
    "- Share a replay URL",
    "- Ask what happened in a replay, or what a user saw and clicked",
    "- Need the moments before an error, a dead click, or the end of a session",
    "",
    "<examples>",
    "get_replay_details(replayUrl='https://my-organization.sentry.io/explore/replays/7e07485f-12f9-416b-8b14-26260799b51f/')",
    "get_replay_details(organizationSlug='my-organization', replayId='7e07485f-12f9-416b-8b14-26260799b51f', startOffsetSeconds=-10)",
    "get_replay_details(replayUrl='...', categories=['click', 'network'], startOffsetSeconds=60, endOffsetSeconds=90)",
    "</examples>",
    "",
    "<hints>",
    "- Offsets are seconds from the replay start; negative offsets count back from the end, so startOffsetSeconds=-10 shows the last 10 seconds",
    "- The timeline header counts every recorded event, so you can see what to ask for next",
    "</hints>",
  ].join("\n"),
  inputSchema: {
    replayUrl: ParamReplayUrl.optional(),
    organizationSlug: ParamOrganizationSlug.optional(),
    replayId: ParamReplayId.optional(),
    regionUrl: ParamRegionUrl.nullable().optional(),
    categories: z
      .array(z.enum(REPLAY_TIMELINE_CATEGORIES))
      .min(1)
      .nullable()
      .optional()
      .describe(
        "Timeline categories to show. Default: notable events only (navigations, clicks, inputs, console warnings and errors, failed requests, feedback). Naming a category shows all of its events, such as every request for 'network' or every log level for 'console'.",
      ),
    startOffsetSeconds: z
      .number()
      .nullable()
      .optional()
      .describe(
        "Start of the timeline window in seconds from the replay start. Negative values count back from the replay end.",
      ),
    endOffsetSeconds: z
      .number()
      .nullable()
      .optional()
      .describe(
        "End of the timeline window in seconds from the replay start. Negative values count back from the replay end.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_TIMELINE_LIMIT)
      .nullable()
      .optional()
      .describe(
        `Maximum timeline events to return (1-${MAX_TIMELINE_LIMIT}, default ${DEFAULT_TIMELINE_LIMIT}).`,
      ),
    skip: z
      .number()
      .int()
      .min(0)
      .nullable()
      .optional()
      .describe(
        "Number of matching timeline events to skip. Use the value a previous response gives to continue past the limit.",
      ),
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

    setTargetTagsAndAttributes({
      organizationSlug: resolved.organizationSlug,
      replayId: resolved.replayId,
    });

    const timelineRequest: TimelineRequest = {
      categories: params.categories ?? null,
      startOffsetSeconds: params.startOffsetSeconds ?? null,
      endOffsetSeconds: params.endOffsetSeconds ?? null,
      limit: params.limit ?? DEFAULT_TIMELINE_LIMIT,
      skip: params.skip ?? 0,
    };
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

    const [recording, relatedIssues, relatedTraces] = await Promise.all([
      fetchReplayRecording({
        apiService,
        organizationSlug: resolved.organizationSlug,
        replay,
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

    // Replay URLs also reach this handler through get_sentry_resource, so only
    // suggest a follow-up call when this tool is reachable in the session.
    const canContinue =
      formatAvailableToolCallInstruction({
        toolName: "get_replay_details",
        experimentalMode: context.experimentalMode ?? false,
        availableToolNames: context.availableToolNames,
        directToolNames: context.directToolNames,
      }) !== null;

    return formatReplayOutput({
      replay,
      organizationSlug: resolved.organizationSlug,
      replayUrl:
        params.replayUrl ??
        apiService.getReplayUrl(resolved.organizationSlug, replay.id),
      recording,
      timelineRequest,
      canContinue,
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

async function fetchReplayRecording({
  apiService,
  organizationSlug,
  replay,
}: {
  apiService: SentryApiService;
  organizationSlug: string;
  replay: ReplayDetails;
}): Promise<ReplayRecording> {
  if (replay.is_archived === true) {
    return {
      status: "unavailable",
      reason: "Recording is archived and not available for playback.",
    };
  }
  if (replay.project_id == null || (replay.count_segments ?? 0) === 0) {
    return { status: "unavailable", reason: "No recording was captured." };
  }

  const builder = new ReplayTimelineBuilder();
  try {
    const { segmentsRead, truncated } =
      await apiService.visitReplayRecordingSegments(
        {
          organizationSlug,
          projectSlugOrId: String(replay.project_id),
          replayId: replay.id,
          maxSegments: MAX_REPLAY_SEGMENTS,
        },
        (events) => builder.addSegment(events),
      );
    return {
      status: "loaded",
      events: builder.build(),
      segmentsRead,
      truncated,
    };
  } catch (error) {
    if (error instanceof ApiClientError) {
      return {
        status: "unavailable",
        reason: `The recording could not be loaded: ${error.message}`,
      };
    }
    if (!(error instanceof ConfigurationError)) {
      logIssue(error, {
        loggerScope: ["tools", "get-replay-details", "recording"],
        contexts: {
          request: { organizationSlug, replayId: replay.id },
        },
      });
    }
    return {
      status: "unavailable",
      reason: "The recording could not be loaded because of a Sentry error.",
    };
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

  return await Promise.all(
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

  return await Promise.all(
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

function formatReplayOutput({
  replay,
  organizationSlug,
  replayUrl,
  recording,
  timelineRequest,
  canContinue,
  relatedIssues,
  relatedTraces,
}: {
  replay: ReplayDetails;
  organizationSlug: string;
  replayUrl: string;
  recording: ReplayRecording;
  timelineRequest: TimelineRequest;
  canContinue: boolean;
  relatedIssues: RelatedReplayIssue[];
  relatedTraces: RelatedReplayTrace[];
}): string {
  const lines: string[] = [];
  const device =
    replay.device?.name ??
    replay.device?.model ??
    replay.device?.family ??
    null;

  lines.push(`# Replay ${replay.id} in **${organizationSlug}**`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- **Replay URL**: ${replayUrl}`);
  const startedAtMs = parseTimestampMs(replay.started_at);
  if (startedAtMs !== null) {
    lines.push(`- **Started**: ${formatTimestamp(startedAtMs)}`);
  }
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
  lines.push(`- **User**: ${formatReplayUser(replay)}`);
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
  lines.push(`- **Archived**: ${replay.is_archived === true ? "Yes" : "No"}`);
  if (replay.has_viewed != null) {
    lines.push(`- **Viewed**: ${replay.has_viewed ? "Yes" : "No"}`);
  }

  lines.push("");
  lines.push("## Timeline");
  lines.push("");
  if (recording.status === "unavailable") {
    lines.push(recording.reason);
  } else {
    lines.push(
      ...formatTimeline({ replay, recording, timelineRequest, canContinue }),
    );
  }

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

function formatTimeline({
  replay,
  recording,
  timelineRequest,
  canContinue,
}: {
  replay: ReplayDetails;
  recording: Extract<ReplayRecording, { status: "loaded" }>;
  timelineRequest: TimelineRequest;
  canContinue: boolean;
}): string[] {
  const { events } = recording;
  const lines: string[] = [];
  const startedAtMs = parseTimestampMs(replay.started_at);
  const replayStartMs = startedAtMs ?? events[0]?.timestampMs ?? 0;
  const replayEndMs =
    parseTimestampMs(replay.finished_at) ??
    (startedAtMs !== null && replay.duration != null
      ? startedAtMs + replay.duration * 1000
      : (events.at(-1)?.timestampMs ?? replayStartMs));

  const resolveOffset = (offsetSeconds: number | null): number | null => {
    if (offsetSeconds === null) {
      return null;
    }
    return offsetSeconds < 0
      ? replayEndMs + offsetSeconds * 1000
      : replayStartMs + offsetSeconds * 1000;
  };
  const windowStartMs = resolveOffset(timelineRequest.startOffsetSeconds);
  const windowEndMs = resolveOffset(timelineRequest.endOffsetSeconds);
  if (
    windowStartMs !== null &&
    windowEndMs !== null &&
    windowStartMs > windowEndMs
  ) {
    throw new UserInputError(
      "`startOffsetSeconds` must resolve to a time before `endOffsetSeconds`.",
    );
  }

  const categories = timelineRequest.categories
    ? new Set(timelineRequest.categories)
    : null;
  const matching = events.filter(
    (event) =>
      (categories ? categories.has(event.category) : event.notable) &&
      (windowStartMs === null || event.timestampMs >= windowStartMs) &&
      (windowEndMs === null || event.timestampMs <= windowEndMs),
  );
  const shownEnd = timelineRequest.skip + timelineRequest.limit;
  const shown = matching.slice(timelineRequest.skip, shownEnd);
  const offset = (timestampMs: number) => timestampMs - replayStartMs;

  lines.push(`**Recorded**: ${formatActivityCounts(events)}`);
  const showing = [
    categories
      ? `categories ${timelineRequest.categories?.join(", ")}`
      : "notable events",
  ];
  if (windowStartMs !== null || windowEndMs !== null) {
    showing.push(
      `from ${formatOffset(offset(windowStartMs ?? replayStartMs))} to ${formatOffset(offset(windowEndMs ?? replayEndMs))}`,
    );
  }
  showing.push(
    shown.length > 0 && timelineRequest.skip > 0
      ? `events ${timelineRequest.skip + 1}-${timelineRequest.skip + shown.length} of ${matching.length}`
      : `${shown.length} of ${matching.length} events`,
  );
  lines.push(`**Showing**: ${showing.join(" · ")}`);
  lines.push("");

  if (shown.length === 0) {
    lines.push(
      events.length === 0
        ? "No user activity was found in the recording."
        : "No events match this window and these categories.",
    );
  }
  for (const event of shown) {
    lines.push(formatTimelineEvent(event, offset(event.timestampMs)));
  }

  const notes: string[] = [];
  const remaining = matching.length - shownEnd;
  if (remaining > 0 && canContinue) {
    notes.push(
      `${remaining} more events match. Call \`get_replay_details\` again with the same arguments and \`skip: ${shownEnd}\` to continue.`,
    );
  }
  if (recording.truncated) {
    notes.push(
      `Only the first ${recording.segmentsRead} of ${replay.count_segments ?? "the"} recording segments were read, so later activity is missing.`,
    );
  }
  if (notes.length > 0) {
    lines.push("");
    lines.push(...notes);
  }

  return lines;
}

function formatTimelineEvent(
  event: ReplayTimelineEvent,
  offsetMs: number,
): string {
  const parts = [formatOffset(offsetMs), `**${event.label}**`];
  if (event.target) {
    parts.push(inlineCode(event.target));
  }
  for (const detail of event.details) {
    parts.push(`${detail.label}: ${inlineCode(detail.value)}`);
  }
  return `- ${parts.join(" · ")}`;
}

/** Counts every recorded event by kind, so callers know what else to ask for. */
function formatActivityCounts(events: ReplayTimelineEvent[]): string {
  if (events.length === 0) {
    return "no user activity";
  }
  const counts = new Map<string, number>();
  let failedRequests = 0;
  for (const event of events) {
    counts.set(event.label, (counts.get(event.label) ?? 0) + 1);
    if (event.problem === "failed request") {
      failedRequests += 1;
    }
  }
  return [...counts.entries()]
    .map(([label, count]) =>
      label === "request"
        ? `${count} × request (${failedRequests} failed)`
        : `${count} × ${label}`,
    )
    .join(" · ");
}

/** Formats a replay offset like the Sentry replay player: `01:07.3`. */
function formatOffset(offsetMs: number): string {
  const sign = offsetMs < 0 ? "-" : "";
  const totalTenths = Math.floor(Math.abs(offsetMs) / 100);
  const tenths = totalTenths % 10;
  const totalSeconds = Math.floor(totalTenths / 10);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const mmss = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
  return `${sign}${hours > 0 ? `${hours}:` : ""}${mmss}`;
}

function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function formatTimestamp(timestampMs: number): string {
  return new Date(timestampMs)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, " UTC");
}

function formatDurationSeconds(durationSeconds: number): string {
  if (durationSeconds < 60) {
    return `${durationSeconds}s`;
  }

  const minutes = Math.floor(durationSeconds / 60);
  const seconds = durationSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
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
