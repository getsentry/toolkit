/**
 * Metric alert types and schemas
 *
 * The CLI `--dataset` vocabulary for `sentry alert metrics`, mapped onto the
 * shared metric monitor data sources, plus Valibot schemas for `--trigger`.
 * Every dataset list, help string, and lookup is derived from
 * {@link METRIC_ALERT_DATASETS} so they cannot diverge.
 */

import {
  METRIC_MONITOR_PRIORITY,
  METRIC_MONITOR_SOURCES,
  METRIC_MONITOR_THRESHOLD_TYPES,
  type MetricMonitorSource,
} from "@sentry/toolkit-core/metric-monitor";
import {
  array,
  finite,
  getDotPath,
  type InferOutput,
  looseObject,
  maxLength,
  nullable,
  number,
  object,
  optional,
  picklist,
  pipe,
  record,
  safeParse,
  string,
  transform,
  union,
  unknown,
} from "valibot";

import { ValidationError } from "../lib/errors.js";

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

/**
 * CLI dataset names and the detector data source each selects.
 *
 * Key order drives help text and, for shared sources, which name a stored
 * monitor reads back as (`errors` over `events`, `metrics` over `sessions`).
 */
export const METRIC_ALERT_DATASETS = {
  errors: METRIC_MONITOR_SOURCES.errors,
  events: METRIC_MONITOR_SOURCES.errors,
  spans: METRIC_MONITOR_SOURCES.spans,
  logs: METRIC_MONITOR_SOURCES.logs,
  metrics: METRIC_MONITOR_SOURCES.crashRate,
  sessions: METRIC_MONITOR_SOURCES.crashRate,
} as const satisfies Record<string, MetricMonitorSource>;

export type MetricAlertDataset = keyof typeof METRIC_ALERT_DATASETS;

export const METRIC_ALERT_DATASET_NAMES = Object.keys(
  METRIC_ALERT_DATASETS,
) as MetricAlertDataset[];

/**
 * Aliases for {@link METRIC_ALERT_DATASETS} names.
 *
 * Only singular forms and the dashboard name for errors (`error-events`) are
 * aliased. Names of *distinct* datasets — `tracemetrics`, `eap`,
 * `events_analytics_platform` — are deliberately not, because rewriting them
 * onto `metrics`/`spans` would silently send the wrong data source (the CLI's
 * `metrics` is crash rate, not trace metrics). `transaction(s)` is routed to
 * `spans` with an `is_transaction:true` filter by `resolveMetricDataset`.
 */
export const METRIC_ALERT_DATASET_ALIASES: Record<string, MetricAlertDataset> =
  {
    error: "errors",
    "error-events": "errors",
    span: "spans",
    log: "logs",
    metric: "metrics",
    session: "sessions",
  };

/** `--dataset` flag help, derived from the dataset table. */
export const METRIC_ALERT_DATASET_BRIEF = `Dataset: ${METRIC_ALERT_DATASET_NAMES.join(", ")} (error-events is errors; transaction(s) routes to spans)`;

/** Data source for a CLI dataset name, or `undefined` for other names. */
export function metricAlertSource(
  dataset: string,
): MetricMonitorSource | undefined {
  const name = dataset.trim().toLowerCase();
  return Object.hasOwn(METRIC_ALERT_DATASETS, name)
    ? METRIC_ALERT_DATASETS[name as MetricAlertDataset]
    : undefined;
}

/**
 * CLI dataset name for a stored data source, or the native dataset when no
 * CLI name selects it (e.g. EAP `trace_item_metric`).
 */
export function metricAlertDatasetName(
  dataset: string,
  eventTypes: readonly string[],
): string {
  const match = METRIC_ALERT_DATASET_NAMES.find((name) => {
    const source: MetricMonitorSource = METRIC_ALERT_DATASETS[name];
    return (
      source.dataset === dataset &&
      eventTypes.every((type) => source.eventTypes.includes(type))
    );
  });
  return match ?? dataset;
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

/** A threshold given as a number or numeric string. */
const ThresholdSchema = pipe(
  union([number(), string()]),
  transform(Number),
  number(),
  finite(),
);

const ACTIONS_MESSAGE =
  "Metric alerts no longer carry notification actions on triggers. Remove 'actions' and connect an existing alert with --workflow <id>.";

/**
 * Legacy-style trigger: alert above (`thresholdType` 0, default) or below (1)
 * `alertThreshold`. Notification actions are rejected because detectors do
 * not accept them and would drop them silently.
 */
const ThresholdTriggerSchema = object({
  alertThreshold: ThresholdSchema,
  label: optional(picklist(["critical", "warning"])),
  resolveThreshold: optional(nullable(ThresholdSchema)),
  thresholdType: optional(picklist([0, 1])),
  actions: optional(pipe(array(unknown()), maxLength(0, ACTIONS_MESSAGE))),
});

/** Native detector condition, passed to the API as-is. */
const DetectorConditionSchema = looseObject({
  type: picklist([...METRIC_MONITOR_THRESHOLD_TYPES, "anomaly_detection"]),
  comparison: union([number(), record(string(), unknown())]),
  conditionResult: picklist(Object.values(METRIC_MONITOR_PRIORITY)),
});

const ThresholdTriggersSchema = array(ThresholdTriggerSchema);
const DetectorConditionsSchema = array(DetectorConditionSchema);

export type ThresholdTrigger = InferOutput<typeof ThresholdTriggerSchema>;
export type DetectorCondition = InferOutput<typeof DetectorConditionSchema>;

/** Parsed `--trigger` values: all thresholds or all native conditions. */
export type MetricTriggers = ThresholdTrigger[] | DetectorCondition[];

/** Whether parsed triggers are native detector conditions. */
export function isDetectorConditionList(
  triggers: MetricTriggers,
): triggers is DetectorCondition[] {
  return triggers.some((trigger) => "type" in trigger);
}

/**
 * Parse and validate `--trigger` JSON objects.
 *
 * Triggers must be all threshold triggers or all native detector conditions
 * (shape chosen by the presence of `type`).
 *
 * @throws {ValidationError} with the offending path and allowed values
 */
export function parseMetricTriggers(
  raw: readonly Record<string, unknown>[] | undefined,
): MetricTriggers {
  if (!raw || raw.length === 0) {
    throw new ValidationError(
      "Pass at least one --trigger JSON object.",
      "trigger",
    );
  }
  const nativeCount = raw.filter((trigger) => "type" in trigger).length;
  if (nativeCount > 0 && nativeCount < raw.length) {
    throw new ValidationError(
      "Do not mix detector conditions (with 'type') and alertThreshold triggers.",
      "trigger",
    );
  }

  const result =
    nativeCount > 0
      ? safeParse(DetectorConditionsSchema, raw)
      : safeParse(ThresholdTriggersSchema, raw);
  if (result.success) {
    return result.output;
  }
  const issues = result.issues.map(
    (issue) => `${getDotPath(issue) ?? "trigger"}: ${issue.message}`,
  );
  throw new ValidationError(
    `Invalid --trigger:\n${issues.join("\n")}`,
    "trigger",
  );
}
