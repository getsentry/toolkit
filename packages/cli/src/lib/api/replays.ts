/**
 * Replay API functions
 *
 * Functions for listing and retrieving Session Replays.
 */

import {
  getOrganizationReplay,
  getOrganizationReplayCount,
  type ListProjectReplayRecordingSegmentsResponse,
  listProjectReplayRecordingSegments,
} from "@sentry/api";
import { vListProjectReplayRecordingSegmentsResponse } from "@sentry/api/valibot";
import { type GenericSchema, safeParse } from "valibot";
import {
  REPLAY_LIST_FIELDS,
  type ReplayDetails,
  type ReplayDetailsResponse,
  ReplayDetailsResponseSchema,
  ReplayIdsByResourceSchema,
  type ReplayListItem,
  type ReplayListResponse,
  ReplayListResponseSchema,
  type ReplayStringProjectId,
} from "../../types/index.js";

import { ApiError } from "../errors.js";
import { logger } from "../logger.js";
import { resolveOrgRegion } from "../region.js";

import {
  API_MAX_PER_PAGE,
  apiRequestToRegion,
  getOrgSdkConfig,
  MAX_PAGINATION_PAGES,
  type PaginatedResponse,
  paginate,
  parseLinkHeader,
  unwrapPaginatedResult,
  unwrapValidatedResult,
} from "./infrastructure.js";

const log = logger.withTag("api.replays");

