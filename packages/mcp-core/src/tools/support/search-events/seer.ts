import { metrics } from "@sentry/core";
import type { z } from "zod";
import type { CrossEventQueries, SentryApiService } from "../../../api-client";
import {
  ApiAuthenticationError,
  type SearchAgentQuerySchema,
} from "../../../api-client/index";
import { logInfo, logWarn } from "../../../telem/logging";
import {
  normalizeEventsDataset,
  type PublicEventsDataset,
} from "../../../utils/events-datasets";
import { RECOMMENDED_FIELDS } from "./config";

export const SEER_SEARCH_AGENT_POLLING_INTERVAL = 1000; // 1 second
export const SEER_SEARCH_AGENT_TIMEOUT = 60 * 1000; // 1 minute

// Sentry's sentinel for all projects the user can access.
const ALL_ACCESSIBLE_PROJECTS = -1;

// Gradual rollout flag for Seer translation in search_events. The search agent
// endpoints themselves are ungated; `hideAiFeatures` is checked separately.
const SEER_TRANSLATE_FEATURE = "mcp-search-events-seer-translate";

const SEER_STRATEGIES = {
  errors: "Errors",
  logs: "Logs",
  spans: "Traces",
  metrics: "Metrics",
} as const satisfies Partial<Record<PublicEventsDataset, string>>;

export type SeerSearchDataset = keyof typeof SEER_STRATEGIES;

export function isSeerSearchDataset(
  dataset: string | undefined,
): dataset is SeerSearchDataset {
  return dataset !== undefined && dataset in SEER_STRATEGIES;
}

export interface SeerSearchTranslation {
  query: string;
  fields: string[];
  sort: string;
  timeParams: { statsPeriod?: string; start?: string; end?: string };
  timeSeries: { yAxis: string; interval: string } | null;
  crossEventQueries: CrossEventQueries;
  // Other projects Seer suggested searching beyond the requested one.
  suggestedProjectIds: number[];
  explanation: string;
  // Correctness warnings must be shown even when explanations are disabled.
  warning?: string;
  // Identifies the run in the assisted query outcome metric.
  runId: string;
  mode: AssistedQueryMode;
  organizationFeatures: string[];
}

// Seer doesn't return results, so the caller reports whether the translated
// query found anything. Mirrors `trackAiQueryOutcome` in Sentry's frontend,
// which reports the same metric with an `assisted_query.search_bar.*` referrer.
// See `static/app/components/searchQueryBuilder/askSeerCombobox/utils.ts`.
const ASSISTED_QUERY_OUTCOME = "assisted_query.outcome";

// The frontend's dataset and referrer names for each Seer dataset.
const ASSISTED_QUERY_DATASETS = {
  errors: "errors",
  logs: "logs",
  spans: "spans",
  metrics: "tracemetrics",
} as const satisfies Record<SeerSearchDataset, string>;

const ASSISTED_QUERY_REFERRERS = {
  errors: "assisted_query.mcp.errors",
  logs: "assisted_query.mcp.logs",
  spans: "assisted_query.mcp.traces",
  metrics: "assisted_query.mcp.tracemetrics",
} as const satisfies Record<SeerSearchDataset, string>;

export type AssistedQueryMode = "samples" | "aggregate";

export type AssistedQueryOutcome =
  | "has_results"
  | "empty_results"
  | "error_on_load";

/**
 * Reports whether a Seer-translated query returned results once executed.
 * Pass `error` when the query failed to run.
 */
export function trackAssistedQueryOutcome({
  dataset,
  organizationSlug,
  translation,
  resultCount,
  error,
}: {
  dataset: SeerSearchDataset;
  organizationSlug: string;
  translation: SeerSearchTranslation;
  resultCount: number;
  error?: unknown;
}): void {
  const outcome: AssistedQueryOutcome = error
    ? "error_on_load"
    : resultCount > 0
      ? "has_results"
      : "empty_results";
  const errorReason = error
    ? error instanceof Error
      ? error.message
      : String(error)
    : undefined;

  const attributes = {
    dataset: ASSISTED_QUERY_DATASETS[dataset],
    mode: translation.mode,
    org_slug: organizationSlug,
    referrer: ASSISTED_QUERY_REFERRERS[dataset],
    run_id: translation.runId,
    // Seer runs are stored as conversations in the `sentry` org.
    conversation_url: `https://sentry.io/organizations/sentry/explore/agents/conversations/${encodeURIComponent(translation.runId)}/`,
    outcome,
    code_mode: translation.organizationFeatures.includes(
      "seer-assisted-query-codemode",
    ),
    cross_event_enabled: translation.organizationFeatures.includes(
      "seer-assisted-query-cross-event-explorer",
    ),
    ...(errorReason ? { error_reason: errorReason } : {}),
  };

  logInfo(ASSISTED_QUERY_OUTCOME, {
    extra: { ...attributes, result_count: resultCount },
  });
  metrics.distribution(ASSISTED_QUERY_OUTCOME, resultCount, { attributes });
}

// Returns the org's features when Seer translation is enabled, otherwise null.
async function getSeerSearchAgentFeatures(
  apiService: SentryApiService,
  organizationSlug: string,
): Promise<string[] | null> {
  // Sentry omits `features` unless explicitly requested.
  const organization = await apiService.getOrganization(organizationSlug, {
    includeFeatureFlags: true,
    detailed: false,
  });
  if (organization.hideAiFeatures) {
    return null;
  }
  const features = organization.features ?? [];
  return features.includes(SEER_TRANSLATE_FEATURE) ? features : null;
}

