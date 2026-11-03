/**
 * Metric monitor (metric-issue detector) constants shared by the CLI and MCP.
 *
 * `@sentry/api` types detector `data_sources` and `condition_group.conditions`
 * as `Array<unknown>`, so these values come from the Sentry source instead:
 * - Datasets: `sentry.snuba.snuba_query_validator.QUERY_TYPE_VALID_DATASETS`
 * - Event types: `QUERY_TYPE_VALID_EVENT_TYPES` in the same module
 * - Conditions and priorities:
 *   `sentry.incidents.metric_issue_detector.MetricIssueComparisonConditionValidator`
 */

/** Native `Dataset` values the detector validator accepts. */
export const METRIC_MONITOR_DATASETS = [
  "events",
  "transactions",
  "generic_metrics",
  "metrics",
  "events_analytics_platform",
] as const;

export type MetricMonitorDataset = (typeof METRIC_MONITOR_DATASETS)[number];

/** Static/percent threshold operators (`anomaly_detection` is separate). */
export const METRIC_MONITOR_THRESHOLD_TYPES = [
  "gt",
  "lt",
  "gte",
  "lte",
] as const;

export type MetricMonitorThresholdType =
  (typeof METRIC_MONITOR_THRESHOLD_TYPES)[number];

/** `DetectorPriorityLevel` values a metric condition can resolve to. */
export const METRIC_MONITOR_PRIORITY = {
  critical: 75,
  warning: 50,
  resolved: 0,
} as const;

/** `SnubaQuery.Type`: 0 error, 1 performance (incl. EAP), 2 crash rate. */
export type MetricMonitorQueryType = 0 | 1 | 2;

/** The dataset, query type, and event types that select one signal. */
export type MetricMonitorSource = {
  readonly dataset: MetricMonitorDataset;
  readonly queryType: MetricMonitorQueryType;
  readonly eventTypes: readonly string[];
};

/** Data sources for the signals clients expose by name. */
export const METRIC_MONITOR_SOURCES = {
  errors: { dataset: "events", queryType: 0, eventTypes: ["error", "default"] },
  spans: {
    dataset: "events_analytics_platform",
    queryType: 1,
    eventTypes: ["trace_item_span"],
  },
  logs: {
    dataset: "events_analytics_platform",
    queryType: 1,
    eventTypes: ["trace_item_log"],
  },
  crashRate: { dataset: "metrics", queryType: 2, eventTypes: [] },
} as const satisfies Record<string, MetricMonitorSource>;
