/**
 * Log API functions
 *
 * Functions for listing and retrieving Sentry log entries,
 * including trace-associated logs.
 */

import { listOrganizationEvents } from "@sentry/api";
// biome-ignore lint/performance/noNamespaceImport: Sentry SDK recommends namespace import
import * as Sentry from "@sentry/node-core/light";
import { type GenericSchema, safeParse } from "valibot";

import {
  DetailedLogsResponseSchema,
  type DetailedSentryLog,
  LogsResponseSchema,
  type SentryLog,
  type TraceItemDetail,
  type TraceLog,
  TraceLogsResponseSchema,
} from "../../types/index.js";
import { ApiError } from "../errors.js";
import { resolveOrgRegion } from "../region.js";
import { LOG_RETENTION_PERIOD } from "../retention.js";
import { isAllDigits } from "../utils.js";
import {
  API_MAX_PER_PAGE,
  apiRequestToRegion,
  getOrgSdkConfig,
  paginate,
  parseLinkHeader,
  unwrapPaginatedResult,
  unwrapResult,
} from "./infrastructure.js";
import { getTraceItemDetail } from "./traces.js";

/** Sort direction for log queries: newest-first or oldest-first. */
export type LogSortDirection = "newest" | "oldest";

/** Map CLI sort direction to Sentry API sort parameter. */
function toApiSort(sort: LogSortDirection | undefined): string {
  return sort === "oldest" ? "timestamp" : "-timestamp";
}

/**
 * Resolve the numeric project ID to send via the `project` query param.
 *
 * Prefers an explicit `projectId` from the caller; otherwise falls back to the
 * slug when it is itself all-digits (a numeric project ID passed as the slug).
 * Returns `undefined` when neither yields a numeric ID, signalling that the
 * caller should scope via `project:<slug>` search syntax instead.
 */
function resolveNumericProjectId(
  projectSlug: string,
  projectId: number | undefined
): number | undefined {
  if (projectId !== undefined) {
    return projectId;
  }
  return isAllDigits(projectSlug) ? Number(projectSlug) : undefined;
}

/** Fields to request from the logs API */
const LOG_FIELDS = [
  "sentry.item_id",
  "trace",
  "severity",
  "timestamp",
  "timestamp_precise",
  "message",
];

/**
 * Validate that the API returned an object before attempting Zod parsing.
 * Self-hosted instances may return plain text or HTML when the logs dataset
 * is unsupported or a reverse proxy intercepts the request.
 */
function assertObjectResponse(data: unknown, context: string): void {
  if (typeof data !== "object" || data === null) {
    throw new ApiError(
      `${context}: unexpected response format`,
      0,
      `Expected an object but received ${data === null ? "null" : typeof data}. ` +
        "This may indicate an incompatible self-hosted Sentry version or a proxy interfering with the response."
    );
  }
}

/**
 * Safe-parse an API response with a valibot schema, throwing {@link ApiError}
 * on validation failure instead of leaking raw validation issues.
 */
function safeParseResponse<T>(
  schema: GenericSchema<unknown, T>,
  data: unknown,
  context: string
): T {
  assertObjectResponse(data, context);
  const result = safeParse(schema, data);
  if (!result.success) {
    // Strip valibot issues to metadata only (path/type/message) before
    // attaching to Sentry — full issues embed the raw failing `input` value.
    Sentry.setContext("schema_validation", {
      context,
      issues: result.issues.slice(0, 10).map((i) => ({
        // Strip raw input from path items — only keep structural path keys.
        path: i.path?.map((p) => ({ key: p.key, type: p.type })),
        type: i.type,
        message: i.message,
      })),
    });
    throw new ApiError(
      `${context}: unexpected response format`,
      0,
      result.issues.map((issue) => issue.message).join(", ")
    );
  }
  return result.output;
}

