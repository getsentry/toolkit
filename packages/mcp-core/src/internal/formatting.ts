/**
 * LLM response formatting utilities for Sentry data.
 *
 * Converts Sentry API responses into structured markdown format optimized
 * for LLM consumption. Handles stacktraces, event details, issue summaries,
 * and contextual information with consistent formatting patterns.
 */
import type { IssueEventDetailsResponse } from "@sentry/api";
import type { z } from "zod";
import { ThreadsEntrySchema } from "../api-client";
import type {
  CommitterList,
  Event,
  GenericEvent,
  Issue,
  Trace,
  TraceSpan,
} from "../api-client/types";
import { logIssue } from "../telem/logging";
import { formatUnknown } from "./unknown-formatting";
import { isPlainObject } from "./type-guards";

/**
 * Convert Seer fixability score to actionability label.
 * Thresholds match Sentry core: src/sentry/seer/autofix/constants.py
 */
export function getSeerActionabilityLabel(score: number): string {
  if (score > 0.76) return "super_high";
  if (score > 0.66) return "high";
  if (score > 0.4) return "medium";
  if (score > 0.25) return "low";
  return "super_low";
}

/**
 * Whether to read the issue's metadata instead of its top level fields. Performance issues can
 * have various categories such as 'db_query', but the issueType starts with 'performance_'.
 *
 * It matters which side of this an issue falls on: metadata.value is a query pattern for a
 * performance issue and the exception message for an error, so reading it unconditionally
 * misnames the error text.
 */
export function isPerformanceIssueType(issue: {
  issueType?: string | null;
  issueCategory?: string | null;
}): boolean {
  return (
    issue.issueType?.startsWith("performance_") === true ||
    issue.issueCategory === "performance"
  );
}

/** Whether this server can render the event type; anything else arrives as an UnknownEvent. */
export function isSupportedEventType(event: { type?: unknown }): boolean {
  return (
    event.type === "error" ||
    event.type === "default" ||
    event.type === "transaction" ||
    event.type === "generic" ||
    event.type === "csp"
  );
}

export function parseThreadsEntryData(
  data: unknown,
): z.infer<typeof ThreadsEntrySchema> | undefined {
  const result = ThreadsEntrySchema.safeParse(data);
  return result.success ? result.data : undefined;
}

/**
 * Constants for performance issue formatting
 */
const MAX_SPANS_IN_TREE = 10;

/**
 * Safely parse a number from a string, returning a default if invalid
 */
export function safeParseInt(value: unknown, defaultValue: number): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? defaultValue : parsed;
  }
  return defaultValue;
}

/**
 * Simplified span structure for rendering span trees in performance issues.
 * This is a subset of the full span data focused on visualization needs.
 */
export interface PerformanceSpan {
  span_id: string | null;
  op: string | null; // Operation type (e.g., "db.query", "http.client")
  description: string | null; // Human-readable description of what the span did
  duration: number | null; // Duration in milliseconds, null when not recorded
  is_n1_query: boolean; // Whether this span is part of the N+1 pattern
  children: PerformanceSpan[];
  level: number; // Nesting level for tree rendering
}

interface RawSpan {
  span_id?: string;
  id?: string;
  op?: string;
  description?: string;
  timestamp?: number;
  start_timestamp?: number;
  duration?: number;
}

export interface N1EvidenceData {
  parentSpan?: string;
  parentSpanIds?: string[];
  repeatingSpansCompact?: string[];
  repeatingSpans?: string[];
  numberRepeatingSpans?: string; // API returns string even though it's a number
  numPatternRepetitions?: number;
  offenderSpanIds?: string[];
  transactionName?: string;
  [key: string]: unknown;
}

function normalizeSpanId(value: unknown): string | undefined {
  if (typeof value === "string" && value) {
    return value;
  }
  return undefined;
}

function getSpanIdentifier(span: RawSpan): string | undefined {
  if (span.span_id !== undefined) {
    return normalizeSpanId(span.span_id);
  }
  if (span.id !== undefined) {
    return normalizeSpanId(span.id);
  }
  return undefined;
}

