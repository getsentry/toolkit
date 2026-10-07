import { getActiveSpan } from "@sentry/core";
import { z } from "zod";
import { setTargetTagsAndAttributes } from "../../../telem/scope";
import { UserInputError } from "../../../errors";
import { hasAgentProvider } from "../../../internal/agents/provider-factory";
import { withProviderFallback } from "../../../internal/agents/provider-fallback";
import { apiServiceFromContext } from "../../../internal/tool-helpers/api";
import {
  ParamOrganizationSlug,
  ParamPeriod,
  ParamProjectSlug,
  ParamRegionUrl,
} from "../../../schema";
import { logWarn } from "../../../telem/logging";
import { scrubSensitiveText } from "../../../telem/sentry";
import type { Scope } from "../../../permissions";
import type { Skill } from "../../../skills";
import type { ServerContext } from "../../../types";
import {
  isMetricsDataset,
  normalizeEventsDataset,
  PUBLIC_EVENTS_DATASETS,
  type PublicEventsDataset,
} from "../../../utils/events-datasets";
import { extractConversationIdFromSearchQuery } from "../../../utils/url-utils";
import {
  fetchEnvironmentNames,
  searchEventsAgent,
  type searchEventsAgentOutputSchema,
} from "./agent";
import {
  RECOMMENDED_FIELDS,
  TRACE_METRICS_SAMPLE_IDENTITY_FIELDS,
} from "./config";
import {
  formatErrorResults,
  formatLogResults,
  formatProfileResults,
  formatSpanResults,
  formatTimeSeriesResults,
  formatTraceMetricsResults,
} from "./formatters";
import {
  DEFAULT_REPLAY_SORT,
  DEFAULT_REPLAY_STATS_PERIOD,
  formatReplayResults,
  isValidReplaySort,
} from "./replays";
import { isSeerSearchDataset, translateWithSeer } from "./seer";
import {
  formatEventsValidationResults,
  isAggregateQuery,
  isSemanticFilterDowngrade,
  looksLikeSentrySearchSyntax,
  recordEventsSearchValidationTelemetry,
  validateEventsSearch,
} from "./utils";

export const SEARCH_EVENTS_DATASETS = [
  ...PUBLIC_EVENTS_DATASETS,
  "replays",
] as const;
const DEFAULT_EVENTS_SORT = "-timestamp";

type SearchEventsAgentResult = z.output<typeof searchEventsAgentOutputSchema>;

function defaultSortForDataset(dataset: PublicEventsDataset | "replays") {
  return dataset === "replays" ? DEFAULT_REPLAY_SORT : DEFAULT_EVENTS_SORT;
}

function defaultFieldsForDataset(dataset: PublicEventsDataset): string[] {
  return RECOMMENDED_FIELDS[normalizeEventsDataset(dataset)].basic;
}

function resolveEventFields({
  dataset,
  explicitFields,
  agentFields,
  trustExplicitFields,
}: {
  dataset: PublicEventsDataset;
  explicitFields?: string[] | null;
  agentFields?: string[];
  trustExplicitFields: boolean;
}): string[] {
  if (trustExplicitFields && explicitFields && explicitFields.length > 0) {
    return explicitFields;
  }
  if (agentFields && agentFields.length > 0) {
    return agentFields;
  }
  return defaultFieldsForDataset(dataset);
}

function parseAgentTimeRange(
  timeRange: unknown,
): { statsPeriod?: string; start?: string; end?: string } | undefined {
  if (typeof timeRange !== "object" || timeRange === null) {
    return undefined;
  }

  if ("statsPeriod" in timeRange && typeof timeRange.statsPeriod === "string") {
    return { statsPeriod: timeRange.statsPeriod };
  }
  if (
    "start" in timeRange &&
    "end" in timeRange &&
    typeof timeRange.start === "string" &&
    typeof timeRange.end === "string"
  ) {
    return { start: timeRange.start, end: timeRange.end };
  }

  return undefined;
}

function augmentFieldsWithSort(fields: string[], sort: string): string[] {
  const sortField = sort.startsWith("-") ? sort.slice(1) : sort;
  const sortIsAggregate = sortField.includes("(") && sortField.includes(")");
  if (
    sortField &&
    !fields.includes(sortField) &&
    (sortIsAggregate || !isAggregateQuery(fields))
  ) {
    return [...fields, sortField];
  }
  return fields;
}

