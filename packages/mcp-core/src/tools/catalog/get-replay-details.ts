import { z } from "zod";
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
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  MAX_SUGGESTED_ACTIONS,
  type SuggestedActionValue,
  type SuggestedToolAction,
  buildSuggestedToolAction,
  suggestedToolActionSchema,
} from "../../internal/tool-helpers/suggested-actions";
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
const MAX_SUMMARY_URLS = 3;

const nullableString = z.string().nullable();

const timelineEventSchema = z.object({
  offsetSeconds: z.number().describe("Seconds from the replay start, to 0.1s."),
  label: z.string().describe("Such as `click`, `dead click`, `request`."),
  target: nullableString.describe(
    "What the event acted on: a selector, URL, or message.",
  ),
  details: z
    .record(z.string(), z.string())
    .describe("Extra facts keyed by name, such as `status` or `text`."),
});

export const getReplayDetailsOutputSchema = z.object({
  replay: z.object({
    id: z.string(),
    organizationSlug: z.string(),
    url: z.string(),
    startedAt: nullableString,
    durationSeconds: z.number().nullable(),
    environment: nullableString,
    browser: nullableString,
    os: nullableString,
    device: nullableString,
    user: z
      .object({
        id: nullableString,
        username: nullableString,
        email: nullableString,
        ip: nullableString,
        geo: z
          .object({
            city: nullableString,
            countryCode: nullableString,
            region: nullableString,
            subdivision: nullableString,
          })
          .nullable(),
      })
      .nullable()
      .describe("Null when anonymous or archived."),
    urls: z
      .array(z.string())
      .describe(`First ${MAX_SUMMARY_URLS} visited URLs.`),
    release: nullableString,
    replayType: nullableString,
    counts: z.object({
      errors: z.number(),
      rageClicks: z.number(),
      deadClicks: z.number(),
      warnings: z.number(),
      infos: z.number(),
      segments: z.number().nullable(),
    }),
    archived: z.boolean(),
    viewed: z.boolean().nullable(),
  }),
  timeline: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("unavailable"),
      reason: z.string(),
    }),
    z.object({
      status: z.literal("loaded"),
      recorded: z
        .record(z.string(), z.record(z.string(), z.number()))
        .describe(
          "Counts by category, then label, before filters. `{}` means no activity.",
        ),
      failedRequests: z.number(),
      categories: z.array(z.enum(REPLAY_TIMELINE_CATEGORIES)).nullable(),
      startOffsetSeconds: z.number().nullable(),
      endOffsetSeconds: z.number().nullable(),
      matchingCount: z
        .number()
        .describe("Events that match the categories and window."),
      skip: z.number(),
      events: z.array(timelineEventSchema),
      nextSkip: z.number().nullable(),
      segmentsRead: z.number(),
      truncated: z
        .boolean()
        .describe("Later activity is missing past `segmentsRead`."),
    }),
  ]),
  related: z.object({
    issues: z
      .array(
        z.object({
          eventId: z.string(),
          shortId: nullableString,
          title: nullableString,
        }),
      )
      .describe(
        `First ${MAX_RELATED_ERRORS} error events; shortId null if no issue found.`,
      ),
    traces: z
      .array(
        z.object({
          traceId: z.string(),
          spanCount: z.number().nullable(),
        }),
      )
      .describe(`The first ${MAX_RELATED_TRACES} traces.`),
  }),
  suggestedActions: z.array(suggestedToolActionSchema),
});

type GetReplayDetailsPayload = z.infer<typeof getReplayDetailsOutputSchema>;
type ReplayTimelinePayload = GetReplayDetailsPayload["timeline"];