function getSpanDurationMs(span: RawSpan): number | null {
  if (
    typeof span.timestamp === "number" &&
    typeof span.start_timestamp === "number"
  ) {
    const deltaSeconds = span.timestamp - span.start_timestamp;
    if (Number.isFinite(deltaSeconds) && deltaSeconds >= 0) {
      return deltaSeconds * 1000;
    }
  }

  // Trace APIs expose `duration` in milliseconds. Preserve fractional values.
  if (typeof span.duration === "number" && Number.isFinite(span.duration)) {
    return span.duration >= 0 ? span.duration : null;
  }

  return null;
}

function normalizeIdArray(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => normalizeSpanId(value))
    .filter((value): value is string => value !== undefined);
}

function isValidSpanArray(value: unknown): value is RawSpan[] {
  return Array.isArray(value);
}

/**
 * Get the repeating span descriptions from evidence data.
 * Prefers repeatingSpansCompact (more concise) over repeatingSpans (verbose).
 */
export function getRepeatingSpanLines(evidenceData: N1EvidenceData): string[] {
  // Try compact version first (preferred for display)
  if (
    Array.isArray(evidenceData.repeatingSpansCompact) &&
    evidenceData.repeatingSpansCompact.length > 0
  ) {
    return evidenceData.repeatingSpansCompact
      .map((s) => (typeof s === "string" ? s.trim() : ""))
      .filter((s): s is string => s.length > 0);
  }

  // Fall back to full version
  if (
    Array.isArray(evidenceData.repeatingSpans) &&
    evidenceData.repeatingSpans.length > 0
  ) {
    return evidenceData.repeatingSpans
      .map((s) => (typeof s === "string" ? s.trim() : ""))
      .filter((s): s is string => s.length > 0);
  }

  return [];
}

function isTraceSpan(node: unknown): node is TraceSpan {
  if (node === null || typeof node !== "object") {
    return false;
  }
  const candidate = node as { event_type?: unknown; event_id?: unknown };
  // Trace API returns spans with event_type: "span"
  return (
    candidate.event_type === "span" && typeof candidate.event_id === "string"
  );
}

function selectTraceSpanRoots(
  trace: Trace,
  parentSpanIds: string[],
  offenderSpanIds: string[],
  maxSpans: number,
): PerformanceSpan[] {
  const offenderSet = new Set(offenderSpanIds);
  const spanMap = new Map<string, TraceSpan>();

  function indexSpan(span: TraceSpan): void {
    // Try to get span_id from additional_attributes, fall back to event_id
    const spanId =
      normalizeSpanId(span.additional_attributes?.span_id) || span.event_id;
    if (spanId && spanId.length > 0) {
      spanMap.set(spanId, span);
    }
    for (const child of span.children) {
      if (isTraceSpan(child)) {
        indexSpan(child);
      }
    }
  }

  for (const node of trace) {
    if (isTraceSpan(node)) {
      indexSpan(node);
    }
  }

  const roots: PerformanceSpan[] = [];
  const budget = { count: 0, limit: maxSpans };

  // First, try to find parent spans
  for (const parentId of parentSpanIds) {
    const span = spanMap.get(parentId);
    if (!span) {
      continue;
    }
    const perfSpan = convertTraceSpanToPerformanceSpan(
      span,
      offenderSet,
      budget,
      0,
    );
    if (perfSpan) {
      roots.push(perfSpan);
    }
    if (budget.count >= budget.limit) {
      break;
    }
  }

  // If no parent spans found, try to find offender spans directly
  if (roots.length === 0 && offenderSpanIds.length > 0) {
    for (const offenderId of offenderSpanIds) {
      const span = spanMap.get(offenderId);
      if (!span) {
        continue;
      }
      const perfSpan = convertTraceSpanToPerformanceSpan(
        span,
        offenderSet,
        budget,
        0,
      );
      if (perfSpan) {
        roots.push(perfSpan);
      }
      if (budget.count >= budget.limit) {
        break;
      }
    }
  }

  return roots;
}

/**
 * The spans an N+1 issue points at, as a tree of at most MAX_SPANS_IN_TREE
 * spans: from the full trace when it was fetched, otherwise from the event's
 * own spans, otherwise the offending spans alone.
 */