type ListLogsOptions = {
  /** Search query using Sentry query syntax */
  query?: string;
  /** Maximum number of log entries to return */
  limit?: number;
  /**
   * Time period for logs (e.g., "30d", "14d", "10m").
   * Defaults to "30d" — the maximum log retention period.
   * Periods >30d hit a degraded API path returning stale/incomplete data.
   */
  statsPeriod?: string;
  /** Sort direction: "newest" (default) or "oldest" */
  sort?: LogSortDirection;
  /** Only return logs after this timestamp_precise value (for streaming) */
  afterTimestamp?: number;
  /** Absolute start datetime (ISO-8601). Mutually exclusive with statsPeriod. */
  start?: string;
  /** Absolute end datetime (ISO-8601). Mutually exclusive with statsPeriod. */
  end?: string;
  /**
   * Additional fields to request from the ourlogs dataset.
   * These are merged with the default fields (duplicates removed)
   * and returned in the API response alongside standard fields.
   * Used by `--fields` to surface custom structured log attributes.
   */
  extraFields?: string[];
  /**
   * Numeric project ID. When provided, the request scopes to the project via
   * the `project` query param instead of `project:<slug>` search syntax.
   *
   * The `project:<slug>` filter only matches when that project is actively
   * selected in the org, so a plain slug can return empty `data: []` even when
   * the project has logs. Passing the numeric ID selects the project directly
   * and avoids that gap. Mirrors {@link listIssuesPaginated}.
   */
  projectId?: number;
};

/**
 * List logs for an organization/project.
 * Uses the Explore/Events API with dataset=logs.
 *
 * @param orgSlug - Organization slug
 * @param projectSlug - Project slug or numeric ID
 * @param options - Query options (query, limit, statsPeriod)
 * @returns Array of log entries
 */
export async function listLogs(
  orgSlug: string,
  projectSlug: string,
  options: ListLogsOptions = {}
): Promise<SentryLog[]> {
  const numericProjectId = resolveNumericProjectId(
    projectSlug,
    options.projectId
  );

  // Only fall back to `project:<slug>` search scoping when we have no numeric
  // ID — that filter requires the project to be actively selected, otherwise
  // the API returns empty results even when the project has logs.
  const projectFilter =
    numericProjectId === undefined ? `project:${projectSlug}` : "";
  const timestampFilter = options.afterTimestamp
    ? `timestamp_precise:>${options.afterTimestamp}`
    : "";

  const fullQuery = [projectFilter, options.query, timestampFilter]
    .filter(Boolean)
    .join(" ");

  const config = await getOrgSdkConfig(orgSlug);

  // Merge extra fields (from --fields) with the default set, deduplicating
  const fields = options.extraFields?.length
    ? [
        ...LOG_FIELDS,
        ...options.extraFields.filter((f) => !LOG_FIELDS.includes(f)),
      ]
    : LOG_FIELDS;

  const { data } = await paginate(
    options,
    async (perPage, cursor) => {
      const result = await listOrganizationEvents({
        ...config,
        path: { organization_id_or_slug: orgSlug },
        query: {
          dataset: "logs",
          field: fields,
          project:
            numericProjectId === undefined ? undefined : [numericProjectId],
          query: fullQuery || undefined,
          per_page: perPage,
          cursor,
          statsPeriod:
            options.start || options.end
              ? undefined
              : (options.statsPeriod ?? "30d"),
          start: options.start,
          end: options.end,
          sort: toApiSort(options.sort),
        } as Parameters<typeof listOrganizationEvents>[0]["query"],
      });

      const { data: raw, nextCursor } = unwrapPaginatedResult<unknown>(
        result,
        "Failed to list logs"
      );
      const logsResponse = safeParseResponse(
        LogsResponseSchema,
        raw,
        "Failed to list logs"
      );
      return { data: logsResponse.data, nextCursor };
    },
    API_MAX_PER_PAGE
  );

  return data;
}