export default defineTool({
  name: "get_replay_details",
  title: "Get Replay Details",
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
    "- `timeline.recorded` counts every recorded event by category, so you can see what to ask for next",
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
        "Number of matching timeline events to skip. Pass `timeline.nextSkip` from a previous response to continue past the limit.",
      ),
  },
  outputSchema: getReplayDetailsOutputSchema,
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

    const timeline =
      recording.status === "unavailable"
        ? { status: "unavailable" as const, reason: recording.reason }
        : buildTimeline({ replay, recording, timelineRequest });
    const related = {
      issues: relatedIssues.map(({ eventId, issue }) => ({
        eventId,
        shortId: issue?.shortId ?? null,
        title: issue?.title ?? null,
      })),
      traces: relatedTraces.map(({ traceId, traceMeta }) => ({
        traceId,
        spanCount: traceMeta?.span_count ?? null,
      })),
    };

    return structuredResult({
      replay: buildReplaySummary({
        replay,
        organizationSlug: resolved.organizationSlug,
        replayUrl:
          params.replayUrl ??
          apiService.getReplayUrl(resolved.organizationSlug, replay.id),
      }),
      timeline,
      related,
      // Replay URLs also reach this handler through get_sentry_resource, so
      // only suggest calls that are reachable in the session.
      suggestedActions: buildSuggestedActions({
        organizationSlug: resolved.organizationSlug,
        replayId: replay.id,
        regionUrl: params.regionUrl ?? null,
        timelineRequest,
        timeline,
        related,
        context,
      }),
    } satisfies GetReplayDetailsPayload);
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

function buildReplaySummary({
  replay,
  organizationSlug,
  replayUrl,
}: {
  replay: ReplayDetails;
  organizationSlug: string;
  replayUrl: string;
}): GetReplayDetailsPayload["replay"] {
  const startedAtMs = parseTimestampMs(replay.started_at);

  return {
    id: replay.id,
    organizationSlug,
    url: replayUrl,
    startedAt:
      startedAtMs !== null ? new Date(startedAtMs).toISOString() : null,
    durationSeconds: replay.duration ?? null,
    environment: replay.environment ?? null,
    browser: formatNameVersion(replay.browser?.name, replay.browser?.version),
    os: formatNameVersion(replay.os?.name, replay.os?.version),
    device:
      replay.device?.name ??
      replay.device?.model ??
      replay.device?.family ??
      null,
    user: buildReplayUser(replay),
    urls: replay.urls.slice(0, MAX_SUMMARY_URLS),
    release: replay.releases?.[0] ?? null,
    replayType: replay.replay_type ?? null,
    counts: {
      errors: replay.count_errors ?? 0,
      rageClicks: replay.count_rage_clicks ?? 0,
      deadClicks: replay.count_dead_clicks ?? 0,
      warnings: replay.count_warnings ?? 0,
      infos: replay.count_infos ?? 0,
      segments: replay.count_segments ?? null,
    },
    archived: replay.is_archived === true,
    viewed: replay.has_viewed ?? null,
  };
}

/**
 * Sentry's `display_name` mixes username, email, id, and IP, so the fields are
 * kept separate. Archived replays carry a placeholder user, so they map to null.
 * Snuba returns `""` for missing user columns, so empty strings become null.
 */
function buildReplayUser(
  replay: ReplayDetails,
): GetReplayDetailsPayload["replay"]["user"] {
  if (replay.is_archived === true || !replay.user) {
    return null;
  }
  const { id, username, email, ip, geo } = replay.user;
  const mappedGeo = {
    city: geo?.city || null,
    countryCode: geo?.country_code || null,
    region: geo?.region || null,
    subdivision: geo?.subdivision || null,
  };
  const user = {
    id: id || null,
    username: username || null,
    email: email || null,
    ip: ip || null,
    geo: Object.values(mappedGeo).some((value) => value !== null)
      ? mappedGeo
      : null,
  };
  return user.id || user.username || user.email || user.ip || user.geo
    ? user
    : null;
}

function buildTimeline({
  replay,
  recording,
  timelineRequest,
}: {
  replay: ReplayDetails;
  recording: Extract<ReplayRecording, { status: "loaded" }>;
  timelineRequest: TimelineRequest;
}): Extract<ReplayTimelinePayload, { status: "loaded" }> {
  const { events } = recording;
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
  const toOffsetSeconds = (timestampMs: number | null) =>
    timestampMs === null ? null : toTenthsOfSecond(timestampMs - replayStartMs);

  return {
    status: "loaded",
    ...countRecordedEvents(events),
    categories: timelineRequest.categories,
    startOffsetSeconds: toOffsetSeconds(windowStartMs),
    endOffsetSeconds: toOffsetSeconds(windowEndMs),
    matchingCount: matching.length,
    skip: timelineRequest.skip,
    events: matching.slice(timelineRequest.skip, shownEnd).map((event) => ({
      offsetSeconds: toTenthsOfSecond(event.timestampMs - replayStartMs),
      label: event.label,
      target: event.target,
      details: Object.fromEntries(
        event.details.map((detail) => [detail.label, detail.value]),
      ),
    })),
    nextSkip: matching.length > shownEnd ? shownEnd : null,
    segmentsRead: recording.segmentsRead,
    truncated: recording.truncated,
  };
}

