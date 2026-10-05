/**
 * sentry explore
 *
 * Query aggregate event data using the Sentry Explore/Events API.
 * Supports arbitrary fields, aggregates, and datasets for spike analysis
 * and ad-hoc event queries.
 */

import type { SentryContext } from "../context.js";
import {
  isReplaySortValue,
  listReplays,
  queryEvents,
  queryMetricsMeta,
} from "../lib/api-client.js";
import { buildProjectQuery, validateLimit } from "../lib/arg-parsing.js";
import {
  advancePaginationState,
  buildPaginationContextKey,
  hasPreviousPage,
  resolveCursor,
} from "../lib/db/pagination.js";
import { toSearchQueryError, ValidationError } from "../lib/errors.js";
import { filterFields } from "../lib/formatters/json.js";
import { buildMetaColumns } from "../lib/formatters/meta-table.js";
import { CommandOutput } from "../lib/formatters/output.js";
import { formatTable } from "../lib/formatters/table.js";
import {
  appendQueryHint,
  appendSortHint,
  buildListCommand,
  LIST_MAX_LIMIT,
  PERIOD_ALIASES,
  paginationHint,
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
import { resolveOrgOptionalFromArg } from "../lib/resolve-target.js";
import { sanitizeQuery } from "../lib/search-query.js";
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
const IS_TRANSACTION_FILTER_PATTERN = /(?:^|\s)is_transaction:true(?:\s|$)/;

/** Default dataset */
const DEFAULT_DATASET = "errors";
const DEFAULT_REPLAY_SORT = "-started_at";

/** Default time period */
const DEFAULT_PERIOD = "24h";

/** Command key for pagination cursor storage */
const PAGINATION_KEY = "explore";

/**
 * Dataset aliases: user-facing name → API-level dataset name.
 *
 * All entries are accepted as `--dataset` values. `VALID_DATASETS` controls
 * which appear in `--help` and validation error messages.
 */
const DATASET_ALIASES: Record<string, string> = {
  errors: "errors",
  error: "errors",
  spans: "spans",
  span: "spans",
  metrics: "tracemetrics",
  logs: "logs",
  log: "logs",
  replays: "replays",
  replay: "replays",
};

/**
 * User-facing dataset names shown in `--help` and validation errors.
 *
 * Set preserves insertion order for the join-based help/error rendering.
 */
const VALID_DATASETS = new Set([
  "errors",
  "spans",
  "metrics",
  "logs",
  "replays",
]);

/**
 * Reverse map from API-level dataset name → canonical user-facing name.
 * Used by pagination hints so they emit `--dataset metrics` not `--dataset tracemetrics`.
 */
const API_TO_USER_DATASET = new Map(
  Array.from(VALID_DATASETS, (name) => [DATASET_ALIASES[name] ?? name, name])
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
  readonly limit: number;
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
 * Parse and validate dataset flag value.
 * Accepts canonical names and common aliases.
 */
function parseDataset(value: string): string {
  const lower = value.toLowerCase();
  const resolved = DATASET_ALIASES[lower];
  if (resolved || LEGACY_TRANSACTION_DATASETS.has(lower)) {
    return resolved ?? lower;
  }
  throw new ValidationError(
    `Invalid dataset "${value}". Must be one of: ${Array.from(VALID_DATASETS).join(", ")}`,
    "dataset"
  );
}

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
  replays: Awaited<ReturnType<typeof listReplays>>["data"]
): { data: Record<string, unknown>[]; meta: NonNullable<ExploreData["meta"]> } {
  return {
    data: replays.map((replay) =>
      Object.fromEntries(
        fields.map((field) => [field, getReplayFieldValue(replay, field)])
      )
    ),
    meta: {
      fields: Object.fromEntries(
        fields.map((field) => [field, inferReplayFieldType(field)])
      ),
      units: Object.fromEntries(
        fields.map((field) => [field, field === "duration" ? "s" : null])
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
  data: ExploreData
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
function formatExploreHuman(data: ExploreData): string {
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
    data.meta?.units
  );

  const scope = data.project ? `${data.org}/${data.project}` : data.org;
  const displayDataset = API_TO_USER_DATASET.get(data.dataset) ?? data.dataset;
  const header = `Querying ${displayDataset} in ${scope}:\n\n`;
  return header + formatTable(data.data, columns);
}

/** Transform explore results for JSON output */
function jsonTransformExplore(data: ExploreData, fields?: string[]): unknown {
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

/** Default limit value matching the flag default for hint comparison */
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
  agg: string
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
  metricActive: boolean
): void {
  const fields = rawFields ?? [];
  const fieldList = metricActive
    ? fields.filter((f) => !isAggregate(f))
    : fields;
  const defaults = defaultFieldsForDataset(dataset).join(",");
  if (fieldList.join(",") !== defaults && fieldList.length > 0) {
    for (const f of fieldList) {
      parts.push(`-F "${f}"`);
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
  >
): string {
  const parts: string[] = [];
  const defaultSort =
    flags.dataset === "replays" ? DEFAULT_REPLAY_SORT : undefined;
  if (flags.dataset !== DEFAULT_DATASET) {
    // Emit user-facing name, not API-level name (e.g. "metrics" not "tracemetrics")
    const displayDataset =
      API_TO_USER_DATASET.get(flags.dataset) ?? flags.dataset;
    parts.push(`--dataset ${displayDataset}`);
  }
  appendMetricHints(parts, flags.metric, flags.agg);
  appendSortHint(parts, flags.sort, defaultSort);
  appendQueryHint(parts, flags.query);
  appendFieldHints(parts, flags.field, flags.dataset, !!flags.metric);
  if (flags.limit !== DEFAULT_LIMIT) {
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
 * Detect the first aggregate function in the field list.
 * Aggregates contain parentheses, e.g., `count()`, `p50(span.duration)`.
 */
function findFirstAggregate(fieldList: string[]): string | undefined {
  return fieldList.find((f) => f.includes("(") && f.includes(")"));
}

/** True when the field looks like an aggregate call: `fn(...)`. */
function isAggregate(field: string): boolean {
  return field.includes("(") && field.endsWith(")");
}

/**
 * True when the aggregate uses the tracemetrics comma-separated format:
 * `aggregation(value,metric_name,metric_type,unit)`.
 */
function isTracemetricsAggregate(aggregate: string): boolean {
  const parenIdx = aggregate.indexOf("(");
  if (parenIdx < 0) {
    return false;
  }
  const inner = aggregate.slice(parenIdx + 1, -1);
  return inner.startsWith("value,") && inner.split(",").length === 4;
}

/**
 * Validate that aggregate fields use the tracemetrics format when querying
 * the `tracemetrics` dataset. Standard aggregates like `count()` or
 * `avg(measurements.fcp)` are invalid — the API requires the four-part
 * comma-separated format: `aggregation(value,metric_name,metric_type,unit)`.
 */
function validateMetricsFields(fieldList: string[]): void {
  const badAggs = fieldList.filter(
    (f) => isAggregate(f) && !isTracemetricsAggregate(f)
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
    "field"
  );
}

// ---------------------------------------------------------------------------
// Dataset configuration
// ---------------------------------------------------------------------------

/**
 * Datasets whose Events endpoint accepts a `sort` param. A deterministic sort
 * is what makes offset-based cursor pagination stable — without it, multi-page
 * grouped aggregate queries overlap and skip rows (#1519). `metrics`
 * (`tracemetrics`) and `logs` reject `sort` with a 400, so they stay unsorted.
 *
 * This is a hand-curated contract, not a machine-readable capability lookup,
 * because no canonical source for it exists today (#1523):
 *   - The OpenAPI spec (`@sentry/api` `listOrganizationEvents`) models `sort`
 *     as a flat query param whose only documented constraint is "must be in
 *     the `field` list" — it does not encode which datasets accept it.
 *   - There is no dataset-capability introspection endpoint in the spec.
 *   - The spec's `dataset` enum is
 *     `errors | logs | profile_functions | spans | tracemetrics |
 *     uptime_results`; `discover` is a legacy virtual dataset that is not a
 *     valid `--dataset` value here (see {@link DATASET_ALIASES}), so it is
 *     intentionally omitted.
 * Revisit if Sentry ever publishes a per-dataset capability contract.
 */
const SORTABLE_DATASETS = new Set(["spans", "errors"]);

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
  environment: string[] | undefined
): string | undefined {
  if (!environment || environment.length === 0) {
    return;
  }
  if (environment.length === 1) {
    return `environment:${environment[0]}`;
  }
  return `environment:[${environment.join(",")}]`;
}

function resolveEventsDataset(dataset: string, query: string | undefined) {
  if (!LEGACY_TRANSACTION_DATASETS.has(dataset)) {
    return { dataset, query };
  }
  if (IS_TRANSACTION_FILTER_PATTERN.test(query ?? "")) {
    return { dataset: "spans", query };
  }
  return {
    dataset: "spans",
    query: [query, IS_TRANSACTION_FILTER].filter(Boolean).join(" "),
  };
}

/**
 * Resolve dataset-specific configuration: sort, query, validation, and fetch.
 *
 * For the `replays` dataset this validates fields, resolves replay-specific
 * sort, and returns a fetch function that calls `listReplays`. For all other
 * datasets it translates `--environment` values into `environment:...` query
 * filter terms, resolves explore sort (spans-only), prepends `project:<slug>`
 * to the query, and returns a `queryEvents` fetch.
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
    const unsupportedField = fieldList.find(
      (field) => !isSupportedReplayField(field)
    );
    if (unsupportedField) {
      throw new ValidationError(
        `Unsupported replay field "${unsupportedField}". Supported fields include: ${listSupportedReplayFields().slice(0, 12).join(", ")}...`,
        "field"
      );
    }

    const sort = flags.sort ?? DEFAULT_REPLAY_SORT;
    if (!isReplaySortValue(sort)) {
      throw new ValidationError(
        `Invalid replay sort "${sort}". Use a replay sort like ${DEFAULT_REPLAY_SORT} or -count_errors.`,
        "sort"
      );
    }

    return {
      sort,
      query: flags.query,
      fetch: async ({ cursor, limit, timeRange }) => {
        const replayResponse = await listReplays(org, {
          cursor,
          environment,
          fields: getReplayRequestFields(fieldList),
          limit,
          projectSlugs: project ? [project] : undefined,
          query: flags.query,
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
  const envPrefix = buildEnvironmentQuery(environment);
  const resolved = resolveEventsDataset(dataset, flags.query);
  const queryWithEnv =
    [envPrefix, resolved.query].filter(Boolean).join(" ") || undefined;

  const firstAgg = findFirstAggregate(fieldList);
  const rawSort = flags.sort ?? (firstAgg ? `-${firstAgg}` : undefined);
  let sort: string | undefined;
  if (SORTABLE_DATASETS.has(resolved.dataset)) {
    // A deterministic sort is required for correct cursor pagination: the
    // events cursor is offset-based, so without a stable total order the
    // separate page requests overlap and skip rows, producing duplicate and
    // missing dimension tuples across the merged result (#1519). Defaulting
    // to `-<firstAggregate>` gives grouped aggregate queries a stable order.
    sort = rawSort;
  } else {
    // Warn only when the user explicitly passed --sort on a dataset that
    // rejects it (metrics/logs). An auto-derived sort is silently dropped.
    if (rawSort && flags.sort) {
      const displayDataset = API_TO_USER_DATASET.get(dataset) ?? dataset;
      log.warn(
        `--sort is not supported on the ${displayDataset} dataset. Ignoring sort.`
      );
    }
    sort = undefined;
  }

  const query = buildProjectQuery(queryWithEnv, project);
  return {
    sort,
    query,
    fetch: async ({ cursor, limit, timeRange }) =>
      queryEvents(org, {
        fields: fieldList,
        dataset: resolved.dataset,
        query,
        sort,
        limit,
        cursor,
        ...timeRangeToApiParams(timeRange),
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
      "and equations. Results are returned as a table.\n\n" +
      "Datasets:\n" +
      "  errors   Error events (default)\n" +
      "  spans    Span data\n" +
      "  metrics  Custom metrics (tracemetrics format)\n" +
      "  logs     Log entries\n" +
      "  replays  Session replay search\n\n" +
      "Targets:\n" +
      "  <org>/<project>  Filter by project (auto-adds project:<slug> to query)\n" +
      "  <org>/           All projects in org\n" +
      "  <project>        Bare slug — searches across orgs\n" +
      "  (omitted)        Auto-detect from DSN/config\n\n" +
      "Examples:\n" +
      '  sentry explore my-org/cli -F title -F "count()"\n' +
      '  sentry explore my-org/ -F title -F "count()" -F "count_unique(user)" --period 1h\n' +
      '  sentry explore my-org/cli -F span.op -F "p50(span.duration)" ' +
      "--dataset spans\n" +
      "  sentry explore my-org/cli --dataset replays -F id -F user.email -F count_errors\n" +
      '  sentry explore -F span.op -F "count()" --dataset spans --period 1h\n' +
      "  sentry explore --json\n\n" +
      "Metrics (auto mode — resolves type/unit automatically):\n" +
      "  sentry explore my-org/ -m llm.token_usage --dataset metrics\n" +
      "  sentry explore my-org/seer -F gen_ai.request.model -m llm.token_usage --dataset metrics --period 7d\n" +
      "  sentry explore my-org/ -m cache.hit_rate --agg avg --dataset metrics",
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
          brief:
            "Target: <org>/<project>, <org>/, or <project>. Auto-detected if omitted.",
          parse: String,
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
        parse: parseDataset,
        brief: `Dataset to query (${[...VALID_DATASETS].join(", ")}; transaction(s) routes to spans)`,
        default: DEFAULT_DATASET,
      },
      query: {
        kind: "parsed",
        parse: sanitizeQuery,
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
        brief: `Number of rows (1-${LIST_MAX_LIMIT})`,
        default: "25",
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
    },
  },
  async *func(this: SentryContext, flags: ExploreFlags, target?: string) {
    const { cwd } = this;
    const { org, project } = await resolveOrgOptionalFromArg(
      target,
      cwd,
      "explore"
    );

    let dataset = flags.dataset;
    const userSuppliedFields = flags.field && flags.field.length > 0;
    let fieldList = [...defaultFieldsForDataset(dataset)];
    if (userSuppliedFields) {
      fieldList = flags.field;
    }
    const timeRange = flags.period;
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
          })
      );

      const aggField = resolveMetricField(flags.metric, flags.agg, metrics);
      // Prepend any user-supplied grouping fields, then the resolved aggregate
      const groupByFields = userSuppliedFields
        ? fieldList.filter((f) => !isAggregate(f))
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
          "field"
        );
      }
      validateMetricsFields(fieldList);
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
      }
    );
    const { cursor, direction } = resolveCursor(
      flags.cursor,
      PAGINATION_KEY,
      contextKey
    );

    const { data: response, nextCursor } = await withProgress(
      {
        message: `Querying ${dataset} in ${project ? `${org}/${project}` : org}...`,
        json: flags.json,
      },
      () =>
        config
          .fetch({ cursor, limit: flags.limit, timeRange })
          .catch((error: unknown): never => {
            // An unparseable user --query is a user input mistake, not a CLI bug.
            throw toSearchQueryError(error, flags.query);
          })
    );

    advancePaginationState(PAGINATION_KEY, contextKey, direction, nextCursor);
    const hasPrev = hasPreviousPage(PAGINATION_KEY, contextKey);
    const hasMore = !!nextCursor;

    const baseTarget = project ? `${org}/${project}` : `${org}/`;
    const hintFlags = { ...flags, dataset };
    const nav = paginationHint({
      hasPrev,
      hasMore,
      prevHint: appendFlagHints(
        `sentry explore ${baseTarget} -c prev`,
        hintFlags
      ),
      nextHint: appendFlagHints(
        `sentry explore ${baseTarget} -c next`,
        hintFlags
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
