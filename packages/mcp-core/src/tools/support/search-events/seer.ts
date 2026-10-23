import { logger, metrics } from "@sentry/core";
import type { z } from "zod";
import type { CrossEventQueries, SentryApiService } from "../../../api-client";
import {
  ApiAuthenticationError,
  ApiError,
  type SearchAgentQuerySchema,
} from "../../../api-client/index";
import { logWarn } from "../../../telem/logging";
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
  mode: AiQueryMode;
  organizationFeatures: string[];
}

export type AiQueryMode = "samples" | "aggregate";

export type AiQueryDataset = "spans" | "errors" | "logs" | "tracemetrics";

// The dataset names Sentry's frontend reports for each Seer dataset.
export const AI_QUERY_DATASETS = {
  errors: "errors",
  logs: "logs",
  spans: "spans",
  metrics: "tracemetrics",
} as const satisfies Record<SeerSearchDataset, AiQueryDataset>;

function extractErrorReason(err: Error): string {
  if (err instanceof ApiError && err.detail) {
    return err.detail;
  }
  return err.message;
}

// Seer doesn't return results, so the caller reports whether the translated
// query found anything. Mirrors `trackAiQueryOutcome` in Sentry's frontend
// (`static/app/components/searchQueryBuilder/askSeerCombobox/utils.ts`), which
// reports the same metric with an `assisted_query.search_bar.*` referrer.
export function trackAiQueryOutcome({
  dataset,
  mode,
  organization,
  resultCount,
  runId,
  error = false,
}: {
  dataset: AiQueryDataset;
  mode: AiQueryMode;
  organization: { slug: string; features: string[] };
  resultCount: number;
  runId: string;
  error?: string | boolean | Error;
}): void {
  const outcome = error
    ? "error_on_load"
    : resultCount > 0
      ? "has_results"
      : "empty_results";
  const errorReason =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? extractErrorReason(error)
        : undefined;

  const referrer = `assisted_query.mcp.${dataset === "spans" ? "traces" : dataset}`;
  // Seer runs are stored as conversations in the `sentry` org.
  const conversationUrl = `https://sentry.io/organizations/sentry/explore/agents/conversations/${encodeURIComponent(runId)}/`;
  const codeMode = organization.features.includes(
    "seer-assisted-query-codemode",
  );
  const crossEventEnabled = organization.features.includes(
    "seer-assisted-query-cross-event-explorer",
  );

  const attributes = {
    dataset,
    mode,
    org_slug: organization.slug,
    referrer,
    run_id: runId,
    conversation_url: conversationUrl,
    outcome,
    error_reason: errorReason,
    code_mode: codeMode,
    cross_event_enabled: crossEventEnabled,
  };

  logger.info("assisted_query.outcome", {
    ...attributes,
    result_count: resultCount,
  });
  metrics.distribution("assisted_query.outcome", resultCount, { attributes });
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
