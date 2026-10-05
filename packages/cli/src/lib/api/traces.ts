/**
 * Trace, Transaction, and Span API functions
 *
 * Functions for retrieving detailed traces, listing transactions, and listing spans.
 */

import pLimit from "p-limit";

import {
  type SpanListItem,
  type SpansResponse,
  SpansResponseSchema,
  type TraceItemDetail,
  TraceItemDetailSchema,
  type TraceMeta,
  TraceMetaSchema,
  type TraceSpan,
  type TransactionListItem,
  type TransactionsResponse,
  TransactionsResponseSchema,
} from "../../types/index.js";

// Re-export so existing callers (api-client.ts, formatters/trace.ts) don't need to change.
export type { TraceItemAttribute, TraceItemDetail } from "../../types/index.js";

import { logger } from "../logger.js";
import { resolveOrgRegion } from "../region.js";
import { isAllDigits } from "../utils.js";

import {
  API_MAX_PER_PAGE,
  apiRequestToRegion,
  type PaginatedResponse,
  paginate,
  parseLinkHeader,
} from "./infrastructure.js";

const log = logger.withTag("api.traces");

// ---------------------------------------------------------------------------
// Trace item (span) detail types
// ---------------------------------------------------------------------------

/**
 * Attribute names from the trace-items detail endpoint that duplicate
 * fields already shown in the standard span output (KV table, JSON core
 * fields) or are EAP storage internals with no diagnostic value.
 *
 * Shared between `span view` (JSON `data` dict) and `formatSpanDetails`
 * (human KV rows) to keep filtering consistent.
 */
export const REDUNDANT_DETAIL_ATTRS = new Set([
  // Timing / storage internals
  "precise.start_ts",
  "precise.finish_ts",
  "received",
  "hash",
  "project_id",
  "client_sample_rate",
  "server_sample_rate",
  // Already shown in standard span fields
  "is_transaction",
  "span.duration",
  "span.self_time",
  "span.op",
  "span.name",
  "span.description",
  "span.category",
  "parent_span",
  "transaction",
  "transaction.op",
  "transaction.event_id",
  "transaction.span_id",
  "trace",
  "trace.status",
  "segment.name",
  "origin",
  "platform",
  "sdk.name",
  "sdk.version",
  "environment",
]);

// TraceItemAttribute and TraceItemDetail are defined with Zod schemas in
// src/types/sentry.ts and re-exported via the types barrel (src/types/index.ts).
// They are also re-exported from this module (see top of file) for callers
// that already import from traces.ts.

/**
 * First lookup window when the event time is unknown.
 * Matches the Sentry UI `DEFAULT_STATS_PERIOD`.
 */
export const TRACE_LOOKUP_STATS_PERIOD = "14d";

/**
 * Widened window if the first lookup returns no spans.
 * Matches the Sentry UI `maxPickableDays` fallback (90 days).
 */
export const TRACE_LOOKUP_FALLBACK_STATS_PERIOD = "90d";

/** Options for {@link getDetailedTrace}. */
type GetDetailedTraceOptions = {
  /** Extra attribute names to include on each span */
  additionalAttributes?: string[];
  /** Numeric project ID to filter spans. Omit or -1 for all projects. */
  projectId?: number;
  /**
   * Unix timestamp (seconds) of a known event in this trace.
   * The backend then searches ±1.5 days around it and does not widen.
   * Pass this only when the event time is known (e.g. `dateCreated`) —
   * never `Date.now()`.
   */
  timestamp?: number;
};

async function requestTrace(
  regionUrl: string,
  orgSlug: string,
  traceId: string,
  params: GetDetailedTraceOptions & { statsPeriod?: string }
): Promise<TraceSpan[]> {
  const { data } = await apiRequestToRegion<TraceSpan[]>(
    regionUrl,
    `/organizations/${orgSlug}/trace/${traceId}/`,
    {
      params: {
        timestamp: params.timestamp,
        statsPeriod: params.statsPeriod,
        limit: 10_000,
        project: params.projectId ?? -1,
        additional_attributes: params.additionalAttributes,
      },
    }
  );
  return data.map(normalizeTraceSpan);
}