/** All fields to request for detailed log view */
const DETAILED_LOG_FIELDS = [
  "sentry.item_id",
  "timestamp",
  "timestamp_precise",
  "message",
  "severity",
  "trace",
  "project",
  "environment",
  "release",
  "sdk.name",
  "sdk.version",
  "span_id",
  "code.function",
  "code.file.path",
  "code.line.number",
  "sentry.otel.kind",
  "sentry.otel.status_code",
  "sentry.otel.instrumentation_scope.name",
];

/**
 * Fetch a single batch of log entries by their item IDs.
 * Batch size must not exceed {@link API_MAX_PER_PAGE}.
 */
type GetLogsBatchOptions = {
  config: Awaited<ReturnType<typeof getOrgSdkConfig>>;
  extraFields?: string[];
  /** Numeric project ID for direct project selection. @see {@link ListLogsOptions.projectId} */
  projectId?: number;
};

async function getLogsBatch(
  orgSlug: string,
  projectSlug: string,
  batchIds: string[],
  { config, extraFields, projectId }: GetLogsBatchOptions
): Promise<DetailedSentryLog[]> {
  const numericProjectId = resolveNumericProjectId(projectSlug, projectId);

  // Scope by numeric ID when available; otherwise fall back to the
  // `project:<slug>` filter (which only matches actively-selected projects).
  const projectFilter =
    numericProjectId === undefined ? `project:${projectSlug} ` : "";
  const query = `${projectFilter}sentry.item_id:[${batchIds.join(",")}]`;

  const fields = extraFields?.length
    ? [
        ...DETAILED_LOG_FIELDS,
        ...extraFields.filter((f) => !DETAILED_LOG_FIELDS.includes(f)),
      ]
    : DETAILED_LOG_FIELDS;

  const result = await listOrganizationEvents({
    ...config,
    path: { organization_id_or_slug: orgSlug },
    query: {
      dataset: "logs",
      field: fields,
      project: numericProjectId === undefined ? undefined : [numericProjectId],
      query,
      per_page: batchIds.length,
      statsPeriod: LOG_RETENTION_PERIOD,
    },
  });

  const data = unwrapResult(result, "Failed to get log");
  const logsResponse = safeParseResponse(
    DetailedLogsResponseSchema,
    data,
    "Failed to get log"
  );
  return logsResponse.data;
}

/** Options for {@link getLogs}. */
type GetLogsOptions = {
  /** Additional fields to request beyond {@link DETAILED_LOG_FIELDS}. */
  extraFields?: string[];
  /**
   * Numeric project ID for direct project selection via the `project` query
   * param. @see {@link ListLogsOptions.projectId}
   */
  projectId?: number;
};

/**
 * Get one or more log entries by their item IDs.
 * Uses the Explore/Events API with dataset=logs and a filter query.
 * Bracket syntax (`sentry.item_id:[id1,id2,...]`) works for any count including one.
 *
 * When more than {@link API_MAX_PER_PAGE} IDs are requested, the fetch is
 * split into batches to avoid silent API truncation.
 *
 * @param orgSlug - Organization slug
 * @param projectSlug - Project slug for filtering
 * @param logIds - One or more sentry.item_id values to fetch
 * @param options - Optional extra fields and numeric project ID
 * @returns Array of matching detailed log entries (may be shorter than logIds if some weren't found)
 */
export async function getLogs(
  orgSlug: string,
  projectSlug: string,
  logIds: string[],
  options: GetLogsOptions = {}
): Promise<DetailedSentryLog[]> {
  const { extraFields, projectId } = options;
  const config = await getOrgSdkConfig(orgSlug);
  const batchOptions: GetLogsBatchOptions = { config, extraFields, projectId };

  // Single batch — no splitting needed
  if (logIds.length <= API_MAX_PER_PAGE) {
    return getLogsBatch(orgSlug, projectSlug, logIds, batchOptions);
  }

  // Split into batches of API_MAX_PER_PAGE and fetch in parallel
  const batches: string[][] = [];
  for (let i = 0; i < logIds.length; i += API_MAX_PER_PAGE) {
    batches.push(logIds.slice(i, i + API_MAX_PER_PAGE));
  }

  const results = await Promise.all(
    batches.map((batch) =>
      getLogsBatch(orgSlug, projectSlug, batch, batchOptions)
    )
  );

  return results.flat();
}

