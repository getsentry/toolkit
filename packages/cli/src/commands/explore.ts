/**
 * sentry explore
 *
 * Query aggregate event data using the Sentry Explore/Events API.
 * Supports arbitrary fields, aggregates, and datasets for spike analysis
 * and ad-hoc event queries.
 */

import {
  isAggregateFieldOrEquation,
  isEquation,
  isTracemetricsAggregate,
} from "@sentry/toolkit-core/events-fields";
import { resolveEventsSort } from "@sentry/toolkit-core/events-sort";
import type { SentryContext } from "../context.js";
import {
  isReplaySortValue,
  listReplays,
  queryEvents,
  queryEventsTimeSeries,
  queryMetricsMeta,
} from "../lib/api-client.js";
import { validateLimit } from "../lib/arg-parsing.js";
import {
  advancePaginationState,
  buildPaginationContextKey,
  hasPreviousPage,
  resolveCursor,
} from "../lib/db/pagination.js";
import { buildDatasetParser, datasetDisplayName } from "../lib/datasets.js";
import { toSearchQueryError, ValidationError } from "../lib/errors.js";
import { toExploreFieldError } from "../lib/explore-errors.js";
import {
  parseTimeSeriesInterval,
  resolveTimeSeriesInterval,
} from "../lib/explore-timeseries.js";
import {
  type ExploreTimeSeriesData,
  formatExploreTimeSeriesHuman,
  jsonTransformExploreTimeSeries,
} from "../lib/formatters/explore-timeseries.js";
import { filterFields } from "../lib/formatters/json.js";
import { buildMetaColumns } from "../lib/formatters/meta-table.js";
import { CommandOutput } from "../lib/formatters/output.js";
import { formatTable } from "../lib/formatters/table.js";
import {
  appendQueryHint,
  appendSortHint,
  buildListCommand,
  LIST_MAX_LIMIT,
  ORG_ALL_TARGET_BRIEF,
  PERIOD_ALIASES,
  paginationHint,
  targetPatternExplanation,
} from "../lib/list-command.js";
import { logger } from "../lib/logger.js";
import { resolveMetricField } from "../lib/metrics-transform.js";
import { withProgress } from "../lib/polling.js";
import {
  DEFAULT_REPLAY_EXPLORE_FIELDS,
  getReplayFieldValue,
  getReplayRequestFields,
  isSupportedReplayField,
  listSupportedReplayFields,
  parseReplayEnvironmentFilter,
} from "../lib/replay-search.js";
import { sanitizeQuery } from "../lib/search-query.js";
import { shellQuote } from "../lib/utils.js";
import {
  type OrgOptionalTarget,
  orgOptionalTarget,
} from "../lib/target-positional.js";
import {
  appendPeriodHint,
  PERIOD_BRIEF,
  parsePeriod,
  serializeTimeRange,
  type TimeRange,
  timeRangeToApiParams,
} from "../lib/time-range.js";

const log = logger.withTag("explore");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default fields when none specified — top errors view */
const DEFAULT_FIELDS = ["title", "count()"];
const DEFAULT_TRANSACTION_FIELDS = ["transaction", "count()"];
const LEGACY_TRANSACTION_DATASETS = new Set(["transaction", "transactions"]);
const IS_TRANSACTION_FILTER = "is_transaction:true";

/** Default dataset */
const DEFAULT_DATASET = "errors";
const DEFAULT_REPLAY_SORT = "-started_at";

/** Default time period */
const DEFAULT_PERIOD = "24h";

/** Command key for pagination cursor storage */
const PAGINATION_KEY = "explore";