/**
 * Get detailed trace with nested children structure.
 * This is an internal endpoint not covered by the public API.
 * Uses region-aware routing for multi-region support.
 *
 * When `projectId` is provided, the API returns only spans belonging to that
 * project. Pass `-1` (or omit) to fetch spans from all projects.
 *
 * Time window (matches the Sentry UI):
 * - Known event `timestamp` → one query around that instant (no retry).
 * - Unknown time → `statsPeriod=14d`, then `90d` if the first response is empty.
 *
 * @param orgSlug - Organization slug
 * @param traceId - The trace ID (from event.contexts.trace.trace_id)
 * @param options - Optional timestamp, additional attributes, and project filter
 * @returns Array of root spans with nested children
 */
export async function getDetailedTrace(
  orgSlug: string,
  traceId: string,
  options: GetDetailedTraceOptions = {}
): Promise<TraceSpan[]> {
  const regionUrl = await resolveOrgRegion(orgSlug);
  const shared = {
    additionalAttributes: options.additionalAttributes,
    projectId: options.projectId,
  };
  const timestamp =
    options.timestamp !== undefined && Number.isFinite(options.timestamp)
      ? options.timestamp
      : undefined;

  if (timestamp !== undefined) {
    return requestTrace(regionUrl, orgSlug, traceId, { ...shared, timestamp });
  }

  const spans = await requestTrace(regionUrl, orgSlug, traceId, {
    ...shared,
    statsPeriod: TRACE_LOOKUP_STATS_PERIOD,
  });
  if (spans.length > 0) {
    return spans;
  }

  log.debug(
    `No spans for trace ${traceId} in ${TRACE_LOOKUP_STATS_PERIOD}; retrying ${TRACE_LOOKUP_FALLBACK_STATS_PERIOD}`
  );
  return requestTrace(regionUrl, orgSlug, traceId, {
    ...shared,
    statsPeriod: TRACE_LOOKUP_FALLBACK_STATS_PERIOD,
  });
}

type GetTraceItemDetailOptions = {
  traceId: string;
  itemType: "spans" | "logs";
};

/**
 * Fetch full attribute details for a single trace item via the experimental
 * /projects/{org}/{project}/trace-items/{itemId}/ endpoint.
 *
 * This endpoint is not yet in @sentry/api (getsentry/sentry-api-schema) because
 * it is marked EXPERIMENTAL in Sentry. Both span and log detail views use it.
 *
 * @param orgSlug - Organization slug
 * @param projectSlug - Project slug
 * @param itemId - The item ID (span ID or log sentry.item_id)
 * @param options - traceId (required by endpoint) and itemType ("spans" | "logs")
 */
export async function getTraceItemDetail(
  orgSlug: string,
  projectSlug: string,
  itemId: string,
  { traceId, itemType }: GetTraceItemDetailOptions
): Promise<TraceItemDetail> {
  const regionUrl = await resolveOrgRegion(orgSlug);
  const { data } = await apiRequestToRegion<TraceItemDetail>(
    regionUrl,
    `/projects/${orgSlug}/${projectSlug}/trace-items/${itemId}/`,
    {
      params: { trace_id: traceId, item_type: itemType },
      schema: TraceItemDetailSchema,
    }
  );
  return data;
}

/**
 * Fetch full attribute details for a single span.
 *
 * @param orgSlug - Organization slug
 * @param projectSlug - Project slug
 * @param spanId - The 16-char hex span ID
 * @param traceId - The parent trace ID (required for lookup)
 */
export function getSpanDetails(
  orgSlug: string,
  projectSlug: string,
  spanId: string,
  traceId: string
): Promise<TraceItemDetail> {
  return getTraceItemDetail(orgSlug, projectSlug, spanId, {
    traceId,
    itemType: "spans",
  });
}

/**
 * Fetch high-level metadata for a trace.
 *
 * Uses the org-scoped trace-meta endpoint to retrieve counts for spans, errors,
 * logs, and performance issues. This is useful for lightweight trace
 * references without fetching the full trace tree.
 */