export function selectN1EvidenceSpans(
  evidenceData: N1EvidenceData,
  spansData: unknown,
  performanceTrace?: Trace,
): PerformanceSpan[] {
  const parentSpanIds = normalizeIdArray(evidenceData.parentSpanIds);
  const offenderSpanIds = normalizeIdArray(evidenceData.offenderSpanIds);
  const traceRoots = performanceTrace
    ? selectTraceSpanRoots(
        performanceTrace,
        parentSpanIds,
        offenderSpanIds,
        MAX_SPANS_IN_TREE,
      )
    : [];
  if (traceRoots.length > 0 || !isValidSpanArray(spansData)) {
    return traceRoots;
  }
  const spanTree = selectN1QuerySpans(
    spansData,
    evidenceData,
    MAX_SPANS_IN_TREE,
  );
  if (spanTree.length > 0) {
    return spanTree;
  }
  const spansById = new Map<string, RawSpan>();
  for (const span of spansData) {
    const identifier = getSpanIdentifier(span);
    if (identifier) {
      spansById.set(identifier, span);
    }
  }
  return offenderSpanIds.slice(0, MAX_SPANS_IN_TREE).map((offenderId) => {
    const span = spansById.get(offenderId);
    return {
      span_id: offenderId,
      op: span?.op || null,
      description: span?.description || null,
      duration: span ? getSpanDurationMs(span) : null,
      is_n1_query: true,
      children: [],
      level: 0,
    };
  });
}

function convertTraceSpanToPerformanceSpan(
  span: TraceSpan,
  offenderSet: Set<string>,
  budget: { count: number; limit: number },
  level: number,
): PerformanceSpan | null {
  if (budget.count >= budget.limit) {
    return null;
  }

  budget.count += 1;

  // Get span ID from additional_attributes or fall back to event_id
  const spanId =
    normalizeSpanId(span.additional_attributes?.span_id) || span.event_id;

  const performanceSpan: PerformanceSpan = {
    span_id: spanId,
    op: span.op || null,
    description: formatTraceSpanDescription(span),
    duration: getTraceSpanDurationMs(span),
    is_n1_query: offenderSet.has(spanId),
    children: [],
    level,
  };

  for (const child of span.children) {
    if (!isTraceSpan(child)) {
      continue;
    }
    if (budget.count >= budget.limit) {
      break;
    }
    const childSpan = convertTraceSpanToPerformanceSpan(
      child,
      offenderSet,
      budget,
      level + 1,
    );
    if (childSpan) {
      performanceSpan.children.push(childSpan);
    }
    if (budget.count >= budget.limit) {
      break;
    }
  }

  return performanceSpan;
}

function formatTraceSpanDescription(span: TraceSpan): string | null {
  if (span.name && span.name.trim().length > 0) {
    return span.name.trim();
  }
  if (span.description && span.description.trim().length > 0) {
    return span.description.trim();
  }
  if (span.op && span.op.trim().length > 0) {
    return span.op.trim();
  }
  return null;
}

function getTraceSpanDurationMs(span: TraceSpan): number | null {
  if (typeof span.duration === "number" && span.duration >= 0) {
    return span.duration;
  }
  if (
    typeof (span as { end_timestamp?: number }).end_timestamp === "number" &&
    typeof span.start_timestamp === "number"
  ) {
    const deltaSeconds =
      (span as { end_timestamp: number }).end_timestamp - span.start_timestamp;
    if (Number.isFinite(deltaSeconds) && deltaSeconds >= 0) {
      return deltaSeconds * 1000;
    }
  }
  return null;
}