/** Counts every recorded event by category and label, so callers know what else to ask for. */
function countRecordedEvents(events: ReplayTimelineEvent[]): {
  recorded: Partial<Record<ReplayTimelineCategory, Record<string, number>>>;
  failedRequests: number;
} {
  const recorded: Partial<
    Record<ReplayTimelineCategory, Record<string, number>>
  > = {};
  let failedRequests = 0;
  for (const event of events) {
    const labels = (recorded[event.category] ??= {});
    labels[event.label] = (labels[event.label] ?? 0) + 1;
    if (event.problem === "failed request") {
      failedRequests += 1;
    }
  }
  return { recorded, failedRequests };
}

function buildSuggestedActions({
  organizationSlug,
  replayId,
  regionUrl,
  timelineRequest,
  timeline,
  related,
  context,
}: {
  organizationSlug: string;
  replayId: string;
  regionUrl: string | null;
  timelineRequest: TimelineRequest;
  timeline: ReplayTimelinePayload;
  related: GetReplayDetailsPayload["related"];
  context: ServerContext;
}): SuggestedToolAction[] {
  const session = {
    experimentalMode: context.experimentalMode ?? false,
    availableToolNames: context.availableToolNames,
    directToolNames: context.directToolNames,
  };
  const candidates: Array<SuggestedToolAction | null> = [];

  if (timeline.status === "loaded" && timeline.nextSkip !== null) {
    const continueArguments: Record<string, SuggestedActionValue> = {
      organizationSlug,
      replayId,
    };
    if (regionUrl) {
      continueArguments.regionUrl = regionUrl;
    }
    if (timelineRequest.categories) {
      continueArguments.categories = timelineRequest.categories;
    }
    if (timelineRequest.startOffsetSeconds !== null) {
      continueArguments.startOffsetSeconds = timelineRequest.startOffsetSeconds;
    }
    if (timelineRequest.endOffsetSeconds !== null) {
      continueArguments.endOffsetSeconds = timelineRequest.endOffsetSeconds;
    }
    continueArguments.limit = timelineRequest.limit;
    continueArguments.skip = timeline.nextSkip;
    candidates.push(
      buildSuggestedToolAction({
        toolName: "get_replay_details",
        arguments: continueArguments,
        reason: `Show the next matching timeline events; ${timeline.matchingCount - timeline.nextSkip} remain.`,
        ...session,
      }),
    );
  }

  // Alternate issues and traces so the cap does not drop a whole kind. Event
  // lookups resolve through the same issue search, so an event without an
  // issue has no follow-up that would succeed.
  const issueActions = related.issues.map((issue) =>
    issue.shortId
      ? buildSuggestedToolAction({
          toolName: "get_issue_details",
          arguments: { organizationSlug, issueId: issue.shortId },
          reason: "Inspect the issue for an error seen in this replay.",
          ...session,
        })
      : null,
  );
  const traceActions = related.traces.map((trace) =>
    buildSuggestedToolAction({
      toolName: "get_trace_details",
      arguments: { organizationSlug, traceId: trace.traceId },
      reason: "Inspect a trace recorded during this replay.",
      ...session,
    }),
  );
  for (
    let index = 0;
    index < Math.max(issueActions.length, traceActions.length);
    index++
  ) {
    candidates.push(issueActions[index] ?? null, traceActions[index] ?? null);
  }

  return candidates
    .filter((action): action is SuggestedToolAction => action !== null)
    .slice(0, MAX_SUGGESTED_ACTIONS);
}

/** Rounds toward zero to 0.1s, like the Sentry replay player's `01:07.3`. */
function toTenthsOfSecond(offsetMs: number): number {
  return Math.trunc(offsetMs / 100) / 10;
}

function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function formatNameVersion(
  name?: string | null,
  version?: string | null,
): string | null {
  if (name && version) {
    return `${name} ${version}`;
  }
  return name ?? version ?? null;
}