export async function getTraceMeta(
  orgSlug: string,
  traceId: string,
  statsPeriod = "14d"
): Promise<TraceMeta> {
  const regionUrl = await resolveOrgRegion(orgSlug);

  const { data } = await apiRequestToRegion<TraceMeta>(
    regionUrl,
    `/organizations/${orgSlug}/trace-meta/${traceId}/`,
    {
      params: { statsPeriod },
      schema: TraceMetaSchema,
    }
  );
  return data;
}

// ---------------------------------------------------------------------------
// Shared span detail helpers
// ---------------------------------------------------------------------------

/** Concurrency for parallel detail fetches (shared between trace/span view) */
const SPAN_DETAIL_CONCURRENCY = 15;

/**
 * Convert a trace-items attribute array into a key-value dict,
 * filtering out attributes already shown in the standard span fields
 * and EAP storage internals (tags[], precise timestamps, etc.).
 */
export function attributesToDict(
  attributes: TraceItemDetail["attributes"]
): Record<string, unknown> {
  return Object.fromEntries(
    attributes
      .filter(
        (a) =>
          !(REDUNDANT_DETAIL_ATTRS.has(a.name) || a.name.startsWith("tags["))
      )
      .map((a) => [a.name, a.value])
  );
}

/** Options for {@link fetchMultiSpanDetails} */
export type FetchMultiSpanDetailsOptions = {
  /** Organization slug */
  org: string;
  /** Project slug to use when a span has no project_slug */
  fallbackProject: string;
  /** The parent trace ID (required by the API) */
  traceId: string;
  /** Callback fired after each successful fetch for progress reporting */
  onProgress?: (done: number, total: number) => void;
};

/**
 * Fetch full attribute details for multiple spans in parallel.
 *
 * Uses p-limit to cap concurrency at {@link SPAN_DETAIL_CONCURRENCY}.
 * Failures for individual spans are logged as warnings — callers
 * still get partial results for the spans that succeeded.
 *
 * @param spans - Spans to fetch details for (must have span_id and optionally project_slug)
 * @param options - Org, project, traceId, and optional progress callback
 * @returns Map of span_id to detail
 */
