import { inlineCode } from "@sentry/toolkit-core/markdown";
import { z } from "zod";
import type { ReplayDetails, SentryApiService } from "../../../api-client";
import { structuredResult } from "../../../internal/tool-helpers/results";
import {
  buildSuggestedToolAction,
  type SuggestedToolAction,
  suggestedToolActionSchema,
} from "../../../internal/tool-helpers/suggested-actions";
import { formatToolCallInstruction } from "../../../internal/tool-helpers/tool-call-formatting";
import type { StructuredToolOutput } from "../../types";
import {
  DASHBOARD_LINK_HINT,
  type ExecutedSearch,
  formatExecutedSearch,
  formatSearchPresentationHint,
  formatSentryDashboardLink,
} from "./formatters";
import { timeRangeSchema } from "./structured";

export const DEFAULT_REPLAY_SORT = "-started_at";
export const DEFAULT_REPLAY_STATS_PERIOD = "14d";

export const REPLAY_SORT_FIELDS = [
  "activity",
  "browser.name",
  "browser.version",
  "count_dead_clicks",
  "count_errors",
  "count_infos",
  "count_rage_clicks",
  "count_urls",
  "count_warnings",
  "device.brand",
  "device.family",
  "device.model",
  "device.name",
  "dist",
  "duration",
  "finished_at",
  "os.name",
  "os.version",
  "platform",
  "project_id",
  "sdk.name",
  "started_at",
  "user.email",
  "user.id",
  "user.username",
] as const;

const replaySortValues = [
  ...REPLAY_SORT_FIELDS,
  ...REPLAY_SORT_FIELDS.map((field) => `-${field}`),
];

const REPLAY_SORT_VALUES = new Set(replaySortValues);

interface ReplayTimeRange {
  statsPeriod?: string;
  start?: string;
  end?: string;
}

export interface FormatReplayResultsParams {
  replays: ReplayDetails[];
  inputQuery: string;
  includeExplanation: boolean;
  organizationSlug: string;
  apiService: SentryApiService;
  searchUrl: string;
  replayQuery: string;
  sort: string;
  environment?: string | string[] | null;
  explanation?: string;
  timeRange?: ReplayTimeRange;
  executedSearch?: ExecutedSearch;
  experimentalMode?: boolean;
  availableToolNames?: ReadonlySet<string>;
  directToolNames?: ReadonlySet<string>;
}

const REPLAY_RESULTS_HINT =
  "Cards or rows work well for these replays, with replay IDs, user context, duration, click/error counts, and page URLs visible.";
const REPLAY_EMPTY_HINT =
  "Try broadening the query or expanding the time range.";
/** List previews; the counts and get_replay_details give the rest. */
const MAX_REPLAY_URLS = 3;
const MAX_REPLAY_TRACE_IDS = 3;
const MAX_REPLAY_RELEASES = 3;

const nameVersionSchema = z.object({
  name: z.string().nullable(),
  version: z.string().nullable(),
});

export const searchReplaysOutputSchema = z.object({
  query: z.string(),
  explanation: z.string().nullable(),
  executedSearch: z.object({
    query: z.string(),
    sort: z.string(),
    environment: z.array(z.string()),
    timeRange: timeRangeSchema,
  }),
  url: z.string().describe("Opens these results in Sentry."),
  presentationHint: z.string(),
  notes: z.array(z.string()),
  replays: z.array(
    z.object({
      id: z.string(),
      replayUrl: z.string(),
      startedAt: z.string().nullable(),
      durationSeconds: z.number().nullable(),
      user: z
        .object({
          id: z.string().nullable(),
          username: z.string().nullable(),
          email: z.string().nullable(),
          ip: z.string().nullable(),
        })
        .nullable()
        .describe("Null for archived replays."),
      errorCount: z.number().nullable(),
      rageClickCount: z.number().nullable(),
      deadClickCount: z.number().nullable(),
      environment: z.string().nullable(),
      browser: nameVersionSchema,
      urls: z
        .array(z.string())
        .describe(`The first ${MAX_REPLAY_URLS} visited pages.`),
      urlCount: z.number(),
      releases: z
        .array(z.string())
        .describe(`The first ${MAX_REPLAY_RELEASES} releases.`),
      releaseCount: z.number(),
      traceIds: z
        .array(z.string())
        .describe(`The first ${MAX_REPLAY_TRACE_IDS} trace IDs.`),
      traceCount: z.number(),
      isArchived: z.boolean(),
    }),
  ),
  suggestedActions: z.array(suggestedToolActionSchema),
});

export type SearchReplaysStructuredContent = z.infer<
  typeof searchReplaysOutputSchema