function buildRequestFields(
  dataset: PublicEventsDataset | "replays",
  fields: string[],
): string[] {
  return dataset !== "replays" &&
    isMetricsDataset(dataset) &&
    !isAggregateQuery(fields)
    ? Array.from(new Set([...fields, ...TRACE_METRICS_SAMPLE_IDENTITY_FIELDS]))
    : fields;
}

function isTraceItemDataset(dataset: PublicEventsDataset | "replays"): boolean {
  return dataset === "spans" || dataset === "logs" || dataset === "metrics";
}

function hasFields(fields?: string[] | null): fields is string[] {
  return Array.isArray(fields) && fields.length > 0;
}

function formatSearchValue(value: string): string {
  return /^[^\s"',[\]]+$/.test(value) ? value : JSON.stringify(value);
}

function formatEnvironmentFilter(
  environment?: string | string[] | null,
): string | undefined {
  if (!environment) {
    return undefined;
  }

  const environments = Array.isArray(environment) ? environment : [environment];
  if (environments.length === 0) {
    return undefined;
  }
  if (environments.length === 1) {
    const environmentValue = environments[0];
    return environmentValue === undefined
      ? undefined
      : `environment:${formatSearchValue(environmentValue)}`;
  }
  return `environment:[${environments.map(formatSearchValue).join(",")}]`;
}

function appendSearchFilter(query: string, filter?: string): string {
  const trimmedQuery = query.trim();
  if (!filter) {
    return trimmedQuery;
  }
  if (tokenizeSearchQuery(trimmedQuery).includes(filter)) {
    return trimmedQuery;
  }
  return [trimmedQuery, filter].filter(Boolean).join(" ");
}

/**
 * Collect the environment names a search actually filters on — from both the
 * separate `environment` field and any `environment:` token in the query string.
 * Sentry only validates the former against real environments, so a bad value in
 * the query (e.g. a typo) otherwise slips through and silently returns nothing.
 */
export function collectRequestedEnvironments(
  environment: string | string[] | null | undefined,
  query: string,
): string[] {
  const values: string[] = [];
  if (typeof environment === "string") {
    values.push(environment);
  } else if (Array.isArray(environment)) {
    values.push(...environment);
  }
  // Tokenize (quote/escape-aware) and only take tokens that ARE an `environment:`
  // filter, so dotted keys like `deployment.environment:` and `environment:`
  // inside quoted text (e.g. a message value) aren't mistaken for a filter.
  const tokens = tokenizeSearchQuery(query);
  for (let i = 0; i < tokens.length; i++) {
    const match = /^environment:(.*)$/is.exec(tokens[i]);
    if (!match) {
      continue;
    }
    let value = match[1];
    // An IN-list (`environment:[a, b]`) can be split across tokens on its
    // internal spaces; rejoin following tokens until the list is closed.
    while (
      value.startsWith("[") &&
      !value.includes("]") &&
      i + 1 < tokens.length
    ) {
      value += ` ${tokens[++i]}`;
    }
    const inner =
      value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
    for (const part of inner.split(",")) {
      const cleaned = part.trim().replace(/^["']|["']$/g, "");
      if (cleaned) {
        values.push(cleaned);
      }
    }
  }
  return values;
}

/**
 * Note listing the org's real environments when a search references one that
 * doesn't exist, so the caller can retry with a valid name. We don't guess a
 * match — the calling agent maps from the list.
 */
export function formatUnknownEnvironmentNote(
  unknown: string[],
  available: string[],
): string {
  const uniqueUnknown = [...new Set(unknown)].map((name) => `\`${name}\``);
  const shown = available.slice(0, 50).map((name) => `\`${name}\``);
  const more =
    available.length > shown.length ? ` (${available.length} total)` : "";
  const label = uniqueUnknown.length === 1 ? "environment" : "environments";
  return `> ⚠️ Requested ${label} not found in this organization: ${uniqueUnknown.join(", ")}. Available environments: ${shown.join(", ")}${more}. Re-run filtering by one of these, or omit the environment to search all.`;
}

function applyEnvironmentToEventsQuery(
  dataset: PublicEventsDataset | "replays",
  query: string,
  environment?: string | string[] | null,
): string {
  if (dataset === "replays") {
    return query;
  }
  return appendSearchFilter(query, formatEnvironmentFilter(environment));
}

function tokenizeSearchQuery(query: string): string[] {
  const tokens: string[] = [];
  let currentToken = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of query) {
    if (escaped) {
      currentToken += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      currentToken += char;
      escaped = true;
      continue;
    }

    if (quote) {
      currentToken += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      currentToken += char;
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (currentToken) {
        tokens.push(currentToken);
        currentToken = "";
      }
      continue;
    }

    currentToken += char;
  }

  if (currentToken) {
    tokens.push(currentToken);
  }

  return tokens;
}

function containsSearchToken(query: string, token: string): boolean {
  const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${escapedToken}(?=\\s|$)`).test(query);
}

function preservesSearchTokens(originalQuery: string, repairedQuery: string) {
  return tokenizeSearchQuery(originalQuery).every((token) =>
    containsSearchToken(repairedQuery, token),
  );
}

function choosePreservingRepairedQuery(params: {
  originalQuery: string;
  repairedQuery?: string | null;
  filter?: string;
}): string {
  const originalQuery = params.originalQuery.trim();
  const repairedQuery = params.repairedQuery?.trim();
  if (!repairedQuery) {
    return appendSearchFilter(originalQuery, params.filter);
  }

  if (isSemanticFilterDowngrade(originalQuery, repairedQuery)) {
    return appendSearchFilter(originalQuery, params.filter);
  }

  if (!originalQuery || preservesSearchTokens(originalQuery, repairedQuery)) {
    return appendSearchFilter(repairedQuery, params.filter);
  }

  return appendSearchFilter(originalQuery, params.filter);
}

function buildAgentPrompt(params: {
  query?: string;
  dataset: PublicEventsDataset | "replays";
  lockDataset?: boolean;
  fields?: string[] | null;
  sort?: string | null;
  statsPeriod?: string;
  environment?: string | string[] | null;
}): string {
  return [
    "Translate this Sentry event search request.",
    "The query may be natural language or already-valid Sentry search syntax.",
    params.lockDataset
      ? `The dataset is fixed to ${params.dataset} by the calling tool. Keep dataset=${params.dataset} and build the query, fields, and sort for it. Preserve valid explicit parameters, but correct query syntax, fields, sort, and time range when they conflict or would fail.`
      : "Preserve valid explicit parameters, but correct dataset, query syntax, fields, sort, and time range when they conflict or would fail.",
    "If the user query already uses Sentry search syntax, treat its filters as authoritative unless validateSearch proves a field is invalid.",
    "Never replace a structured field filter with message/log.body/full-text matching. If no valid attribute exists for an explicit field:value filter, keep the field and let validation fail.",
    "For spans, logs, and metrics, use datasetAttributes to discover likely fields with substringMatch, query, and attributeTypes before dropping or renaming explicit fields.",
    "A broad datasetAttributes result may be truncated, so absence from that preview does not prove an explicit field is invalid.",
    "For non-replay datasets, call validateSearch on the candidate request and fix failures in this same pass before returning.",
    "For non-replay datasets, convert environment parameters into query filters. For replays, keep environment in the separate environment parameter.",
    "",
    `User query: ${params.query || "(empty)"}`,
    "Current parameters:",
    JSON.stringify(
      {
        dataset: params.dataset,
        fields: params.fields ?? null,
        sort: params.sort ?? null,
        statsPeriod: params.statsPeriod ?? null,
        environment: params.environment ?? null,
      },
      null,
      2,
    ),
  ].join("\n");
}

export type SearchEventsDataset = (typeof SEARCH_EVENTS_DATASETS)[number];

export interface SearchEventsParams {
  organizationSlug: string;
  dataset?: SearchEventsDataset;
  query?: string;
  fields?: string[] | null;
  sort?: string | null;
  projectSlug: string | null;
  environment?: string | string[];
  period?: string;
  regionUrl: string | null;
  limit: number;
  includeExplanation: boolean;
}

export interface RunSearchEventsOptions {
  /**
   * Keep the caller's dataset even when the embedded agent suggests another.
   * Dataset-specific tools (search_logs, search_traces, ...) set this so a
   * search never returns rows from a different dataset than the tool name.
   */
  lockDataset?: boolean;
}

const searchLimitParam = z
  .number()
  .min(1)
  .max(100)
  .default(10)
  .describe("Maximum number of results to return (1-100)");

const includeExplanationParam = z
  .boolean()
  .default(false)
  .describe("Include explanation of how the query was translated or repaired");

const environmentParam = (description: string) =>
  z
    .union([z.string().trim().min(1), z.array(z.string().trim().min(1)).min(1)])
    // Keep optional (omit when unused). Do not add .nullable(): Zod emits nested
    // anyOf for union+null, which some model APIs reject on tool schemas.
    .optional()
    .describe(description);

/**
 * Input schema for the legacy multi-dataset search_events tool.
 */
export function buildSearchEventsInputSchema() {
  return {
    organizationSlug: ParamOrganizationSlug,
    dataset: z
      .enum(SEARCH_EVENTS_DATASETS)
      .optional()
      .describe(
        "Initial dataset hint: errors, logs, spans, metrics, profiles, or replays. Always pass it, including for natural language queries. The agent may correct it when configured.",
      ),
    query: z
      .string()
      .trim()
      .optional()
      .describe("Natural language or Sentry event search query syntax."),
    fields: z
      .array(z.string())
      .nullable()
      .optional()
      .describe(
        "Fields to return for event datasets. If not specified, uses sensible defaults. Include aggregate functions like count(), avg() for statistics. Leave null for dataset='replays'.",
      ),
    sort: z
      .string()
      .trim()
      .nullable()
      .optional()
      .describe(
        "Sort field (prefix with - for descending). If omitted, event datasets default to -timestamp and replays default to -started_at. Use -count() for event aggregations. For dataset='replays', use replay sorts like -started_at or -count_errors.",
      ),
    projectSlug: ParamProjectSlug.nullable().default(null),
    environment: environmentParam(
      "Optional environment filter for dataset='replays'. Use a string for one environment or an array for multiple. Omit when unused. For other datasets, filter environment in the query string instead.",
    ),
    period: ParamPeriod.optional(),
    regionUrl: ParamRegionUrl.nullable().default(null),
    limit: searchLimitParam,
    includeExplanation: includeExplanationParam,
  };
}

/**
 * Input schema for dataset-specific event tools (search_errors, search_logs,
 * search_traces, search_metrics, search_profiles). The dataset comes from the
 * tool, so there is no `dataset` parameter. Environment goes in the query.
 */
export function buildDatasetSearchInputSchema() {
  return {
    organizationSlug: ParamOrganizationSlug,
    query: z
      .string()
      .trim()
      .optional()
      .describe(
        "What to find, in natural language (preferred) or Sentry search syntax. Include environment, release, or other filters here.",
      ),
    fields: z
      .array(z.string())
      .nullable()
      .optional()
      .describe(
        "Fields to return. If not specified, uses sensible defaults. Include aggregate functions like count(), avg() for statistics.",
      ),
    sort: z
      .string()
      .trim()
      .nullable()
      .optional()
      .describe(
        "Sort field (prefix with - for descending). Defaults to -timestamp. Use -count() for aggregations.",
      ),
    projectSlug: ParamProjectSlug.nullable().default(null),
    period: ParamPeriod.optional(),
    regionUrl: ParamRegionUrl.nullable().default(null),
    limit: searchLimitParam,
    includeExplanation: includeExplanationParam,
  };
}

/**
 * Input schema for search_replays. Replays return lists only, so there are no
 * fields, and environment is a separate parameter.
 */
export function buildReplaySearchInputSchema() {
  return {
    organizationSlug: ParamOrganizationSlug,
    query: z
      .string()
      .trim()
      .optional()
      .describe(
        "What to find, in natural language (preferred) or replay search syntax.",
      ),
    sort: z
      .string()
      .trim()
      .nullable()
      .optional()
      .describe(
        "Replay sort (prefix with - for descending): -started_at (default), -count_errors, -count_rage_clicks, or -duration.",
      ),
    projectSlug: ParamProjectSlug.nullable().default(null),
    environment: environmentParam(
      "Optional environment filter. Use a string for one environment or an array for multiple. Omit when unused.",
    ),
    period: ParamPeriod.optional(),
    regionUrl: ParamRegionUrl.nullable().default(null),
    limit: searchLimitParam,
    includeExplanation: includeExplanationParam,
  };
}

export const SEARCH_EVENTS_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
};

/**
 * Shared config for search_events and the dataset-specific search tools.
 */
export function searchToolBase(toolName: string): {
  skills: Skill[];
  requiredScopes: Scope[];
  annotations: typeof SEARCH_EVENTS_ANNOTATIONS;
  onError(
    error: unknown,
    params: Record<string, unknown>,
    context: ServerContext,
  ): void;
} {
  return {
    skills: ["inspect", "triage", "seer"],
    requiredScopes: ["event:read"],
    annotations: SEARCH_EVENTS_ANNOTATIONS,
    onError(error, params, context) {
      logSearchEventsError(toolName, error, params, context);
    },
  };
}

// Log the failing query and how it failed so we can see which real queries
// fail (the failure surfaces as a UserInputError that isn't reported to
// Sentry). Scrubbed here so tokens/emails don't reach any log sink.
export function logSearchEventsError(
  toolName: string,
  error: unknown,
  params: Record<string, unknown>,
  context: ServerContext,
): void {
  const query = params.query;
  logWarn(`${toolName} query failed`, {
    loggerScope: ["tools", toolName],
    extra: {
      errorName: error instanceof Error ? error.name : typeof error,
      // The message distinguishes causes that share a name (e.g.
      // UserInputError: no-output vs validation vs provider outage).
      errorMessage: scrubSensitiveText(
        error instanceof Error ? error.message : String(error),
      ),
      organizationSlug:
        (typeof params.organizationSlug === "string"
          ? params.organizationSlug
          : null) ?? context.constraints.organizationSlug,
      query: typeof query === "string" ? scrubSensitiveText(query) : null,
    },
  });
}

/**
 * Shared handler for search_events and the dataset-specific search tools.
 */
export async function runSearchEvents(
  params: SearchEventsParams,
  context: ServerContext,
  options: RunSearchEventsOptions = {},
): Promise<string> {
  const lockDataset = options.lockDataset === true;
  const apiService = apiServiceFromContext(context, {
    regionUrl: params.regionUrl ?? undefined,
  });
  const organizationSlug = params.organizationSlug;

  setTargetTagsAndAttributes(params);

  const inputDataset = params.dataset ?? "errors";
  const hasStructuredQuery = looksLikeSentrySearchSyntax(params.query);
  const canApplyEnvironmentFilter =
    inputDataset !== "replays" &&
    isTraceItemDataset(inputDataset) &&
    hasStructuredQuery;

  let projectId: string | undefined;
  if (params.projectSlug) {
    const project = await apiService.getProject({
      organizationSlug,
      projectSlugOrId: params.projectSlug,
    });
    projectId = String(project.id);
  }

  let dataset: PublicEventsDataset | "replays";
  let sentryQuery: string;
  let fields: string[];
  let sortParam: string;
  let timeParams: { statsPeriod?: string; start?: string; end?: string };
  let explanation: string | undefined;
  let environment: string | string[] | null | undefined = params.environment;
  let timeSeries: { yAxis: string; interval: string | null } | null = null;

  const explicitSort = params.sort?.trim() || undefined;
  const hasExplicitDataset = params.dataset !== undefined;
  const hasExplicitFields = hasFields(params.fields);
  const hasExplicitSort = explicitSort !== undefined;
  const hasExplicitPeriod = params.period !== undefined;
  const hasExplicitTraceItemDataset =
    hasExplicitDataset && isTraceItemDataset(inputDataset);
  const shouldTrustStructuredTraceSearch =
    hasStructuredQuery && hasExplicitTraceItemDataset;
  const environmentFilter = formatEnvironmentFilter(params.environment);
  const explicitStructuredTraceQuery = shouldTrustStructuredTraceSearch
    ? appendSearchFilter(params.query ?? "", environmentFilter)
    : (params.query ?? "");
  const canRunWithoutAgent =
    shouldTrustStructuredTraceSearch && hasExplicitFields && hasExplicitSort;

  // Fetch the org's real environments once: used to ground the agent prompt
  // (below) and to flag any requested environment that doesn't exist. Skipped
  // only when nothing references an environment — including a structured query
  // that skips the agent but puts `environment:` in the query string.
  // Seer only translates into the dataset it is given, so it runs only when
  // one is explicit. It only sees the natural language query, so skip it for
  // structured queries and explicit fields or sort, which the embedded agent
  // preserves. Like the UI, an explicit environment is added to Seer's query
  // afterwards.
  const seerTranslation =
    params.query &&
    isSeerSearchDataset(params.dataset) &&
    !hasStructuredQuery &&
    !hasExplicitFields &&
    !hasExplicitSort
      ? await translateWithSeer({
          apiService,
          organizationSlug,
          projectId,
          dataset: params.dataset,
          query: params.query,
        })
      : null;
  if (seerTranslation && !projectId) {
    projectId = "-1";
  }

  if (
    !hasAgentProvider() &&
    inputDataset !== "replays" &&
    params.environment &&
    !canApplyEnvironmentFilter &&
    !seerTranslation
  ) {
    throw new UserInputError(
      "The `environment` parameter is only supported for dataset='replays'. For other datasets, include environment filtering in the query string instead.",
    );
  }

  const willRunAgent =
    hasAgentProvider() && !canRunWithoutAgent && !seerTranslation;
  const inputReferencesEnvironment =
    params.environment != null ||
    collectRequestedEnvironments(null, params.query ?? "").length > 0;
  const environmentNames =
    willRunAgent || inputReferencesEnvironment
      ? await fetchEnvironmentNames({
          apiService,
          organizationSlug,
          projectId,
        })
      : [];
  const knownEnvironments = new Set(
    environmentNames.map((name) => name.toLowerCase()),
  );

  if (seerTranslation) {
    dataset = inputDataset;
    sentryQuery = seerTranslation.query;
    fields = seerTranslation.fields;
    sortParam = seerTranslation.sort;
    // Seer never sees `period`, so an explicit one wins over its time range.
    timeParams = hasExplicitPeriod
      ? { statsPeriod: params.period }
      : seerTranslation.timeParams;
    explanation = seerTranslation.explanation;
    timeSeries = seerTranslation.timeSeries;
  } else if (willRunAgent) {
    const parsed = await withProviderFallback<SearchEventsAgentResult>({
      operation: "search_events.rewrite",
      fallback: () => ({
        dataset: inputDataset,
        query: params.query ?? "",
        fields:
          inputDataset === "replays"
            ? []
            : (params.fields ?? defaultFieldsForDataset(inputDataset)),
        sort: explicitSort || defaultSortForDataset(inputDataset),
        environment: params.environment ?? null,
        timeSeries: null,
        timeRange: { statsPeriod: params.period ?? "14d" },
        explanation: "",
      }),
      run: async () =>
        (
          await searchEventsAgent({
            query: buildAgentPrompt({
              query: params.query,
              dataset: inputDataset,
              lockDataset,
              fields: params.fields,
              sort: params.sort,
              statsPeriod: params.period,
              environment: params.environment,
            }),
            organizationSlug,
            apiService,
            projectId,
            environmentNames,
          })
        ).result,
    });
    const shouldTrustExplicitSearchParams =
      shouldTrustStructuredTraceSearch ||
      (hasStructuredQuery && (lockDataset || parsed.dataset === inputDataset));

    timeSeries = parsed.timeSeries ?? null;

    // Time series requests use yAxis/interval, so sort is not required.
    if (
      !timeSeries &&
      !parsed.sort?.trim() &&
      !(shouldTrustExplicitSearchParams && hasExplicitSort)
    ) {
      throw new UserInputError(
        `Search Events Agent response missing required 'sort' parameter. Received: ${JSON.stringify(parsed, null, 2)}. The agent must specify how to sort results (e.g., '-timestamp' for newest first).`,
      );
    }

    // Dataset-specific tools never switch datasets, even if the agent asks.
    dataset =
      lockDataset || shouldTrustStructuredTraceSearch
        ? inputDataset
        : parsed.dataset;
    sentryQuery = shouldTrustStructuredTraceSearch
      ? choosePreservingRepairedQuery({
          originalQuery: params.query ?? "",
          repairedQuery: parsed.query,
          filter: environmentFilter,
        })
      : looksLikeSentrySearchSyntax(params.query) &&
          isSemanticFilterDowngrade(params.query ?? "", parsed.query || "")
        ? (params.query ?? "")
        : parsed.query || "";
    sortParam =
      shouldTrustExplicitSearchParams && explicitSort
        ? explicitSort
        : parsed.sort?.trim() || defaultSortForDataset(dataset);
    explanation = parsed.explanation;
    environment = params.environment ?? parsed.environment;

    timeParams =
      shouldTrustExplicitSearchParams && hasExplicitPeriod
        ? { statsPeriod: params.period }
        : (parseAgentTimeRange(parsed.timeRange) ?? { statsPeriod: "14d" });

    if (dataset === "replays") {
      fields = [];
    } else {
      fields = resolveEventFields({
        dataset,
        explicitFields: params.fields,
        agentFields: parsed.fields,
        trustExplicitFields: shouldTrustExplicitSearchParams,
      });
    }
  } else {
    dataset = inputDataset;
    sentryQuery = shouldTrustStructuredTraceSearch
      ? explicitStructuredTraceQuery
      : (params.query ?? "");
    sortParam = explicitSort || defaultSortForDataset(dataset);
    timeParams = { statsPeriod: params.period ?? "14d" };
    fields =
      dataset === "replays"
        ? []
        : (params.fields ?? defaultFieldsForDataset(dataset));
  }

  // Flag any requested environment that doesn't exist (checking both the
  // separate field and `environment:` tokens in the query) so the caller can
  // retry with a valid name instead of silently getting zero results.
  const unknownEnvironments =
    knownEnvironments.size > 0
      ? collectRequestedEnvironments(environment, sentryQuery).filter(
          (name) => !knownEnvironments.has(name.toLowerCase()),
        )
      : [];
  const environmentNote =
    unknownEnvironments.length > 0
      ? formatUnknownEnvironmentNote(unknownEnvironments, environmentNames)
      : "";
  // The caller chose the project (or the session is scoped to it), so Seer's
  // wider scope is only suggested. Scoped sessions can't change the project.
  const suggestedProjectIds = context.constraints.projectSlug
    ? []
    : (seerTranslation?.suggestedProjectIds ?? []);
  const projectSuggestionNote =
    suggestedProjectIds.length > 0
      ? `**Note:** Seer suggested also searching project IDs ${suggestedProjectIds.join(", ")}, for example other services in the same trace. Omit \`projectSlug\` to search all accessible projects.`
      : "";
  const leadingNote = [
    seerTranslation?.warning,
    environmentNote,
    projectSuggestionNote,
  ]
    .filter(Boolean)
    .join("\n\n");
  const withLeadingNote = (text: string): string =>
    leadingNote ? `${leadingNote}\n\n${text}` : text;

  if (dataset === "replays") {
    const replaySort = sortParam || DEFAULT_REPLAY_SORT;
    if (!isValidReplaySort(replaySort)) {
      throw new UserInputError(
        `Invalid replay sort "${replaySort}". Use a supported replay sort like ${DEFAULT_REPLAY_SORT}, -count_errors, -count_rage_clicks, or -duration.`,
      );
    }

    const replayTimeParams: {
      statsPeriod?: string;
      start?: string;
      end?: string;
    } = { ...timeParams };
    if (
      !replayTimeParams.statsPeriod &&
      !replayTimeParams.start &&
      !replayTimeParams.end
    ) {
      replayTimeParams.statsPeriod = DEFAULT_REPLAY_STATS_PERIOD;
    }

    const replays = await apiService.searchReplays({
      organizationSlug,
      query: sentryQuery,
      limit: params.limit,
      projectId,
      sort: replaySort,
      environment: environment ?? undefined,
      ...replayTimeParams,
    });

    const replaySearchUrl = apiService.getReplaysSearchUrl(organizationSlug, {
      query: sentryQuery || undefined,
      projectSlugOrId: projectId,
      environment: environment ?? undefined,
      sort: replaySort,
      ...replayTimeParams,
    });

    getActiveSpan()?.setAttribute(
      "gen_ai.tool.call.result.count",
      replays.length,
    );

    const replayOutput = formatReplayResults({
      replays,
      inputQuery: params.query || sentryQuery || "recent replays",
      includeExplanation: params.includeExplanation,
      organizationSlug,
      apiService,
      searchUrl: replaySearchUrl,
      replayQuery: sentryQuery,
      sort: replaySort,
      environment,
      explanation,
      timeRange: replayTimeParams,
      executedSearch: {
        dataset,
        query: sentryQuery,
        fields: [],
        sort: replaySort,
        timeRange: replayTimeParams,
      },
      experimentalMode: context.experimentalMode ?? false,
      availableToolNames: context.availableToolNames,
      directToolNames: context.directToolNames,
    });
    return withLeadingNote(replayOutput);
  }

  if (timeSeries) {
    const timeSeriesQuery = applyEnvironmentToEventsQuery(
      dataset,
      sentryQuery,
      environment,
    );
    // No validateEventsSearch here: it validates the /events/ (discover)
    // request shape — fields + orderby — which is not what a timeseries
    // sends (yAxis + interval, no fields/sort). events-stats validates the
    // query server-side, so a bad query still surfaces as an API error.
    const series = await apiService.getEventsTimeSeries({
      organizationSlug,
      query: timeSeriesQuery,
      yAxis: timeSeries.yAxis,
      interval: timeSeries.interval ?? undefined,
      projectId,
      dataset,
      ...timeParams,
    });
    const statsUrl = apiService.getEventsExplorerUrl(
      organizationSlug,
      timeSeriesQuery,
      projectId,
      dataset,
      [timeSeries.yAxis],
      `-${timeSeries.yAxis}`,
      [timeSeries.yAxis],
      [],
      timeParams.statsPeriod,
      timeParams.start,
      timeParams.end,
    );
    return withLeadingNote(
      formatTimeSeriesResults({
        series,
        yAxis: timeSeries.yAxis,
        interval: timeSeries.interval,
        inputQuery: params.query || timeSeriesQuery,
        includeExplanation: params.includeExplanation,
        explanation,
        timeRange: timeParams,
        url: statsUrl,
      }),
    );
  }

  // Sentry rejects the request if the sort column isn't in the selected
  // fields. The embedded agent's schema enforces this, but the handler can
  // recombine the caller's explicit fields with a default or explicit sort
  // that the agent never saw — so re-check here.
  //
  // Skip the augment when the sort is non-aggregate but the existing fields
  // are aggregate: adding a non-aggregate column to an aggregate query
  // changes the GROUP BY and silently corrupts the result. Better to let
  // Sentry's 400 propagate so the caller can fix the request explicitly.
  //
  // Note: fields and sortParam use the same function syntax sent to the API.
  fields = augmentFieldsWithSort(fields, sortParam);

  const requestFields = buildRequestFields(dataset, fields);

  // Final gate only. The agent should already have used validateSearch while
  // constructing the request; the handler does not run a second repair agent.
  sentryQuery = applyEnvironmentToEventsQuery(
    dataset,
    sentryQuery,
    environment,
  );
  const lastValidation = await validateEventsSearch(apiService, {
    organizationSlug,
    dataset,
    fields: requestFields,
    query: sentryQuery,
    sort: sortParam,
    projectId,
    environment: environment ?? undefined,
    ...timeParams,
  });
  recordEventsSearchValidationTelemetry({
    attempt: 0,
    validation: lastValidation,
  });

  if (!lastValidation.valid) {
    const formatted = formatEventsValidationResults(lastValidation);
    throw new UserInputError(
      formatted
        ? `Search validation failed:\n${formatted}`
        : "Search validation failed.",
    );
  }

  const finalRequestFields = buildRequestFields(dataset, fields);
  sentryQuery = applyEnvironmentToEventsQuery(
    dataset,
    sentryQuery,
    environment,
  );

  const eventsResponse = await apiService.searchEvents({
    organizationSlug,
    query: sentryQuery,
    fields: finalRequestFields,
    limit: params.limit,
    projectId,
    dataset,
    sort: sortParam,
    crossEventQueries: seerTranslation?.crossEventQueries,
    ...timeParams,
  });

  const aggregateFunctions = fields.filter(
    (field) => field.includes("(") && field.includes(")"),
  );
  const groupByFields = fields.filter(
    (field) => !field.includes("(") && !field.includes(")"),
  );

  function isValidResponse(
    response: unknown,
  ): response is { data?: unknown[] } {
    return typeof response === "object" && response !== null;
  }

  function isValidEventArray(data: unknown): data is Record<string, unknown>[] {
    return (
      Array.isArray(data) &&
      data.every((item) => typeof item === "object" && item !== null)
    );
  }

  if (!isValidResponse(eventsResponse)) {
    throw new Error("Invalid response format from Sentry API");
  }

  const eventData = eventsResponse.data;
  if (!isValidEventArray(eventData)) {
    throw new Error("Invalid event data format from Sentry API");
  }

  getActiveSpan()?.setAttribute(
    "gen_ai.tool.call.result.count",
    eventData.length,
  );

  const conversationId = extractConversationIdFromSearchQuery(sentryQuery);
  const explorerUrl = conversationId
    ? apiService.getAIConversationUrl(organizationSlug, conversationId)
    : apiService.getEventsExplorerUrl(
        organizationSlug,
        sentryQuery,
        projectId,
        dataset,
        fields,
        sortParam,
        aggregateFunctions,
        groupByFields,
        timeParams.statsPeriod,
        timeParams.start,
        timeParams.end,
        eventData,
      );

  const formatParams = {
    eventData,
    inputQuery: params.query || sentryQuery || `${dataset} events`,
    includeExplanation: params.includeExplanation,
    apiService,
    organizationSlug,
    explorerUrl,
    sentryQuery,
    fields,
    explanation,
    executedSearch: {
      dataset,
      query: sentryQuery,
      fields,
      sort: sortParam,
      timeRange: timeParams,
    },
    experimentalMode: context.experimentalMode ?? false,
    availableToolNames: context.availableToolNames,
    directToolNames: context.directToolNames,
  };

  switch (dataset) {
    case "errors":
      return withLeadingNote(formatErrorResults(formatParams));
    case "logs":
      return withLeadingNote(formatLogResults(formatParams));
    case "spans":
      return withLeadingNote(formatSpanResults(formatParams));
    case "profiles":
      return withLeadingNote(formatProfileResults(formatParams));
    default:
      return withLeadingNote(formatTraceMetricsResults(formatParams));
  }
}