export async function fetchMultiSpanDetails(
  spans: Array<{ span_id: string; project_slug?: string }>,
  options: FetchMultiSpanDetailsOptions
): Promise<Map<string, TraceItemDetail>> {
  const { org, fallbackProject, traceId, onProgress } = options;
  const limit = pLimit(SPAN_DETAIL_CONCURRENCY);
  const details = new Map<string, TraceItemDetail>();
  let completed = 0;
  const total = spans.length;

  await limit.map(spans, async (span) => {
    const projectSlug = span.project_slug || fallbackProject;
    // Without a project slug the detail URL would be malformed
    // (/projects/{org}//trace-items/...). Skip rather than issue a
    // request that is guaranteed to fail. Happens for org-scoped
    // targets where neither the span nor the fallback has a project.
    if (!projectSlug) {
      log.debug(
        `Skipping detail fetch for span ${span.span_id}: no project slug available`
      );
      completed += 1;
      onProgress?.(completed, total);
      return;
    }
    try {
      const detail = await getSpanDetails(
        org,
        projectSlug,
        span.span_id,
        traceId
      );
      details.set(span.span_id, detail);
    } catch {
      log.warn(`Could not fetch details for span ${span.span_id}`);
    }
    completed += 1;
    onProgress?.(completed, total);
  });

  return details;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * The trace detail API (`/trace/{id}/`) returns each span's unique identifier
 * as `event_id` rather than `span_id`. The value is the same 16-hex-char span
 * ID that `parent_span_id` references on child spans. We copy it to `span_id`
 * so the rest of the codebase can use a single, predictable field name.
 */
export function normalizeTraceSpan(span: TraceSpan): TraceSpan {
  const normalized = { ...span };
  if (!normalized.span_id && normalized.event_id) {
    normalized.span_id = normalized.event_id;
  }
  if (normalized.children) {
    normalized.children = normalized.children.map(normalizeTraceSpan);
  }
  return normalized;
}

/** Fields to request when listing transactions (root spans) from the spans dataset */
const TRANSACTION_FIELDS = [
  "trace",
  "id",
  "transaction",
  "timestamp",
  "span.duration",
  "project",
];

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

type ListTransactionsOptions = {
  /** Search query using Sentry query syntax */
  query?: string;
  /** Maximum number of transactions to return */
  limit?: number;
  /** Sort order: "date" (newest first) or "duration" (slowest first) */
  sort?: "date" | "duration";
  /** Time period for transactions (e.g., "7d", "24h") */
  statsPeriod?: string;
  /** Pagination cursor to resume from a previous page */
  cursor?: string;
  /** Absolute start datetime (ISO-8601). Mutually exclusive with statsPeriod. */
  start?: string;
  /** Absolute end datetime (ISO-8601). Mutually exclusive with statsPeriod. */
  end?: string;
  /**
   * Numeric project ID. When provided, uses the `project` query param instead
   * of `project:<slug>` search syntax, avoiding "not actively selected" errors
   * (same class of bug as #1317 / #312).
   */
  projectId?: number;
};

/**
 * Fetch a single page of transactions from the Explore/Events endpoint.
 *
 * Internal helper used by {@link listTransactions} for both single-page and
 * multi-page (auto-paginating) fetches.
 */
// biome-ignore lint/nursery/useMaxParams: internal helper mirrors the public API surface
async function fetchTransactionsPage(
  regionUrl: string,
  orgSlug: string,
  projectSlug: string,
  options: ListTransactionsOptions,
  perPage: number
): Promise<PaginatedResponse<TransactionListItem[]>> {
  // Prefer the numeric `project=` param — `project:<slug>` in the search query
  // only matches projects that are actively selected (#1317).
  const numericProjectId = resolveNumericProjectId(
    projectSlug,
    options.projectId
  );
  const projectFilter =
    numericProjectId === undefined ? `project:${projectSlug}` : "";
  const fullQuery = ["is_transaction:true", projectFilter, options.query]
    .filter(Boolean)
    .join(" ");

  const { data: response, headers } =
    await apiRequestToRegion<TransactionsResponse>(
      regionUrl,
      `/organizations/${orgSlug}/events/`,
      {
        params: {
          dataset: "spans",
          field: TRANSACTION_FIELDS,
          project:
            numericProjectId === undefined
              ? undefined
              : String(numericProjectId),
          // Convert empty string to undefined so ky omits the param entirely;
          // sending `query=` causes the Sentry API to behave differently than
          // omitting the parameter.
          query: fullQuery || undefined,
          per_page: perPage,
          statsPeriod:
            options.start || options.end
              ? undefined
              : (options.statsPeriod ?? "7d"),
          start: options.start,
          end: options.end,
          sort: options.sort === "duration" ? "-span.duration" : "-timestamp",
          cursor: options.cursor,
        },
        schema: TransactionsResponseSchema,
      }
    );

  const { nextCursor } = parseLinkHeader(headers.get("link") ?? null);
  return { data: response.data, nextCursor };
}

/**
 * List recent transactions for a project.
 * Uses the Explore/Events API with dataset=spans and an `is_transaction:true`
 * filter — transactions are root spans in EAP storage.
 *
 * Handles project slug vs numeric ID automatically:
 * - Numeric IDs (or `options.projectId`) are passed as the `project` parameter
 * - Slugs fall back to `project:{slug}` in the query string when no ID is known
 *
 * When `limit` exceeds {@link API_MAX_PER_PAGE}, transparently fetches multiple
 * pages using cursor-based pagination (bounded by {@link MAX_PAGINATION_PAGES}).
 *
 * @param orgSlug - Organization slug
 * @param projectSlug - Project slug or numeric ID
 * @param options - Query options (query, limit, sort, statsPeriod, cursor)
 * @returns Paginated response with transaction items and optional next cursor
 */
export async function listTransactions(
  orgSlug: string,
  projectSlug: string,
  options: ListTransactionsOptions = {}
): Promise<PaginatedResponse<TransactionListItem[]>> {
  const regionUrl = await resolveOrgRegion(orgSlug);
  return paginate(options, (perPage, cursor) =>
    fetchTransactionsPage(
      regionUrl,
      orgSlug,
      projectSlug,
      { ...options, cursor },
      perPage
    )
  );
}

// Span listing

/** Fields to request from the spans API */
const SPAN_FIELDS = [
  "id",
  "parent_span",
  "span.op",
  "description",
  "span.duration",
  "timestamp",
  "project",
  "transaction",
  "trace",
];

/** Sort values for span listing: newest first or slowest first */
export type SpanSortValue = "date" | "duration";

type ListSpansOptions = {
  /** Search query using Sentry query syntax */
  query?: string;
  /** Maximum number of spans to return */
  limit?: number;
  /** Sort order */
  sort?: SpanSortValue;
  /** Time period for spans (e.g., "7d", "24h") */
  statsPeriod?: string;
  /** Pagination cursor to resume from a previous page */
  cursor?: string;
  /** Additional field names to request from the API beyond SPAN_FIELDS */
  extraFields?: string[];
  /** Absolute start datetime (ISO-8601). Mutually exclusive with statsPeriod. */
  start?: string;
  /** Absolute end datetime (ISO-8601). Mutually exclusive with statsPeriod. */
  end?: string;
  /** When true, search across all projects (sends project=-1). Used for trace mode. */
  allProjects?: boolean;
  /**
   * Numeric project ID. When provided (and not `allProjects`), uses the
   * `project` query param instead of `project:<slug>` search syntax, avoiding
   * "not actively selected" errors (same class of bug as #1317 / #312).
   */
  projectId?: number;
};

/**
 * Fetch a single page of spans from the Explore/Events endpoint.
 *
 * Internal helper used by {@link listSpans} for both single-page and
 * multi-page (auto-paginating) fetches.
 */
// biome-ignore lint/nursery/useMaxParams: internal helper mirrors the public API surface
async function fetchSpansPage(
  regionUrl: string,
  orgSlug: string,
  projectSlug: string,
  options: ListSpansOptions,
  perPage: number
): Promise<PaginatedResponse<SpanListItem[]>> {
  // Prefer the numeric `project=` param — `project:<slug>` in the search query
  // only matches projects that are actively selected (#1317).
  const numericProjectId = options.allProjects
    ? undefined
    : resolveNumericProjectId(projectSlug, options.projectId);
  const projectFilter =
    options.allProjects || numericProjectId !== undefined
      ? ""
      : `project:${projectSlug}`;
  const fullQuery = [projectFilter, options.query].filter(Boolean).join(" ");

  const fields = options.extraFields?.length
    ? SPAN_FIELDS.concat(options.extraFields)
    : SPAN_FIELDS;

  let projectParam: string | undefined;
  if (options.allProjects) {
    projectParam = "-1";
  } else if (numericProjectId !== undefined) {
    projectParam = String(numericProjectId);
  }

  const { data: response, headers } = await apiRequestToRegion<SpansResponse>(
    regionUrl,
    `/organizations/${orgSlug}/events/`,
    {
      params: {
        dataset: "spans",
        field: fields,
        project: projectParam,
        query: fullQuery || undefined,
        per_page: perPage,
        statsPeriod:
          options.start || options.end
            ? undefined
            : (options.statsPeriod ?? "7d"),
        start: options.start,
        end: options.end,
        sort: options.sort === "duration" ? "-span.duration" : "-timestamp",
        cursor: options.cursor,
      },
      schema: SpansResponseSchema,
    }
  );

  const { nextCursor } = parseLinkHeader(headers.get("link") ?? null);
  return { data: response.data, nextCursor };
}

/**
 * List spans using the EAP spans search endpoint.
 * Uses the Explore/Events API with dataset=spans.
 *
 * When `limit` exceeds {@link API_MAX_PER_PAGE}, transparently fetches multiple
 * pages using cursor-based pagination (bounded by {@link MAX_PAGINATION_PAGES}).
 *
 * @param orgSlug - Organization slug
 * @param projectSlug - Project slug or numeric ID
 * @param options - Query options (query, limit, sort, statsPeriod, cursor)
 * @returns Paginated response with span items and optional next cursor
 */
export async function listSpans(
  orgSlug: string,
  projectSlug: string,
  options: ListSpansOptions = {}
): Promise<PaginatedResponse<SpanListItem[]>> {
  const regionUrl = await resolveOrgRegion(orgSlug);
  return paginate(options, (perPage, cursor) =>
    fetchSpansPage(
      regionUrl,
      orgSlug,
      projectSlug,
      { ...options, cursor },
      perPage
    )
  );
}