const DATASETS = buildDatasetParser(
  ["errors", "spans", "tracemetrics", "logs", "replays"],
  Array.from(LEGACY_TRANSACTION_DATASETS),
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ExploreFlags = {
  readonly field?: string[];
  readonly metric?: string;
  readonly agg: string;
  readonly dataset: string;
  readonly environment?: readonly string[];
  readonly query?: string;
  readonly sort?: string;
  readonly period: TimeRange;
  readonly limit?: number;
  /** Bucket duration or "auto"; omitted for tabular output. */
  readonly "time-series"?: string;
  readonly cursor?: string;
  readonly json: boolean;
  readonly fresh: boolean;
  readonly fields?: string[];
};

/** Data yielded by the explore command for both JSON and human output */
type ExploreData = {
  data: Record<string, unknown>[];
  meta?: {
    fields?: Record<string, string>;
    units?: Record<string, string | null>;
  };
  hasMore: boolean;
  hasPrev: boolean;
  nextCursor?: string | null;
  dataset: string;
  org: string;
  /** Project filter, when target was `org/project` */
  project?: string;
  /** The fields the user requested, in their original order — drives column order */
  requestedFields: string[];
};

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

/**
 * Parse --limit flag. Capped at {@link LIST_MAX_LIMIT} (1000).
 * `queryEvents` auto-paginates when the limit exceeds the API's per-page cap.
 */
function parseLimit(value: string): number {
  return validateLimit(value, 1, LIST_MAX_LIMIT);
}

/** Infer a Discover-style column type for a replay field (used for table alignment). */
function inferReplayFieldType(field: string): string {
  if (field === "duration") {
    return "duration";
  }
  if (field === "activity" || field.startsWith("count_")) {
    return "integer";
  }
  return "string";
}

function buildReplayExploreResponse(
  fields: string[],
  replays: Awaited<ReturnType<typeof listReplays>>["data"],
): { data: Record<string, unknown>[]; meta: NonNullable<ExploreData["meta"]> } {
  return {
    data: replays.map((replay) =>
      Object.fromEntries(
        fields.map((field) => [field, getReplayFieldValue(replay, field)]),
      ),
    ),
    meta: {
      fields: Object.fromEntries(
        fields.map((field) => [field, inferReplayFieldType(field)]),
      ),
      units: Object.fromEntries(
        fields.map((field) => [field, field === "duration" ? "s" : null]),
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Output formatters
// ---------------------------------------------------------------------------

/**
 * Determine the column order for the table.
 *
 * Preserves the user's `--field` order, then appends any extra fields the
 * API returned that weren't in the request (rare, but possible for derived
 * fields like equations). Falls back to API response keys when no requested
 * fields are available.
 */
function orderFieldNames(
  requestedFields: string[],
  data: ExploreData,
): string[] {
  const apiFields = data.meta?.fields
    ? Object.keys(data.meta.fields)
    : Object.keys(data.data[0] ?? {});

  if (requestedFields.length === 0) {
    return apiFields;
  }

  const apiSet = new Set(apiFields);
  const ordered = requestedFields.filter((f) => apiSet.has(f));
  // Append any API-returned fields that weren't requested (preserves API order)
  const requestedSet = new Set(ordered);
  for (const f of apiFields) {
    if (!requestedSet.has(f)) {
      ordered.push(f);
    }
  }
  return ordered;
}

/** Format explore results for human-readable terminal output */
function formatExploreHuman(data: ExploreData | ExploreTimeSeriesData): string {
  const displayDataset = datasetDisplayName(data.dataset);
  if ("timeSeries" in data) {
    return formatExploreTimeSeriesHuman({ ...data, dataset: displayDataset });
  }
  if (data.data.length === 0) {
    // Empty page mid-pagination (more or prev pages exist) vs. truly no results.
    return data.hasMore || data.hasPrev
      ? "No results on this page."
      : "No results matched the query.";
  }

  const fieldNames = orderFieldNames(data.requestedFields, data);
  const columns = buildMetaColumns(
    fieldNames,
    data.meta?.fields,
    data.meta?.units,
  );

  const scope = data.project ? `${data.org}/${data.project}` : data.org;
  const header = `Querying ${displayDataset} in ${scope}:\n\n`;
  return header + formatTable(data.data, columns);
}

/** Transform explore results for JSON output */
function jsonTransformExplore(
  data: ExploreData | ExploreTimeSeriesData,
  fields?: string[],
): unknown {
  if ("timeSeries" in data) {
    return jsonTransformExploreTimeSeries(data, fields);
  }
  const items =
    fields && fields.length > 0
      ? data.data.map((row) => filterFields(row, fields))
      : data.data;

  const envelope: Record<string, unknown> = {
    data: items,
    meta: data.meta,
    hasMore: data.hasMore,
    hasPrev: data.hasPrev,
    dataset: data.dataset,
  };
  if (
    data.nextCursor !== null &&
    data.nextCursor !== undefined &&
    data.nextCursor !== ""
  ) {
    envelope.nextCursor = data.nextCursor;
  }
  return envelope;
}

// ---------------------------------------------------------------------------
// Pagination hints
// ---------------------------------------------------------------------------

/** Default table row limit, also omitted from pagination hints. */
const DEFAULT_LIMIT = 25;

function defaultFieldsForDataset(dataset: string): readonly string[] {
  if (dataset === "replays") {
    return DEFAULT_REPLAY_EXPLORE_FIELDS;
  }
  if (LEGACY_TRANSACTION_DATASETS.has(dataset)) {
    return DEFAULT_TRANSACTION_FIELDS;
  }
  return DEFAULT_FIELDS;
}

/** Append --metric / --agg flags to hint parts */
function appendMetricHints(
  parts: string[],
  metric: string | undefined,
  agg: string,
): void {
  if (metric) {
    parts.push(`-m "${metric}"`);
    if (agg !== "sum") {
      parts.push(`--agg ${agg}`);
    }
  }
}

/** Append non-default --field flags to hint parts */
function appendFieldHints(
  parts: string[],
  rawFields: string[] | undefined,
  dataset: string,
  metricActive: boolean,
): void {
  const fields = rawFields ?? [];
  const fieldList = metricActive
    ? fields.filter((f) => !isAggregateFieldOrEquation(f))
    : fields;
  const defaults = defaultFieldsForDataset(dataset).join(",");
  if (fieldList.join(",") !== defaults && fieldList.length > 0) {
    for (const f of fieldList) {
      parts.push(`-F ${shellQuote(f)}`);
    }
  }
}

/** Append active non-default flags to a base command string */
function appendFlagHints(
  base: string,
  flags: Pick<
    ExploreFlags,
    | "dataset"
    | "environment"
    | "sort"
    | "query"
    | "period"
    | "field"
    | "limit"
    | "metric"
    | "agg"
  >,
): string {
  const parts: string[] = [];
  const defaultSort =
    flags.dataset === "replays" ? DEFAULT_REPLAY_SORT : undefined;
  if (flags.dataset !== DEFAULT_DATASET) {
    // Emit user-facing name, not API-level name (e.g. "metrics" not "tracemetrics")
    parts.push(`--dataset ${datasetDisplayName(flags.dataset)}`);
  }
  appendMetricHints(parts, flags.metric, flags.agg);
  appendSortHint(parts, flags.sort, defaultSort);
  appendQueryHint(parts, flags.query);
  appendFieldHints(parts, flags.field, flags.dataset, !!flags.metric);
  if (flags.limit !== undefined && flags.limit !== DEFAULT_LIMIT) {
    parts.push(`--limit ${flags.limit}`);
  }
  if (flags.environment && flags.environment.length > 0) {
    for (const environment of flags.environment) {
      parts.push(`-e "${environment}"`);
    }
  }
  appendPeriodHint(parts, flags.period, DEFAULT_PERIOD);
  return parts.length > 0 ? `${base} ${parts.join(" ")}` : base;
}

/**
 * Validate that aggregate fields use the tracemetrics format when querying
 * the `tracemetrics` dataset. Standard aggregates like `count()` or
 * `avg(measurements.fcp)` are invalid — the API requires the four-part
 * comma-separated format: `aggregation(value,metric_name,metric_type,unit)`.
 * Conditional aggregates prepend a filter; equations are validated by the backend.
 */
function validateMetricsFields(fieldList: string[]): void {
  const badAggs = fieldList.filter(
    (f) =>
      isAggregateFieldOrEquation(f) &&
      !isEquation(f) &&
      !isTracemetricsAggregate(f),
  );
  if (badAggs.length === 0) {
    return;
  }

  throw new ValidationError(
    `Invalid metrics aggregate${badAggs.length > 1 ? "s" : ""}: ${badAggs.join(", ")}\n\n` +
      "The metrics dataset requires the format: aggregation(value,metric_name,metric_type,unit)\n\n" +
      "Examples:\n" +
      '  sentry explore my-org/ -F "sum(value,llm.token_usage,distribution,none)" --dataset metrics\n' +
      '  sentry explore my-org/ -F gen_ai.request.model -F "avg(value,cache.hit_rate,distribution,none)" --dataset metrics\n\n' +
      "Parameters:\n" +
      '  - value: literal string "value"\n' +
      "  - metric_name: the metric name emitted by the SDK (e.g., llm.token_usage)\n" +
      "  - metric_type: distribution, gauge, counter, or set\n" +
      "  - unit: none, byte, second, millisecond, etc.",
    "field",
  );
}

// ---------------------------------------------------------------------------
// Dataset configuration
// ---------------------------------------------------------------------------

/**
 * Dataset-specific configuration resolved before the main query loop.
 *
 * Centralizes all replay vs. non-replay branching so the main `func` body
 * reads linearly without `dataset === "replays"` checks.
 */
type DatasetConfig = {
  /** The effective sort value for pagination context and API calls. */
  sort: string | undefined;
  /** The API query string (with or without `project:` prefix). */
  query: string | undefined;
  /** Execute the dataset-specific API query. */
  fetch: (params: {
    cursor: string | undefined;
    limit: number;
    timeRange: TimeRange;
  }) => Promise<{
    data: { data: Record<string, unknown>[]; meta?: ExploreData["meta"] };
    nextCursor?: string;
  }>;
};

/**
 * Translate `--environment` values into a query filter term. A single value
 * becomes `environment:foo`; multiple values use the `environment:[a,b]` list
 * syntax so they are ORed rather than ANDed.
 */
function buildEnvironmentQuery(
  environment: string[] | undefined,
): string | undefined {
  if (!environment || environment.length === 0) {
    return;
  }
  if (environment.length === 1) {
    return `environment:${environment[0]}`;
  }
  return `environment:[${environment.join(",")}]`;
}

/** Resolve the shared dataset and filters for tabular and temporal queries. */
function resolveEventsQuery(
  dataset: string,
  query: string | undefined,
  project: string | undefined,
  environment: string[] | undefined,
) {
  const userQuery = sanitizeQuery(query, { allowBoolean: true });
  const legacyTransactions = LEGACY_TRANSACTION_DATASETS.has(dataset);
  const scope = [
    project ? `project:${project}` : undefined,
    buildEnvironmentQuery(environment),
    legacyTransactions ? IS_TRANSACTION_FILTER : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  // AND binds more tightly than OR, so CLI scope must enclose every user branch.
  const scopedQuery =
    legacyTransactions && userQuery === IS_TRANSACTION_FILTER
      ? undefined
      : userQuery;
  return {
    dataset: legacyTransactions ? "spans" : dataset,
    query:
      scope && scopedQuery ? `${scope} (${scopedQuery})` : scope || scopedQuery,
  };
}

/** Reject table-only flags and dimensions before a temporal query is sent. */
function validateTimeSeriesFlags(flags: ExploreFlags): void {
  if (flags["time-series"] === undefined) {
    return;
  }
  for (const flag of ["cursor", "limit", "sort"] as const) {
    if (flags[flag] !== undefined) {
      throw new ValidationError(
        `--${flag} is only available for tables. Time series return all buckets in chronological order; use --period and --time-series to control the range and granularity.`,
        flag,
      );
    }
  }
  if (flags.dataset === "replays" && !flags.metric) {
    throw new ValidationError(
      "Time series support errors, spans, logs, and metrics. The replays dataset is only available as a table.",
      "dataset",
    );
  }
  const dimensions = flags.field?.filter(
    (field) => !isAggregateFieldOrEquation(field),
  );
  if (dimensions?.length) {
    throw new ValidationError(
      `Time series require aggregate fields, such as count() or p95(span.duration). Grouping is not supported: ${dimensions.join(", ")}. Use --query to filter these fields or omit --time-series for a grouped table.`,
      "field",
    );
  }
}

/**
 * Resolve dataset-specific configuration: sort, query, validation, and fetch.
 *
 * For the `replays` dataset this validates fields, resolves replay-specific
 * sort, and returns a fetch function that calls `listReplays`. For all other
 * datasets it translates `--environment` values into `environment:...` query
 * filter terms, resolves the sort with {@link resolveEventsSort} (which also
 * selects the sort column), prepends `project:<slug>` to the query, and
 * returns a `queryEvents` fetch.
 */
function resolveDatasetConfig(params: {
  dataset: string;
  fieldList: string[];
  flags: ExploreFlags;
  org: string;
  project: string | undefined;
  environment: string[] | undefined;
}): DatasetConfig {
  const { dataset, fieldList, flags, org, project, environment } = params;
  if (dataset === "replays") {
    const userQuery = sanitizeQuery(flags.query);
    const unsupportedField = fieldList.find(
      (field) => !isSupportedReplayField(field),
    );
    if (unsupportedField) {
      throw new ValidationError(
        `Unsupported replay field "${unsupportedField}". Supported fields include: ${listSupportedReplayFields().slice(0, 12).join(", ")}...`,
        "field",
      );
    }

    const sort = flags.sort ?? DEFAULT_REPLAY_SORT;
    if (!isReplaySortValue(sort)) {
      throw new ValidationError(
        `Invalid replay sort "${sort}". Use a replay sort like ${DEFAULT_REPLAY_SORT} or -count_errors.`,
        "sort",
      );
    }

    return {
      sort,
      query: userQuery,
      fetch: async ({ cursor, limit, timeRange }) => {
        const replayResponse = await listReplays(org, {
          cursor,
          environment,
          fields: getReplayRequestFields(fieldList),
          limit,
          projectSlugs: project ? [project] : undefined,
          query: userQuery,
          sort,
          ...timeRangeToApiParams(timeRange),
        });
        return {
          data: buildReplayExploreResponse(fieldList, replayResponse.data),
          nextCursor: replayResponse.nextCursor,
        };
      },
    };
  }

  // Non-replay datasets: translate --environment into query filter terms
  // since the Discover/Events API expects environment:... in the query string.
  const resolved = resolveEventsQuery(
    dataset,
    flags.query,
    project,
    environment,
  );

  // Every Events dataset honors sort as long as the sort column is selected.
  // A stable sort is what keeps offset-based cursor pagination from
  // duplicating and skipping rows (#1519) and makes --limit a top N (#1477).
  const { fields, sort } = resolveEventsSort({
    fields: fieldList,
    sort: flags.sort,
  });

  const query = resolved.query;
  return {
    sort,
    query,
    fetch: async ({ cursor, limit, timeRange }) =>
      await queryEvents(org, {
        fields,
        dataset: resolved.dataset,
        query,
        sort,
        limit,
        cursor,
        ...timeRangeToApiParams(timeRange),
      }).catch((error: unknown): never => {
        throw toExploreFieldError(error, {
          dataset: datasetDisplayName(resolved.dataset),
          fields,
          userFields: (flags.field ?? []).filter(
            (field) => !flags.metric || !isAggregateFieldOrEquation(field),
          ),
          sort,
          userSort: flags.sort,
        });
      }),
  };
}

/** Build the result hint string from pagination state and row count */
function buildResultHint(rowCount: number, nav: string): string | undefined {
  if (rowCount === 0 && nav) {
    return nav;
  }
  if (rowCount > 0) {
    const countText = `Showing ${rowCount} result${rowCount === 1 ? "" : "s"}.`;
    return nav ? `${countText} ${nav}` : countText;
  }
  return;
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

export const exploreCommand = buildListCommand("explore", {
  docs: {
    brief: "Query aggregate event data (Explore)",
    fullDescription:
      "Query the Sentry Explore API for aggregate event data.\n\n" +
      "Supports arbitrary fields including columns (title, project),\n" +
      "aggregates (count(), count_unique(user), p50(span.duration)),\n" +
      "and equations. Results default to a table.\n\n" +
      "Use --time-series to calculate aggregates in time buckets with an automatic interval, " +
      "or pass a bucket duration such as --time-series 15m (-b 15m). " +
      "Time series use one chart per aggregate on graphics-capable terminals, with table fallback. " +
      "This is a single historical query, not a live stream. " +
      "Grouping, --sort, --limit, and --cursor are table-only.\n\n" +
      "Datasets:\n" +
      "  errors   Error events (default)\n" +
      "  spans    Span data\n" +
      "  metrics  Custom metrics (tracemetrics format)\n" +
      "  logs     Log entries\n" +
      "  replays  Session replay search\n\n" +
      "Events queries support AND, OR, and parentheses. Project, environment, " +
      "and transaction scope apply to the entire query.\n\n" +
      "A <org>/<project> target adds project:<slug> to the query. " +
      targetPatternExplanation(),
    examples: [
      {
        description: "Top errors in the last 24 hours, scoped to a project",
        command: "sentry explore my-org/cli",
      },
      {
        description: "All projects in an organization",
        command: "sentry explore my-org/",
      },
      {
        description: "Bare project slug (searches across organizations)",
        command: "sentry explore cli",
      },
      {
        description: "Auto-detect the project from DSN/config",
        command: "sentry explore",
      },
      {
        description: "Errors with user impact for a specific UTC window",
        command:
          'sentry explore my-org/cli -F title -F "count()" -F "count_unique(user)" --period "2024-01-15T00:00:00Z..2024-01-16T00:00:00Z"',
      },
      {
        description: "Filter by error type (combined with the project filter)",
        command:
          'sentry explore my-org/cli -F title -F "count()" -q "error.type:TypeError" --period 1h',
      },
      {
        description: "Combine span filters while keeping the project scope",
        command:
          'sentry explore my-org/cli --dataset spans -F "count()" -q "span.op:http.client OR span.status:internal_error"',
      },
      {
        description: "Count a metric only for a matching release",
        command:
          "sentry explore my-org/ --dataset metrics -F 'count_if(`release:example`,value,request_duration,distribution,none)'",
      },
      {
        description: "Span operation latency",
        command:
          'sentry explore my-org/cli -F span.op -F "p50(span.duration)" -F "p95(span.duration)" --dataset spans --period 1h',
      },
      {
        description: "Top spans by count",
        command:
          'sentry explore my-org/cli -F span.op -F "count()" --dataset spans --sort "-count()"',
      },
      {
        description: "Error counts in 15-minute buckets over the last hour",
        command: "sentry explore my-org/cli --time-series 15m --period 1h",
      },
      {
        description:
          "Latency over time with automatic bucket duration, as JSON",
        command:
          'sentry explore my-org/cli --dataset spans -F "p95(span.duration)" --time-series --period 24h --json',
      },
      {
        description: "A metric over time using its discovered type and unit",
        command:
          "sentry explore my-org/cli --dataset metrics -m cache.hit_rate --agg avg -b -t 1h",
      },
      {
        description:
          "Sum a custom metric (e.g., LLM token usage) across an organization",
        command:
          "sentry explore my-org/ -m llm.token_usage --dataset metrics --period 7d",
      },
      {
        description: "Break a metric down by a tag column",
        command:
          "sentry explore my-org/seer -F gen_ai.request.model -m llm.token_usage --dataset metrics --period 7d",
      },
      {
        description: "Use a different metric aggregation (default is sum)",
        command:
          "sentry explore my-org/ -m cache.hit_rate --agg avg --dataset metrics",
      },
      {
        description: "Use the raw tracemetrics format",
        command:
          'sentry explore my-org/ -F "sum(value,llm.token_usage,distribution,none)" --dataset metrics --period 7d',
      },
      {
        description: "Filter replays by activity level",
        command:
          "sentry explore my-org/cli --dataset replays -F activity -F duration -F count_errors --period 7d",
      },
      {
        description: "Log severity counts in the last hour",
        command:
          'sentry explore my-org/cli -F severity -F "count()" --dataset logs --period 1h',
      },
      {
        description: "Pipe JSON to jq",
        command:
          "sentry explore my-org/cli -F title -F \"count()\" --json | jq '.data[:5]'",
      },
    ],
  },
  output: {
    human: formatExploreHuman,
    jsonTransform: jsonTransformExplore,
  },
  parameters: {
    positional: {
      kind: "tuple" as const,
      parameters: [
        {
          placeholder: "target",
          brief: ORG_ALL_TARGET_BRIEF,
          parse: orgOptionalTarget,
          optional: true as const,
        },
      ],
    },
    flags: {
      field: {
        kind: "parsed",
        parse: String,
        brief:
          'API field or aggregate (repeatable). E.g., title, "count()", "p50(span.duration)"',
        variadic: true,
        optional: true,
      },
      metric: {
        kind: "parsed",
        parse: String,
        brief:
          "Metric name for --dataset metrics. Auto-resolves type/unit via API.",
        optional: true,
      },
      agg: {
        kind: "parsed",
        parse: String,
        brief: "Aggregation for --metric (sum, avg, count, p50, p95, etc.)",
        default: "sum",
      },
      dataset: {
        kind: "parsed",
        parse: DATASETS.parse,
        brief: `Dataset to query (${DATASETS.names.join(", ")}; transaction(s) routes to spans)`,
        default: DEFAULT_DATASET,
      },
      query: {
        kind: "parsed",
        parse: String,
        brief: "Search query (Sentry search syntax)",
        optional: true,
      },
      sort: {
        kind: "parsed",
        parse: String,
        brief: 'Sort field (prefix with - for desc, e.g., "-count()")',
        optional: true,
      },
      environment: {
        kind: "parsed",
        parse: String,
        brief: "Environment filter (repeatable, comma-separated)",
        variadic: true,
        optional: true,
      },
      limit: {
        kind: "parsed",
        parse: parseLimit,
        placeholder: "number",
        brief: `Number of table rows (1-${LIST_MAX_LIMIT}, default: ${DEFAULT_LIMIT})`,
        optional: true,
      },
      "time-series": {
        kind: "parsed",
        parse: (value: string) =>
          value === "" || value === "auto"
            ? "auto"
            : parseTimeSeriesInterval(value),
        placeholder: "auto|interval",
        brief:
          "Query time series (default: auto; optional bucket duration, e.g., 15m)",
        optional: true,
        inferEmpty: true,
      },
      period: {
        kind: "parsed" as const,
        parse: parsePeriod,
        brief: PERIOD_BRIEF,
        default: DEFAULT_PERIOD,
      },
    },
    aliases: {
      ...PERIOD_ALIASES,
      e: "environment",
      F: "field",
      m: "metric",
      d: "dataset",
      q: "query",
      s: "sort",
      n: "limit",
      b: "time-series",
    },
  },
  async *func(
    this: SentryContext,
    flags: ExploreFlags,
    target: OrgOptionalTarget,
  ) {
    validateTimeSeriesFlags(flags);
    const { org, project } = await target.resolved;

    let dataset = flags.dataset;
    const userSuppliedFields = flags.field && flags.field.length > 0;
    let fieldList =
      flags["time-series"] !== undefined
        ? ["count()"]
        : [...defaultFieldsForDataset(dataset)];
    if (userSuppliedFields) {
      fieldList = flags.field;
    }
    // SDK callers supply the public string form without Stricli parsing.
    const timeRange =
      typeof flags.period === "string"
        ? parsePeriod(flags.period)
        : flags.period;
    const environment = parseReplayEnvironmentFilter(flags.environment);

    // --metric auto mode: resolve metric name → tracemetrics aggregate
    if (flags.metric) {
      if (dataset !== "tracemetrics") {
        log.warn("--metric implies --dataset metrics; switching dataset.");
        dataset = "tracemetrics";
      }

      // Use the user's --period for metadata discovery so older metrics are found
      const metaParams = timeRangeToApiParams(timeRange);
      const metrics = await withProgress(
        {
          message: `Discovering metric '${flags.metric}'...`,
          json: flags.json,
        },
        () =>
          queryMetricsMeta(org, {
            ...metaParams,
            project,
          }),
      );

      const aggField = resolveMetricField(flags.metric, flags.agg, metrics);
      // Prepend any user-supplied grouping fields, then the resolved aggregate
      const groupByFields = userSuppliedFields
        ? fieldList.filter((f) => !isAggregateFieldOrEquation(f))
        : [];
      fieldList = [...groupByFields, aggField];
    } else if (dataset === "tracemetrics") {
      if (!userSuppliedFields) {
        throw new ValidationError(
          "The metrics dataset requires --metric or explicit --field flags.\n\n" +
            "Auto mode (recommended):\n" +
            "  sentry explore my-org/ -m llm.token_usage --dataset metrics\n" +
            "  sentry explore my-org/ -m llm.token_usage --agg avg --dataset metrics\n\n" +
            "Manual mode (tracemetrics format):\n" +
            '  sentry explore my-org/ -F "sum(value,llm.token_usage,distribution,none)" --dataset metrics',
          "field",
        );
      }
      validateMetricsFields(fieldList);
    }

    if (flags["time-series"] !== undefined) {
      const resolved = resolveEventsQuery(
        dataset,
        flags.query,
        project,
        environment,
      );
      const timeParams = timeRangeToApiParams(timeRange);
      const interval = resolveTimeSeriesInterval(
        timeParams,
        flags["time-series"] === "auto" ? undefined : flags["time-series"],
      );
      const response = await withProgress(
        {
          message: `Querying ${resolved.dataset} time series in ${project ? `${org}/${project}` : org}...`,
          json: flags.json,
        },
        () =>
          queryEventsTimeSeries(org, {
            fields: fieldList,
            dataset: resolved.dataset,
            query: resolved.query,
            interval,
            ...timeParams,
          }).catch((error: unknown): never => {
            const fieldError = toExploreFieldError(error, {
              dataset: datasetDisplayName(resolved.dataset),
              fields: fieldList,
              userFields: (flags.field ?? []).filter(
                (field) => !flags.metric || !isAggregateFieldOrEquation(field),
              ),
              sort: undefined,
              userSort: undefined,
            });
            throw toSearchQueryError(fieldError, flags.query);
          }),
      );
      yield new CommandOutput({
        ...response,
        dataset: resolved.dataset,
        org,
        project,
      });
      return;
    }

    const config = resolveDatasetConfig({
      dataset,
      fieldList,
      flags,
      org,
      project,
      environment,
    });

    const contextKey = buildPaginationContextKey(
      "explore",
      project ? `${org}/${project}` : org,
      {
        dataset,
        env: environment?.join(","),
        fields: fieldList.join(","),
        q: flags.query,
        sort: config.sort,
        period: serializeTimeRange(timeRange),
      },
    );
    const { cursor, direction } = resolveCursor(
      flags.cursor,
      PAGINATION_KEY,
      contextKey,
    );

    const { data: response, nextCursor } = await withProgress(
      {
        message: `Querying ${dataset} in ${project ? `${org}/${project}` : org}...`,
        json: flags.json,
      },
      () =>
        config
          .fetch({ cursor, limit: flags.limit ?? DEFAULT_LIMIT, timeRange })
          .catch((error: unknown): never => {
            // An unparseable user --query is a user input mistake, not a CLI bug.
            throw toSearchQueryError(error, flags.query);
          }),
    );

    advancePaginationState(PAGINATION_KEY, contextKey, direction, nextCursor);
    const hasPrev = hasPreviousPage(PAGINATION_KEY, contextKey);
    const hasMore = !!nextCursor;

    const baseTarget = project ? `${org}/${project}` : `${org}/`;
    const hintFlags = { ...flags, dataset, period: timeRange };
    const nav = paginationHint({
      hasPrev,
      hasMore,
      prevHint: appendFlagHints(
        `sentry explore ${baseTarget} -c prev`,
        hintFlags,
      ),
      nextHint: appendFlagHints(
        `sentry explore ${baseTarget} -c next`,
        hintFlags,
      ),
    });

    const hint = buildResultHint(response.data.length, nav);

    yield new CommandOutput({
      data: response.data,
      meta: response.meta,
      hasMore,
      hasPrev,
      nextCursor,
      dataset,
      org,
      project,
      requestedFields: fieldList,
    });
    return { hint };
  },
});