function toSearchTranslation(
  result: z.output<typeof SearchAgentQuerySchema>,
  dataset: SeerSearchDataset,
  suggestedProjectIds: number[],
  run: { runId: string; organizationFeatures: string[] },
): SeerSearchTranslation {
  const aggregates = result.visualization.flatMap((chart) => chart.y_axes);
  const fields =
    result.mode === "aggregates"
      ? [...new Set([...result.group_by, ...aggregates])]
      : [];
  if (fields.length === 0) {
    fields.push(...RECOMMENDED_FIELDS[normalizeEventsDataset(dataset)].basic);
  }

  const defaultSort =
    result.mode === "aggregates" && aggregates[0]
      ? `-${aggregates[0]}`
      : "-timestamp";
  let sort = result.sort.trim() || defaultSort;
  // The handler adds the sort field to the selected fields, except for a
  // non-aggregate sort in an aggregate query since that would change the
  // grouping. Fall back to the default sort instead of letting Sentry reject it.
  const sortField = sort.startsWith("-") ? sort.slice(1) : sort;
  if (
    result.mode === "aggregates" &&
    !sortField.includes("(") &&
    !fields.includes(sortField)
  ) {
    sort = defaultSort;
  }

  // Seer always returns a chart for aggregates since Explore shows one, but only
  // sets an interval when the user asks for time buckets, e.g. "per day". The
  // time series endpoint can't group, so grouped queries stay a table.
  const chartWithInterval = result.visualization.find(
    (chart) => chart.interval && chart.y_axes[0],
  );
  const timeSeries =
    result.mode === "aggregates" &&
    result.group_by.length === 0 &&
    chartWithInterval?.interval &&
    chartWithInterval.y_axes[0]
      ? {
          yAxis: chartWithInterval.y_axes[0],
          interval: chartWithInterval.interval,
        }
      : null;

  let timeParams: SeerSearchTranslation["timeParams"];
  if (result.stats_period) {
    timeParams = { statsPeriod: result.stats_period };
  } else if (result.start && result.end) {
    timeParams = { start: result.start, end: result.end };
  } else {
    timeParams = { statsPeriod: "14d" };
  }

  // Filters on other events in the same trace, only returned for spans.
  const crossEventQueries: CrossEventQueries = {
    spanQuery: result.span_query || undefined,
    logQuery: result.log_query || undefined,
    metricQuery: result.metric_query || undefined,
  };
  const crossEventFilters = [
    ["spans", crossEventQueries.spanQuery],
    ["logs", crossEventQueries.logQuery],
    ["metrics", crossEventQueries.metricQuery],
  ]
    .filter(([, query]) => query)
    .map(([type, query]) => `${type} \`${query}\``);

  let explanation = "Translated by Seer's search agent.";
  let warning: string | undefined;
  if (crossEventFilters.length > 0) {
    if (timeSeries) {
      // The time series endpoint doesn't support cross-event filters.
      warning = `**Warning:** Time series results are unfiltered by the requested cross-event filters (${crossEventFilters.join(", ")}). Counts and other values may include events outside the requested subset.`;
    } else {
      explanation += ` Only includes results whose trace also has matching ${crossEventFilters.join(", ")}.`;
    }
  }

  return {
    query: result.query,
    fields,
    sort,
    timeParams,
    timeSeries,
    crossEventQueries,
    suggestedProjectIds,
    explanation,
    warning,
    runId: run.runId,
    mode: result.mode === "aggregates" ? "aggregate" : "samples",
    organizationFeatures: run.organizationFeatures,
  };
}

/**
 * Translates a natural language query with Seer's search agent.
 *
 * Returns null when Seer is unavailable for the organization, cannot translate
 * the query, or does not finish in time, so the caller can fall back to the
 * embedded agent or direct query syntax.
 */
export async function translateWithSeer({
  apiService,
  organizationSlug,
  projectId,
  dataset,
  query,
}: {
  apiService: SentryApiService;
  organizationSlug: string;
  projectId?: string;
  dataset: SeerSearchDataset;
  query: string;
}): Promise<SeerSearchTranslation | null> {
  try {
    const organizationFeatures = await getSeerSearchAgentFeatures(
      apiService,
      organizationSlug,
    );
    if (!organizationFeatures) {
      return null;
    }

    const run = await apiService.startSearchAgent({
      organizationSlug,
      projectIds: [projectId ? Number(projectId) : ALL_ACCESSIBLE_PROJECTS],
      naturalLanguageQuery: query,
      strategy: SEER_STRATEGIES[dataset],
    });

    const deadline = Date.now() + SEER_SEARCH_AGENT_TIMEOUT;
    while (Date.now() < deadline) {
      const { session } = await apiService.getSearchAgentState({
        organizationSlug,
        runId: run.sentry_run_id,
      });

      if (session?.status === "completed") {
        const result = session.final_response?.responses[0];
        if (!result) {
          return null;
        }
        // Seer can suggest broadening a project-scoped search, e.g. to other
        // services in the same trace. With all projects requested there is
        // nothing to add.
        const suggestedProjectIds = projectId
          ? (session.final_response?.project_ids ?? []).filter(
              (id) => id !== Number(projectId),
            )
          : [];
        return toSearchTranslation(result, dataset, suggestedProjectIds, {
          runId: run.sentry_run_id,
          organizationFeatures,
        });
      }
      if (session?.status === "error") {
        return null;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, SEER_SEARCH_AGENT_POLLING_INTERVAL),
      );
    }

    logWarn("Seer search agent timed out", {
      extra: { organizationSlug, runId: run.sentry_run_id },
    });
    return null;
  } catch (error) {
    // An invalid token should surface to the user rather than fall back.
    if (error instanceof ApiAuthenticationError) {
      throw error;
    }
    logWarn(error, { extra: { organizationSlug } });
    return null;
  }
}