/** Replay sort field names supported by the backend replay index endpoint. */
export const REPLAY_SORT_FIELDS = [
  "activity",
  "browser",
  "browser.name",
  "browser.version",
  "count_dead_clicks",
  "count_errors",
  "count_infos",
  "count_rage_clicks",
  "count_screens",
  "count_urls",
  "count_warnings",
  "device.brand",
  "device.family",
  "device.model",
  "device.name",
  "dist",
  "duration",
  "finished_at",
  "os",
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

/** Sort values supported by the backend replay index endpoint. */
export type ReplaySortField = (typeof REPLAY_SORT_FIELDS)[number];
export type ReplaySortValue = ReplaySortField | `-${ReplaySortField}`;

const REPLAY_SORT_VALUES = new Set<string>([
  ...REPLAY_SORT_FIELDS,
  ...REPLAY_SORT_FIELDS.map((field) => `-${field}`),
]);

/** Return whether a sort string is supported by the replay index endpoint. */
export function isReplaySortValue(value: string): value is ReplaySortValue {
  return REPLAY_SORT_VALUES.has(value);
}

/** Options for {@link listReplays}. */
export type ListReplaysOptions = {
  /** Limit total rows returned across auto-paginated pages. */
  limit?: number;
  /** Structured replay query using Sentry search syntax. */
  query?: string;
  /** Optional environment filter(s). */
  environment?: string[];
  /** Response fields to request from the replay endpoint. */
  fields?: string[];
  /** Project slugs to filter by. */
  projectSlugs?: string[];
  /** Numeric project IDs. `"-1"` searches all projects. */
  project?: string;
  /** Sort expression for the replay index endpoint. */
  sort?: ReplaySortValue;
  /** Pagination cursor from a previous response. */
  cursor?: string;
  /** Relative time period (e.g. "7d", "24h"). Overrides start/end on the API. */
  statsPeriod?: string;
  /** Absolute start datetime (ISO-8601). Mutually exclusive with statsPeriod. */
  start?: string;
  /** Absolute end datetime (ISO-8601). Mutually exclusive with statsPeriod. */
  end?: string;
};

type FetchReplayPageOptions = {
  options: ListReplaysOptions;
  perPage: number;
  cursor?: string;
};

type FetchReplayRecordingSegmentsPageOptions = {
  orgSlug: string;
  projectSlugOrId: string;
  replayId: string;
  cursor?: string;
};

/**
 * Validate the generated replay recording response before formatter code trusts
 * its object boundary. The SDK invokes response validators outside its normal
 * error-result path, so convert Zod failures to the CLI's API error type here.
 */
// the SDK's responseValidator hook requires a Promise-returning function
async function validateReplayRecordingSegmentsResponse(
  data: unknown,
): Promise<void> {
  const result = safeParse(vListProjectReplayRecordingSegmentsResponse, data);
  if (!result.success) {
    throw new ApiError(
      "Unexpected replay recording segments response",
      0,
      result.issues.map((issue) => issue.message).join(", "),
    );
  }
}

/** Options for {@link getReplayRecordingSegments}. */
export type GetReplayRecordingSegmentsOptions = {
  /**
   * Soft stop hint: total segment count from replay metadata.
   *
   * Pagination stops as soon as this many segments have been fetched, even if
   * the API advertises another cursor. Because metadata can be slightly stale,
   * the result is NOT trimmed to this value — callers may receive more segments
   * than expected if the final page overshoots.
   *
   * Omit (or pass null/undefined) to fetch all pages up to MAX_PAGINATION_PAGES.
   */
  expectedSegments?: number | null;
};

/**
 * Coerce numeric project_id to string for consistent downstream handling.
 *
 * The replay API returns project_id as a number but the CLI and output
 * schemas normalize it to a string for uniform comparisons and display.
 */
function normalizeReplayProjectId<
  T extends { project_id?: string | number | null },
>(replay: T): T & ReplayStringProjectId {
  if (
    replay.project_id === null ||
    replay.project_id === undefined ||
    typeof replay.project_id === "string"
  ) {
    // Narrowing `project_id` doesn't narrow `T`.
    return replay as T & ReplayStringProjectId;
  }

  return {
    ...replay,
    project_id: String(replay.project_id),
  };
}

/**
 * Fetch a single page of replays from the organization replay index.
 *
 * Stays on the raw transport: the default fields include `info_ids` and
 * `warning_ids`, which `replay list --json` prints but the generated
 * `listOrganizationReplays` field enum leaves out.
 */
async function fetchReplayPage(
  regionUrl: string,
  orgSlug: string,
  page: FetchReplayPageOptions,
): Promise<PaginatedResponse<ReplayListItem[]>> {
  const { cursor, options, perPage } = page;
  const { data, headers } = await apiRequestToRegion(
    regionUrl,
    `/organizations/${orgSlug}/replays/`,
    {
      params: {
        cursor,
        environment: options.environment,
        field:
          options.fields && options.fields.length > 0
            ? options.fields
            : [...REPLAY_LIST_FIELDS],
        per_page: perPage,
        project: options.project,
        projectSlug: options.projectSlugs,
        query: options.query,
        sort: options.sort ?? "-started_at",
        statsPeriod:
          options.start || options.end
            ? undefined
            : (options.statsPeriod ?? "7d"),
        start: options.start,
        end: options.end,
      },
      schema: ReplayListResponseSchema as GenericSchema<
        unknown,
        ReplayListResponse
      >,
    },
  );

  const { nextCursor } = parseLinkHeader(headers.get("link") ?? null);
  return {
    data: data.data.map(normalizeReplayProjectId),
    nextCursor,
  };
}

/**
 * List replays for an organization, optionally filtered to one or more projects.
 *
 * Auto-paginates when `limit` exceeds the API's per-page cap.
 */
export async function listReplays(
  orgSlug: string,
  options: ListReplaysOptions = {},
): Promise<PaginatedResponse<ReplayListItem[]>> {
  const regionUrl = await resolveOrgRegion(orgSlug);
  return await paginate(
    options,
    (perPage, cursor) =>
      fetchReplayPage(regionUrl, orgSlug, { options, perPage, cursor }),
    25,
  );
}

/**
 * Fetch a single replay by ID.
 */
export async function getReplay(
  orgSlug: string,
  replayId: string,
): Promise<ReplayDetails> {
  const config = getOrgSdkConfig();
  const result = await getOrganizationReplay({
    ...config,
    path: { organization_id_or_slug: orgSlug, replay_id: replayId },
  });
  const data = unwrapValidatedResult(
    result,
    "Failed to get replay",
    ReplayDetailsResponseSchema as GenericSchema<
      unknown,
      ReplayDetailsResponse
    >,
    `/organizations/${orgSlug}/replays/${replayId}/`,
  );
  return normalizeReplayProjectId(data.data);
}

/**
 * Find the newest stored replay linked to a trace.
 *
 * Queries the replay index with `trace:{id}` over 90d, so only replays that
 * were actually stored match. Org-wide searches send `project=-1` because
 * omitting the project filter returns empty on large organizations.
 */
export async function findTraceReplay(
  orgSlug: string,
  traceId: string,
  options: Pick<ListReplaysOptions, "projectSlugs"> = {},
): Promise<ReplayListItem | undefined> {
  const { data } = await listReplays(orgSlug, {
    query: `trace:${traceId}`,
    statsPeriod: "90d",
    limit: 1,
    projectSlugs: options.projectSlugs,
    project: options.projectSlugs?.length ? undefined : "-1",
  });
  return data[0];
}

/**
 * Fetch a replay by replay ID, or by a trace ID linked on that replay.
 *
 * `GET /replays/{id}/` only matches replay primary keys. If that 404s, load
 * the newest replay linked to the ID as a trace ({@link findTraceReplay}).
 */
export async function resolveReplay(
  orgSlug: string,
  replayOrTraceId: string,
  options: Pick<ListReplaysOptions, "projectSlugs"> = {},
): Promise<ReplayDetails> {
  try {
    return await getReplay(orgSlug, replayOrTraceId);
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) {
      throw error;
    }

    log.debug(
      `Replay ${replayOrTraceId} not found by id; searching by linked trace`,
    );
    const match = await findTraceReplay(orgSlug, replayOrTraceId, options);
    if (!match) {
      throw error;
    }
    return await getReplay(orgSlug, match.id);
  }
}

