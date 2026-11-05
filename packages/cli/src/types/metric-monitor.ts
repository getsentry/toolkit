/** CLI signal names select native SnubaQuery fields; detector documents stay native. */
import {
  METRIC_MONITOR_SOURCES,
  type MetricMonitorSource,
} from "@sentry/toolkit-core/metric-monitor";

export const METRIC_MONITOR_SIGNALS = {
  errors: METRIC_MONITOR_SOURCES.errors,
  events: METRIC_MONITOR_SOURCES.errors,
  spans: METRIC_MONITOR_SOURCES.spans,
  logs: METRIC_MONITOR_SOURCES.logs,
  metrics: METRIC_MONITOR_SOURCES.crashRate,
  sessions: METRIC_MONITOR_SOURCES.crashRate,
  tracemetrics: {
    dataset: "events_analytics_platform",
    queryType: 1,
    eventTypes: ["trace_item_metric"],
  },
} as const satisfies Record<string, MetricMonitorSource>;
export type MetricMonitorSignal = keyof typeof METRIC_MONITOR_SIGNALS;
export const METRIC_MONITOR_SIGNAL_NAMES = Object.keys(
  METRIC_MONITOR_SIGNALS,
) as MetricMonitorSignal[];
export const METRIC_MONITOR_SIGNAL_ALIASES: Record<
  string,
  MetricMonitorSignal
> = {
  error: "errors",
  "error-events": "errors",
  span: "spans",
  log: "logs",
  metric: "metrics",
  session: "sessions",
};
export const METRIC_MONITOR_DATASET_BRIEF = `Signal dataset: ${METRIC_MONITOR_SIGNAL_NAMES.join(", ")}`;