function selectN1QuerySpans(
  spans: RawSpan[],
  evidence: N1EvidenceData,
  maxSpans = MAX_SPANS_IN_TREE,
): PerformanceSpan[] {
  const selected: PerformanceSpan[] = [];
  let spanCount = 0;

  const offenderSpanIds = normalizeIdArray(evidence.offenderSpanIds);
  const parentSpanIds = normalizeIdArray(evidence.parentSpanIds);

  let parentSpan: PerformanceSpan | null = null;
  if (parentSpanIds.length > 0) {
    const parent = spans.find((span) => {
      const identifier = getSpanIdentifier(span);
      return identifier ? parentSpanIds.includes(identifier) : false;
    });

    if (parent) {
      parentSpan = {
        span_id: getSpanIdentifier(parent) ?? null,
        op: parent.op || null,
        description: parent.description || evidence.parentSpan || null,
        duration: getSpanDurationMs(parent),
        is_n1_query: false,
        children: [],
        level: 0,
      };
      selected.push(parentSpan);
      spanCount += 1;
    }
  }

  if (offenderSpanIds.length > 0) {
    const offenderSet = new Set(offenderSpanIds);
    const offenderSpans = spans
      .filter((span) => {
        const identifier = getSpanIdentifier(span);
        return identifier ? offenderSet.has(identifier) : false;
      })
      .slice(0, Math.max(0, maxSpans - spanCount));

    for (const span of offenderSpans) {
      const perfSpan: PerformanceSpan = {
        span_id: getSpanIdentifier(span) ?? null,
        op: span.op || null,
        description: span.description || null,
        duration: getSpanDurationMs(span),
        is_n1_query: true,
        children: [],
        level: parentSpan ? 1 : 0,
      };

      if (parentSpan) {
        parentSpan.children.push(perfSpan);
      } else {
        selected.push(perfSpan);
      }

      spanCount += 1;
      if (spanCount >= maxSpans) {
        break;
      }
    }
  }

  return selected;
}

/**
 * Known Sentry performance issue types that we handle.
 *
 * NOTE: We intentionally only implement formatters for high-value performance issues
 * that provide complex insights. Not all issue types need custom formatting - many
 * can rely on the generic evidenceDisplay fields that Sentry provides.
 *
 * Currently fully implemented:
 * - N+1 query detection (DB and API)
 *
 * Partially implemented:
 * - Slow DB queries (shows parent span only)
 *
 * Not implemented (lower priority):
 * - Asset-related issues (render blocking, uncompressed, large payloads)
 * - File I/O issues
 * - Consecutive queries
 */
export const KNOWN_PERFORMANCE_ISSUE_TYPES = {
  N_PLUS_ONE_DB_QUERIES: "performance_n_plus_one_db_queries",
  N_PLUS_ONE_API_CALLS: "performance_n_plus_one_api_calls",
  SLOW_DB_QUERY: "performance_slow_db_query",
  RENDER_BLOCKING_ASSET: "performance_render_blocking_asset",
  CONSECUTIVE_DB_QUERIES: "performance_consecutive_db_queries",
  FILE_IO_MAIN_THREAD: "performance_file_io_main_thread",
  M_N_PLUS_ONE_DB_QUERIES: "performance_m_n_plus_one_db_queries",
  UNCOMPRESSED_ASSET: "performance_uncompressed_asset",
  LARGE_HTTP_PAYLOAD: "performance_large_http_payload",
} as const;

/**
 * Map numeric occurrence types to issue types (from Sentry's codebase).
 *
 * Sentry uses numeric type IDs internally in the occurrence data structure,
 * but string issue types in the UI and other APIs. This mapping converts
 * between them.
 *
 * Source: sentry/static/app/types/group.tsx in Sentry's codebase
 * Range: 1xxx = transaction-based performance issues
 *        2xxx = profile-based performance issues
 */
export const OCCURRENCE_TYPE_TO_ISSUE_TYPE: Record<number, string> = {
  1001: KNOWN_PERFORMANCE_ISSUE_TYPES.SLOW_DB_QUERY,
  1004: KNOWN_PERFORMANCE_ISSUE_TYPES.RENDER_BLOCKING_ASSET,
  1006: KNOWN_PERFORMANCE_ISSUE_TYPES.N_PLUS_ONE_DB_QUERIES,
  1906: KNOWN_PERFORMANCE_ISSUE_TYPES.N_PLUS_ONE_DB_QUERIES, // Alternative ID for N+1 DB
  1007: KNOWN_PERFORMANCE_ISSUE_TYPES.CONSECUTIVE_DB_QUERIES,
  1008: KNOWN_PERFORMANCE_ISSUE_TYPES.FILE_IO_MAIN_THREAD,
  1009: "performance_consecutive_http",
  1010: KNOWN_PERFORMANCE_ISSUE_TYPES.N_PLUS_ONE_API_CALLS,
  1910: KNOWN_PERFORMANCE_ISSUE_TYPES.N_PLUS_ONE_API_CALLS, // Alternative ID for N+1 API
  1012: KNOWN_PERFORMANCE_ISSUE_TYPES.UNCOMPRESSED_ASSET,
  1013: "performance_db_main_thread",
  1015: KNOWN_PERFORMANCE_ISSUE_TYPES.LARGE_HTTP_PAYLOAD,
  1016: "performance_http_overhead",
};