/**
 * Fetch replay recording segments for a single replay.
 *
 * Uses the project-scoped replay endpoint because recording segments are
 * partitioned by project.
 *
 * Uses a manual pagination loop rather than {@link autoPaginate} because
 * `autoPaginate` trims results to `limit`, but `expectedSegments` is a soft
 * hint — trimming could silently drop real segments if metadata is stale.
 */
export async function getReplayRecordingSegments(
  orgSlug: string,
  projectSlugOrId: string,
  replayId: string,
  options: GetReplayRecordingSegmentsOptions = {},
): Promise<ListProjectReplayRecordingSegmentsResponse> {
  const expectedSegments = options.expectedSegments ?? Number.POSITIVE_INFINITY;
  const segments: ListProjectReplayRecordingSegmentsResponse = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGINATION_PAGES; page += 1) {
    const { data, nextCursor } = await fetchReplayRecordingSegmentsPage({
      orgSlug,
      projectSlugOrId,
      replayId,
      cursor,
    });

    segments.push(...data);

    if (segments.length >= expectedSegments || !nextCursor) {
      return segments;
    }

    cursor = nextCursor;
  }

  log.warn(
    `Pagination limit reached (${MAX_PAGINATION_PAGES} pages, ${segments.length} segments). ` +
      "The recording may be incomplete.",
  );
  return segments;
}

/**
 * Fetch one SDK-backed recording page while preserving its cursor metadata.
 */
async function fetchReplayRecordingSegmentsPage(
  options: FetchReplayRecordingSegmentsPageOptions,
): Promise<PaginatedResponse<ListProjectReplayRecordingSegmentsResponse>> {
  const { cursor, orgSlug, projectSlugOrId, replayId } = options;
  const config = getOrgSdkConfig();
  const result = await listProjectReplayRecordingSegments({
    ...config,
    path: {
      organization_id_or_slug: orgSlug,
      project_id_or_slug: projectSlugOrId,
      replay_id: replayId,
    },
    // No `download=true`: the endpoint always streams the event payloads
    // (`on_results=download_segments`) and never reads that parameter. The
    // web UI sends it, but the backend ignores it.
    query: {
      cursor,
      per_page: API_MAX_PER_PAGE,
    },
    responseValidator: validateReplayRecordingSegmentsResponse,
  });

  return unwrapPaginatedResult<ListProjectReplayRecordingSegmentsResponse>(
    result,
    "Failed to fetch replay recording segments",
  );
}

/**
 * List replay IDs related to a single issue.
 */
export async function listReplayIdsForIssue(
  orgSlug: string,
  issueId: string | number,
): Promise<string[]> {
  const normalizedIssueId = String(issueId);
  const result = await getOrganizationReplayCount({
    ...getOrgSdkConfig(),
    path: { organization_id_or_slug: orgSlug },
    query: {
      data_source: "errors",
      project: [-1],
      query: `issue.id:[${normalizedIssueId}]`,
      returnIds: true,
      statsPeriod: "90d",
    },
  });
  // With `returnIds`, the endpoint maps each issue to replay IDs instead of
  // the counts its documented response describes.
  const data = unwrapValidatedResult(
    result,
    "Failed to list replays for issue",
    ReplayIdsByResourceSchema,
    `/organizations/${orgSlug}/replay-count/`,
  );

  return data[normalizedIssueId] ?? [];
}