>;

function toEnvironmentList(environment?: string | string[] | null): string[] {
  if (!environment) {
    return [];
  }
  return Array.isArray(environment) ? environment : [environment];
}

export function buildStructuredReplayResults(
  params: FormatReplayResultsParams & { notes: string[] },
): StructuredToolOutput<SearchReplaysStructuredContent> {
  const { apiService, organizationSlug } = params;
  const replays = params.replays.map((replay) => ({
    id: replay.id,
    replayUrl: apiService.getReplayUrl(organizationSlug, replay.id),
    startedAt: replay.started_at ?? null,
    durationSeconds: replay.duration ?? null,
    // Archived rows carry placeholder user data ("Archived Replay" as id).
    user:
      replay.is_archived === true
        ? null
        : {
            id: replay.user?.id || null,
            username: replay.user?.username || null,
            email: replay.user?.email || null,
            ip: replay.user?.ip || null,
          },
    errorCount: replay.count_errors ?? null,
    rageClickCount: replay.count_rage_clicks ?? null,
    deadClickCount: replay.count_dead_clicks ?? null,
    environment: replay.environment ?? null,
    browser: {
      name: replay.browser?.name ?? null,
      version: replay.browser?.version ?? null,
    },
    urls: replay.urls.slice(0, MAX_REPLAY_URLS),
    urlCount: replay.urls.length,
    releases: (replay.releases ?? []).slice(0, MAX_REPLAY_RELEASES),
    releaseCount: replay.releases?.length ?? 0,
    traceIds: replay.trace_ids.slice(0, MAX_REPLAY_TRACE_IDS),
    traceCount: replay.trace_ids.length,
    isArchived: replay.is_archived === true,
  }));

  return structuredResult({
    query: params.inputQuery,
    explanation:
      params.includeExplanation && params.explanation
        ? params.explanation
        : null,
    executedSearch: {
      query: params.replayQuery,
      sort: params.sort,
      environment: toEnvironmentList(params.environment),
      timeRange: {
        statsPeriod: params.timeRange?.statsPeriod ?? null,
        start: params.timeRange?.start ?? null,
        end: params.timeRange?.end ?? null,
      },
    },
    url: params.searchUrl,
    presentationHint: `${REPLAY_RESULTS_HINT} ${DASHBOARD_LINK_HINT}`,
    notes:
      replays.length === 0
        ? [
            ...params.notes,
            `No replays found matching your search criteria. ${REPLAY_EMPTY_HINT}`,
          ]
        : params.notes,
    replays,
    suggestedActions: buildReplayActions(replays, params),
  });
}

function buildReplayActions(
  replays: SearchReplaysStructuredContent["replays"],
  params: Pick<
    FormatReplayResultsParams,
    | "organizationSlug"
    | "experimentalMode"
    | "availableToolNames"
    | "directToolNames"
  >,
): SuggestedToolAction[] {
  const session = {
    experimentalMode: params.experimentalMode ?? false,
    availableToolNames: params.availableToolNames,
    directToolNames: params.directToolNames,
  };
  const firstReplay = replays[0];
  const traceId = replays.find((replay) => replay.traceIds[0])?.traceIds[0];
  const actions = [
    firstReplay
      ? buildSuggestedToolAction({
          toolName: "get_replay_details",
          arguments: { replayUrl: firstReplay.replayUrl },
          reason: "Inspect the first matching replay in more detail.",
          ...session,
        })
      : null,
    traceId
      ? buildSuggestedToolAction({
          toolName: "get_sentry_resource",
          arguments: {
            organizationSlug: params.organizationSlug,
            resourceType: "trace",
            resourceId: traceId,
          },
          reason: "Pivot from a replay into its first trace.",
          ...session,
        })
      : null,
  ];
  return actions.filter((action) => action !== null);
}

export function isValidReplaySort(sort: string): boolean {
  return REPLAY_SORT_VALUES.has(sort);
}