type ListTraceLogsOptions = {
  /** Additional search query to filter results (Sentry query syntax) */
  query?: string;
  /** Maximum number of log entries to return (max 9999) */
  limit?: number;
  /**
   * Time period to search in (e.g., "14d", "7d", "24h").
   * Required by the API — without it the response may be empty even when
   * logs exist for the trace. Defaults to "14d".
   */
  statsPeriod?: string;
  /** Sort direction: "newest" (default) or "oldest" */
  sort?: LogSortDirection;
  /** Absolute start datetime (ISO-8601). Mutually exclusive with statsPeriod. */
  start?: string;
  /** Absolute end datetime (ISO-8601). Mutually exclusive with statsPeriod. */
  end?: string;
};

/**
 * List logs associated with a specific trace.
 *
 * Uses the dedicated `/organizations/{org}/trace-logs/` endpoint, which is
 * org-scoped and automatically queries all projects in the org. This is
 * distinct from the Explore/Events logs endpoint (`/events/?dataset=logs`)
 * which does not support filtering by trace ID in query syntax.
 *
 * `statsPeriod` defaults to `"14d"`. Without a stats period the API may
 * return empty results even when logs exist for the trace.
 *
 * @param orgSlug - Organization slug
 * @param traceId - The 32-character hex trace ID
 * @param options - Optional query/limit/statsPeriod/sort overrides
 * @returns Array of trace log entries
 */
export async function listTraceLogs(
  orgSlug: string,
  traceId: string,
  options: ListTraceLogsOptions = {}
): Promise<TraceLog[]> {
  const regionUrl = await resolveOrgRegion(orgSlug);

  const { data } = await paginate(
    options,
    async (perPage, cursor) => {
      const { data: response, headers } = await apiRequestToRegion<{
        data: TraceLog[];
      }>(regionUrl, `/organizations/${orgSlug}/trace-logs/`, {
        params: {
          traceId,
          statsPeriod:
            options.start || options.end
              ? undefined
              : (options.statsPeriod ?? "14d"),
          start: options.start,
          end: options.end,
          per_page: perPage,
          cursor,
          query: options.query,
          sort: toApiSort(options.sort),
        },
        schema: TraceLogsResponseSchema,
      });

      const { nextCursor } = parseLinkHeader(headers.get("link") ?? null);
      return { data: response.data, nextCursor };
    },
    API_MAX_PER_PAGE
  );

  return data;
}

/**
 * Fetch all attributes for a single log entry via the trace-items detail endpoint.
 *
 * Returns every attribute on the log — standard and custom alike — without needing
 * to enumerate field names. This is the same endpoint the Sentry UI uses when
 * expanding a log row to show its full attribute set.
 *
 * The endpoint is EXPERIMENTAL and not yet in @sentry/api; called directly via
 * apiRequestToRegion following the same pattern as listTraceLogs.
 *
 * @param orgSlug - Organization slug
 * @param projectSlug - Project slug
 * @param logId - The sentry.item_id of the log entry
 * @param traceId - The trace ID (required by the endpoint)
 *
 * Uses the experimental /projects/{org}/{project}/trace-items/ endpoint directly via
 * apiRequestToRegion — it is not yet available in @sentry/api (generated from
 * getsentry/sentry-api-schema) because the endpoint is marked EXPERIMENTAL in Sentry.
 */
export function getLogItemDetail(
  orgSlug: string,
  projectSlug: string,
  logId: string,
  traceId: string
): Promise<TraceItemDetail> {
  return getTraceItemDetail(orgSlug, projectSlug, logId, {
    traceId,
    itemType: "logs",
  });
}