// Type alias currently unused but kept for potential future type safety
// type PerformanceIssueType = typeof KNOWN_PERFORMANCE_ISSUE_TYPES[keyof typeof KNOWN_PERFORMANCE_ISSUE_TYPES];

function isPrimitive(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function formatPrimitive(value: unknown): string | undefined {
  return isPrimitive(value) ? String(value) : undefined;
}

const METRIC_ISSUE_OCCURRENCE_TYPE = 8001;

type MetricIssueEvidenceData = Extract<
  NonNullable<IssueEventDetailsResponse["occurrence"]>,
  { type: typeof METRIC_ISSUE_OCCURRENCE_TYPE }
>["evidenceData"];
type MetricIssueDataSource = MetricIssueEvidenceData["dataSources"][number];
type MetricIssueSnubaQuery = MetricIssueDataSource["queryObj"]["snubaQuery"];
export type MetricIssueCondition =
  MetricIssueEvidenceData["conditions"][number];

/**
 * Keys come from the generated `@sentry/api` metric occurrence type, so a
 * renamed or misspelled evidence key fails tsc. Values stay `unknown`: the
 * event is parsed with a loose Zod schema and older events can omit fields.
 */
type Unverified<T> = { readonly [K in keyof T]?: unknown };

function asUnverified<T>(value: unknown): Unverified<T> | undefined {
  return isPlainObject(value) ? value : undefined;
}

type MetricAlertQuery = {
  dataset?: string;
  aggregate?: string;
  query?: string;
  timeWindowSeconds?: number;
  environment?: string;
  eventTypes: string[];
};

export type MetricAlertContext = {
  evidenceData: Unverified<MetricIssueEvidenceData>;
  query?: MetricAlertQuery;
  monitorId?: string;
  alertRuleId?: string;
};

/**
 * Reads metric alert evidence from a metric issue event. The event API
 * camelCases occurrence payloads recursively, so evidence keys arrive as
 * `dataSources[].queryObj.snubaQuery`, `detectorId`, and `alertId`.
 */
export function getMetricAlertContext(
  event: Event,
): MetricAlertContext | undefined {
  if (event.type !== "generic") {
    return undefined;
  }
  const occurrence = (event as GenericEvent).occurrence;
  const evidenceData = asUnverified<MetricIssueEvidenceData>(
    occurrence?.evidenceData,
  );
  if (occurrence?.type !== METRIC_ISSUE_OCCURRENCE_TYPE || !evidenceData) {
    return undefined;
  }

  return {
    evidenceData,
    query: getMetricAlertQuery(evidenceData),
    monitorId: formatPrimitive(evidenceData.detectorId),
    alertRuleId: formatPrimitive(evidenceData.alertId),
  };
}

function getMetricAlertQuery(
  evidenceData: Unverified<MetricIssueEvidenceData>,
): MetricAlertQuery | undefined {
  const dataSources = evidenceData.dataSources;
  if (!Array.isArray(dataSources)) {
    return undefined;
  }

  for (const dataSource of dataSources) {
    const queryObj = asUnverified<MetricIssueDataSource["queryObj"]>(
      asUnverified<MetricIssueDataSource>(dataSource)?.queryObj,
    );
    const snubaQuery = asUnverified<MetricIssueSnubaQuery>(
      queryObj?.snubaQuery,
    );
    if (!snubaQuery) {
      continue;
    }
    const timeWindow = snubaQuery.timeWindow;
    return {
      dataset: formatPrimitive(snubaQuery.dataset),
      aggregate: formatPrimitive(snubaQuery.aggregate),
      query: formatPrimitive(snubaQuery.query)?.trim() || undefined,
      timeWindowSeconds:
        typeof timeWindow === "number" ? timeWindow : undefined,
      environment: formatPrimitive(snubaQuery.environment),
      eventTypes: Array.isArray(snubaQuery.eventTypes)
        ? snubaQuery.eventTypes.filter(
            (eventType): eventType is string => typeof eventType === "string",
          )
        : [],
    };
  }

  return undefined;
}

type MetricAlertDatasetKind = "errors" | "logs" | "spans" | "metrics";

/** Mirrors the Sentry UI's backend dataset -> detector dataset mapping. */
export function getMetricAlertDatasetKind(
  query: MetricAlertQuery,
): MetricAlertDatasetKind | undefined {
  if (query.dataset === "events") {
    return "errors";
  }
  if (query.dataset === "events_analytics_platform") {
    if (query.eventTypes.includes("trace_item_log")) {
      return "logs";
    }
    if (query.eventTypes.includes("trace_item_metric")) {
      return "metrics";
    }
    return "spans";
  }
  return undefined;
}

const METRIC_ALERT_SEARCH_TOOLS: Record<
  MetricAlertDatasetKind,
  { toolName: string; label: string }
> = {
  errors: { toolName: "search_errors", label: "Errors" },
  logs: { toolName: "search_logs", label: "Logs" },
  spans: { toolName: "search_traces", label: "Spans" },
  metrics: { toolName: "search_metrics", label: "Application metrics" },
};

/** Returns the window the monitor aggregated over for this occurrence. */
export function getMetricAlertEvaluatedWindow(
  event: Event,
  query: MetricAlertQuery | undefined,
): { start: Date; end: Date } | undefined {
  const dateCreated = (event as GenericEvent).dateCreated;
  if (!dateCreated || query?.timeWindowSeconds == null) {
    return undefined;
  }
  const end = new Date(dateCreated);
  if (Number.isNaN(end.getTime())) {
    return undefined;
  }
  return {
    start: new Date(end.getTime() - query.timeWindowSeconds * 1000),
    end,
  };
}

function formatSearchFilterValue(value: string): string {
  return /[\s"(),:]/.test(value) ? JSON.stringify(value) : value;
}

/** Smallest relative search period that reaches back to `start`. */
function formatPeriodSince(start: Date, now: number): string {
  const elapsedMs = Math.max(now - start.getTime(), 0);
  const hours = Math.max(Math.ceil(elapsedMs / 3_600_000), 1);
  return hours <= 48 ? `${hours}h` : `${Math.ceil(hours / 24)}d`;
}

export function formatMetricAlertCondition(
  condition: Unverified<MetricIssueCondition>,
): string | undefined {
  const comparison = condition.comparison;
  const formattedComparison = formatPrimitive(comparison);
  if (formattedComparison == null) {
    return undefined;
  }

  const type = condition.type;
  const typeLabel = (() => {
    if (type === 0 || type === "0" || type === "gt" || type === "gte") {
      return type === "gte" ? "at or above" : "above";
    }
    if (type === 1 || type === "1" || type === "lt" || type === "lte") {
      return type === "lte" ? "at or below" : "below";
    }
    if (type != null) {
      return formatUnknown(type);
    }
    return undefined;
  })();

  if (typeLabel && !/^\d+$/.test(typeLabel)) {
    return `${typeLabel} ${formattedComparison}`;
  }

  return formattedComparison;
}

export function formatMetricAlertValue(value: unknown): string | undefined {
  const formattedValue = formatPrimitive(value);
  if (formattedValue) {
    return formattedValue;
  }

  if (isPlainObject(value)) {
    return formatPrimitive(value.value);
  }

  return undefined;
}

type MetricAlertFollowUpCalls = {
  monitor?: { toolName: string; arguments: Record<string, string> };
  search?: {
    toolName: string;
    arguments: Record<string, string>;
    label: string;
    window: { start: Date; end: Date };
  };
};

/**
 * Follow-up calls for metric issues: the monitor configuration and a search
 * call that reproduces the monitor query over the evaluated window.
 */
export function getMetricAlertFollowUpCalls({
  organizationSlug,
  issue,
  event,
  context,
}: {
  organizationSlug: string;
  issue: Issue;
  event: Event;
  context: MetricAlertContext;
}): MetricAlertFollowUpCalls {
  const calls: MetricAlertFollowUpCalls = {};
  if (context.monitorId) {
    calls.monitor = {
      toolName: "get_metric_monitor_details",
      arguments: { organizationSlug, monitorId: context.monitorId },
    };
  }

  const query = context.query;
  const datasetKind = query ? getMetricAlertDatasetKind(query) : undefined;
  const evaluatedWindow = getMetricAlertEvaluatedWindow(event, query);
  if (!query || !datasetKind || !evaluatedWindow) {
    return calls;
  }

  const { toolName, label } = METRIC_ALERT_SEARCH_TOOLS[datasetKind];
  // Sentry search binds implicit AND tighter than OR, so group an OR query
  // before appending the environment filter.
  const monitorQuery =
    query.query && query.environment && /\bOR\b/.test(query.query)
      ? `(${query.query})`
      : query.query;
  const searchQuery = [
    monitorQuery,
    query.environment
      ? `environment:${formatSearchFilterValue(query.environment)}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  calls.search = {
    toolName,
    arguments: {
      organizationSlug,
      projectSlug: issue.project.slug,
      ...(searchQuery ? { query: searchQuery } : {}),
      period: formatPeriodSince(evaluatedWindow.start, Date.now()),
    },
    label,
    window: evaluatedWindow,
  };
  return calls;
}

/** Projects the suspect commit consistently for structured and markdown issue details. */
export function getSuspectCommit(committers: CommitterList | undefined) {
  // The endpoint currently returns the issue's latest suspect commit, grouped by author.
  const committer = committers?.[0];
  const commit = committer?.commits[0];
  if (!commit) {
    return null;
  }
  return {
    id: String(commit.id),
    message: commit.message,
    author: committer.author?.name ?? committer.author?.email,
    suspectCommitType: commit.suspectCommitType,
  };
}

/** Reports an event type this server cannot render yet, so support can be added. */
export function reportUnsupportedEventType({
  organizationSlug,
  issue,
  event,
}: {
  organizationSlug: string;
  issue: Issue;
  event: Event;
}): string | undefined {
  return logIssue(`Unsupported event type encountered: ${String(event.type)}`, {
    contexts: {
      event: {
        event_id: event.id,
        event_type: event.type,
        issue_id: issue.id,
        issue_short_id: issue.shortId,
        organization_slug: organizationSlug,
        project_slug: issue.project.slug,
      },
    },
  });
}

export function getReplayIdFromEvent(event: Event): string | null {
  const replayContext = event.contexts?.replay;
  const replayContextId =
    typeof replayContext?.replay_id === "string"
      ? replayContext.replay_id
      : null;
  const replayTagId =
    event.tags?.find((tag) => tag.key === "replayId" || tag.key === "replay.id")
      ?.value ?? null;

  return normalizeReplayId(replayContextId ?? replayTagId);
}

export function dedupeReplayIds(replayIds: string[]): string[] {
  const normalizedReplayIds: string[] = [];
  const seenReplayIds = new Set<string>();

  for (const replayId of replayIds) {
    const normalizedReplayId = normalizeReplayId(replayId);
    if (!normalizedReplayId || seenReplayIds.has(normalizedReplayId)) {
      continue;
    }
    seenReplayIds.add(normalizedReplayId);
    normalizedReplayIds.push(normalizedReplayId);
  }

  return normalizedReplayIds;
}

function normalizeReplayId(replayId: string | null | undefined): string | null {
  if (typeof replayId !== "string") {
    return null;
  }

  const trimmedReplayId = replayId.trim();
  if (!trimmedReplayId) {
    return null;
  }

  return trimmedReplayId.replace(/-/g, "");
}

export function stripReplayMetadata(event: Event): Event {
  const tags = event.tags?.filter(
    (tag) => tag.key !== "replay.id" && tag.key !== "replayId",
  );
  const replayContext = event.contexts?.replay;

  if (!replayContext) {
    return { ...event, tags };
  }

  const nextReplayContext = Object.fromEntries(
    Object.entries(replayContext).filter(([key]) => key !== "replay_id"),
  );
  const nonTypeReplayKeys = Object.keys(nextReplayContext).filter(
    (key) => key !== "type",
  );
  const contexts =
    nonTypeReplayKeys.length === 0
      ? Object.fromEntries(
          Object.entries(event.contexts ?? {}).filter(
            ([key]) => key !== "replay",
          ),
        )
      : {
          ...event.contexts,
          replay: { ...nextReplayContext, type: replayContext.type },
        };

  return {
    ...event,
    tags,
    contexts,
  };
}