export function formatReplayResults(params: FormatReplayResultsParams): string {
  const {
    replays,
    inputQuery,
    includeExplanation,
    organizationSlug,
    apiService,
    searchUrl,
    replayQuery,
    sort,
    environment,
    explanation,
    timeRange,
  } = params;

  let output = `# Search Results for "${inputQuery}"\n\n`;
  output += formatSearchPresentationHint(REPLAY_RESULTS_HINT);

  if (includeExplanation) {
    output += "## Query Translation\n";
    output += `Input query: "${inputQuery}"\n`;
    output += `Replay query: \`${replayQuery || "(none)"}\`\n`;
    if (environment) {
      output += `Environment: ${formatReplayEnvironment(environment)}\n`;
    }
    output += `Sort: ${sort}\n`;
    output += `Time range: ${formatTimeRange(timeRange)}\n\n`;

    if (explanation) {
      output += `## How I interpreted your query\n\n${explanation}\n\n`;
    }
  }

  output += formatExecutedSearch(params.executedSearch);

  output += formatSentryDashboardLink(searchUrl);

  if (replays.length === 0) {
    output += "No replays found matching your search criteria.\n\n";
    output += REPLAY_EMPTY_HINT;
    return output;
  }

  output += `Found **${replays.length}** replay${replays.length === 1 ? "" : "s"}:\n\n`;

  replays.forEach((replay, index) => {
    const replayUrl = apiService.getReplayUrl(organizationSlug, replay.id);
    const user = formatReplayUser(replay);
    const clickSummary = [
      `${replay.count_errors ?? 0} error${replay.count_errors === 1 ? "" : "s"}`,
      `${replay.count_rage_clicks ?? 0} rage click${replay.count_rage_clicks === 1 ? "" : "s"}`,
      `${replay.count_dead_clicks ?? 0} dead click${replay.count_dead_clicks === 1 ? "" : "s"}`,
    ].join(" · ");

    output += `## ${index + 1}. [${replay.id}](${replayUrl})\n\n`;
    output += `- **Started**: ${formatTimestamp(replay.started_at)}\n`;
    output += `- **Duration**: ${formatDurationSeconds(replay.duration)}\n`;
    output += `- **User**: ${user}\n`;
    output += `- **Summary**: ${clickSummary}\n`;
    output += `- **Environment**: ${replay.environment ?? "Unknown"}\n`;
    output += `- **Browser**: ${formatNameVersion(replay.browser?.name, replay.browser?.version)}\n`;

    if (replay.urls.length > 0) {
      output += `- **Pages**: ${formatReplayUrls(replay.urls)}\n`;
    }
    if (replay.releases && replay.releases.length > 0) {
      output += `- **Release**: ${replay.releases[0]}\n`;
    }
    if (replay.trace_ids.length > 0) {
      output += `- **Trace**: \`${replay.trace_ids[0]}\`${replay.trace_ids.length > 1 ? ` (+${replay.trace_ids.length - 1} more)` : ""}\n`;
    }
    if (replay.is_archived) {
      output += "- **Status**: Archived\n";
    }

    output += "\n";
  });

  output += "## Next Steps\n\n";
  const replayDetailsInstruction = formatToolCallInstruction({
    toolName: "get_replay_details",
    arguments: { replayUrl: "<replay_url>" },
    experimentalMode: params.experimentalMode ?? false,
    availableToolNames: params.availableToolNames,
    directToolNames: params.directToolNames,
    fallbackInstruction:
      "Replay detail lookup is not available in this session",
    purpose: "to inspect a specific replay in more detail",
  });
  output += `- ${replayDetailsInstruction}\n`;
  output +=
    "- Pivot from a replay into related issues or traces: Open the replay link above, then use `get_sentry_resource` on related issue or trace URLs\n";

  return output;
}

export function formatReplayUser(replay: ReplayDetails): string {
  const name =
    replay.user?.display_name ??
    replay.user?.email ??
    replay.user?.username ??
    null;
  const id = replay.user?.id ?? null;
  // Keep the ID visible so results can be matched to a `user.id` search.
  if (name && id && name !== id) {
    return `${name} (id ${inlineCode(id)})`;
  }
  return name ?? id ?? "Anonymous User";
}

function formatReplayUrls(urls: string[]): string {
  const preview = urls.slice(0, 2).join(", ");
  if (urls.length <= 2) {
    return preview;
  }
  return `${preview} (+${urls.length - 2} more)`;
}

function formatDurationSeconds(durationSeconds?: number | null): string {
  if (durationSeconds == null) {
    return "Unknown";
  }
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

function formatTimestamp(value?: string | null): string {
  if (!value) {
    return "Unknown";
  }
  return value.replace("T", " ").replace("Z", " UTC");
}

function formatTimeRange(timeRange?: ReplayTimeRange): string {
  if (!timeRange) {
    return "Last 14 days";
  }
  if (timeRange.statsPeriod) {
    return `Last ${timeRange.statsPeriod}`;
  }
  if (timeRange.start && timeRange.end) {
    return `${formatTimestamp(timeRange.start)} to ${formatTimestamp(timeRange.end)}`;
  }
  return "Last 14 days";
}

function formatReplayEnvironment(environment: string | string[]): string {
  return Array.isArray(environment) ? environment.join(", ") : environment;
}
