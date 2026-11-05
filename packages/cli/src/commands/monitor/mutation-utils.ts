import type {
  DatasetCompletion,
  DatasetFields,
} from "../../lib/completion-target.js";
import { ValidationError } from "../../lib/errors.js";
import type {
  MetricMonitor,
  MetricMonitorCreateBody,
  MetricMonitorUpdateBody,
} from "../../lib/api/detectors.js";
import {
  METRIC_MONITOR_SIGNALS,
  METRIC_MONITOR_SIGNAL_ALIASES,
  METRIC_MONITOR_SIGNAL_NAMES,
  type MetricMonitorSignal,
} from "../../types/metric-monitor.js";
import {
  monitorObject as objectValue,
  monitorQuery,
} from "../../lib/metric-monitor.js";

const TRANSACTION_DATASET_NAMES = ["transaction", "transactions"];
const LOG_ALERT_FUNCTIONS = [
  "count",
  "count_unique",
  "avg",
  "p50",
  "p75",
  "p90",
  "p95",
  "p99",
  "max",
  "min",
  "sum",
] as const;

/** `EAP_FUNCTIONS`, all of which spans define. */
const SPAN_ALERT_FUNCTIONS = [
  ...LOG_ALERT_FUNCTIONS,
  "p100",
  "epm",
  "eps",
  "failure_count",
  "failure_rate",
  "apdex",
  "user_misery",
] as const;

const ERROR_ALERT_FIELDS: DatasetFields = {
  aggregates: [
    "count()",
    "count_unique(user)",
    "count_unique(release)",
    "count_unique(dist)",
  ],
};

const CRASH_RATE_ALERT_FIELDS: DatasetFields = {
  aggregates: [
    "percentage(sessions_crashed,sessions)",
    "percentage(users_crashed,users)",
  ],
};

/**
 * What `--aggregate` completes, by the dataset `--dataset` names: the
 * aggregates metric alerts accept on it, narrower than a widget's. Without
 * `--dataset`, every dataset's.
 */
export const METRIC_MONITOR_FIELD_COMPLETION: DatasetCompletion = {
  datasets: {
    errors: ERROR_ALERT_FIELDS,
    events: ERROR_ALERT_FIELDS,
    spans: { entity: "span-attribute", functions: SPAN_ALERT_FUNCTIONS },
    logs: { entity: "log-attribute", functions: LOG_ALERT_FUNCTIONS },
    metrics: CRASH_RATE_ALERT_FIELDS,
    sessions: CRASH_RATE_ALERT_FIELDS,
    tracemetrics: { entity: "span-attribute", functions: LOG_ALERT_FUNCTIONS },
  } satisfies Record<MetricMonitorSignal, DatasetFields>,
  aliases: {
    ...METRIC_MONITOR_SIGNAL_ALIASES,
    ...Object.fromEntries(
      [...TRANSACTION_DATASET_NAMES].map((name) => [name, "spans"]),
    ),
  },
};

export type MonitorFlags = {
  readonly name?: string;
  readonly query?: string;
  readonly aggregate?: string;
  readonly dataset?: string;
  readonly "time-window"?: number;
  readonly condition?: string[];
  readonly critical?: number;
  readonly warning?: number;
  readonly resolve?: number;
  readonly comparison?: "gt" | "lt";
  readonly config?: string;
  readonly environment?: string;
  readonly description?: string;
  readonly owner?: string;
  readonly enabled?: boolean;
  readonly alert?: string[];
  readonly "dry-run": boolean;
  readonly json: boolean;
  readonly fields?: string[];
};

export function parseObject(
  raw: string,
  field: string,
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ValidationError(`${field} must be a JSON object.`, field);
  }
  const result = objectValue(value);
  if (!result)
    throw new ValidationError(`${field} must be a JSON object.`, field);
  return result;
}

export function parseEnabled(raw: string): boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new ValidationError("enabled must be true or false.", "enabled");
}

export function parseAlertIds(values: readonly string[]): number[] {
  return values
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean)
    .map((id) => {
      if (
        !/^\d+$/.test(id) ||
        !Number.isSafeInteger(Number(id)) ||
        Number(id) <= 0
      ) {
        throw new ValidationError(
          `Alert ID must be a positive safe integer (got '${id}').`,
          "alert",
        );
      }
      return Number(id);
    });
}

function signalFields(dataset: string, query: string): Record<string, unknown> {
  const name = dataset.trim().toLowerCase();
  const transaction = TRANSACTION_DATASET_NAMES.includes(name);
  const canonical = transaction
    ? "spans"
    : (METRIC_MONITOR_SIGNAL_ALIASES[name] ?? name);
  if (!Object.hasOwn(METRIC_MONITOR_SIGNALS, canonical)) {
    throw new ValidationError(
      `dataset must be one of: ${METRIC_MONITOR_SIGNAL_NAMES.join(", ")}.`,
      "dataset",
    );
  }
  const source = METRIC_MONITOR_SIGNALS[canonical as MetricMonitorSignal];
  return {
    ...source,
    eventTypes: [...source.eventTypes],
    query:
      transaction && !query.split(/\s+/).includes("is_transaction:true")
        ? [query.trim(), "is_transaction:true"].filter(Boolean).join(" ")
        : query,
  };
}

function parseConditions(values: readonly string[]): Record<string, unknown>[] {
  const conditions = values.map((raw) => parseObject(raw, "condition"));
  if (!conditions.length || conditions.length > 3) {
    throw new ValidationError(
      "Pass between one and three --condition JSON objects.",
      "condition",
    );
  }
  for (const condition of conditions) {
    if (
      !["gt", "gte", "lt", "lte", "anomaly_detection"].includes(
        String(condition.type),
      ) ||
      ![0, 50, 75].includes(Number(condition.conditionResult)) ||
      typeof condition.conditionResult !== "number" ||
      (condition.type === "anomaly_detection"
        ? !objectValue(condition.comparison)
        : typeof condition.comparison !== "number")
    ) {
      throw new ValidationError(
        "Each condition needs native type, comparison and conditionResult (0, 50 or 75).",
        "condition",
      );
    }
  }
  return conditions;
}

function validateDetection(
  config: Record<string, unknown>,
  conditions: unknown,
): void {
  const mode = config.detectionType;
  if (!["static", "percent", "dynamic"].includes(String(mode))) {
    throw new ValidationError(
      "config.detectionType must be static, percent or dynamic.",
      "config",
    );
  }
  const list = Array.isArray(conditions) ? conditions.map(objectValue) : [];
  if (mode === "dynamic") {
    if (
      !list.length ||
      list.some((condition) => condition?.type !== "anomaly_detection")
    ) {
      throw new ValidationError(
        "Dynamic detection requires anomaly_detection conditions.",
        "condition",
      );
    }
  } else if (
    !list.length ||
    list.some((c) => c?.type === "anomaly_detection") ||
    !list.some((c) => c?.conditionResult === 0)
  ) {
    throw new ValidationError(
      "Static and percent detection require numeric conditions including a resolution condition (conditionResult 0).",
      "condition",
    );
  }
  if (
    mode === "percent" &&
    !(typeof config.comparisonDelta === "number" && config.comparisonDelta > 0)
  ) {
    throw new ValidationError(
      "Percent detection requires config.comparisonDelta in seconds.",
      "config",
    );
  }
}

/** Native partial PUT: omitted fields remain untouched on the server. */
export function buildMonitorBody(
  flags: MonitorFlags,
  current?: MetricMonitor,
): MetricMonitorUpdateBody {
  const body: Record<string, unknown> = {};
  for (const field of ["name", "description", "enabled"] as const) {
    if (flags[field] !== undefined) body[field] = flags[field];
  }
  if (flags.name !== undefined && !flags.name.trim())
    throw new ValidationError("name cannot be empty.", "name");
  if (flags.owner !== undefined) body.owner = flags.owner || null;
  if (flags.alert !== undefined) body.workflowIds = parseAlertIds(flags.alert);
  const changesQuery = [
    flags.query,
    flags.aggregate,
    flags.dataset,
    flags["time-window"],
    flags.environment,
  ].some((v) => v !== undefined);
  if (changesQuery) {
    const existing = current ? monitorQuery(current) : {};
    if (!existing)
      throw new ValidationError(
        "Cannot safely edit a missing or multi-source query.",
        "query",
      );
    // Only response metadata is removed; preserve all stored query fields, including
    // groupBy, extrapolationMode, environment and eventTypes.
    const { id: _id, ...query } = existing;
    if (flags.query !== undefined) query.query = flags.query;
    if (flags.aggregate !== undefined) {
      if (!flags.aggregate.trim())
        throw new ValidationError("aggregate cannot be empty.", "aggregate");
      query.aggregate = flags.aggregate;
    }
    if (flags.dataset !== undefined)
      Object.assign(
        query,
        signalFields(
          flags.dataset,
          typeof query.query === "string" ? query.query : "",
        ),
      );
    if (flags["time-window"] !== undefined) {
      if (!Number.isInteger(flags["time-window"]) || flags["time-window"] <= 0)
        throw new ValidationError(
          "time-window must be a positive whole number of minutes.",
          "time-window",
        );
      query.timeWindow = flags["time-window"] * 60;
    }
    if (flags.environment !== undefined)
      query.environment = flags.environment || null;
    else if (!current) query.environment = null;
    body.dataSources = [query];
  }
  const shorthand = [
    flags.critical,
    flags.warning,
    flags.resolve,
    flags.comparison,
  ].some((v) => v !== undefined);
  if (shorthand && flags.condition !== undefined) {
    throw new ValidationError(
      "Use --critical/--warning/--resolve/--comparison or --condition, not both.",
      "condition",
    );
  }
  let conditions =
    flags.condition !== undefined
      ? parseConditions(flags.condition)
      : undefined;
  if (shorthand) {
    if (flags.critical === undefined)
      throw new ValidationError(
        "Threshold shorthand requires --critical.",
        "critical",
      );
    const comparison = flags.comparison ?? "gt";
    conditions = [
      { type: comparison, comparison: flags.critical, conditionResult: 75 },
    ];
    if (flags.warning !== undefined)
      conditions.push({
        type: comparison,
        comparison: flags.warning,
        conditionResult: 50,
      });
    conditions.push({
      type: comparison === "gt" ? "lte" : "gte",
      comparison: flags.resolve ?? flags.critical,
      conditionResult: 0,
    });
  }
  let group = objectValue(current?.conditionGroup);
  if (conditions !== undefined) {
    group = { ...group, logicType: group?.logicType ?? "any", conditions };
    body.conditionGroup = group;
  }
  if (flags.config !== undefined || conditions !== undefined || !current) {
    const changes =
      flags.config !== undefined ? parseObject(flags.config, "config") : {};
    const config: Record<string, unknown> = {
      ...(objectValue(current?.config) ?? { detectionType: "static" }),
      ...changes,
    };
    if (
      current &&
      changes.detectionType !== undefined &&
      changes.detectionType !== "percent"
    )
      config.comparisonDelta = null;
    validateDetection(config, group?.conditions);
    body.config = config;
  }
  if (!current) body.type = "metric_issue";
  if (Object.keys(body).length === 0)
    throw new ValidationError("Pass at least one editable monitor field.");
  return body as MetricMonitorUpdateBody;
}

export function buildMonitorCreateBody(
  flags: MonitorFlags,
): MetricMonitorCreateBody {
  for (const field of [
    "name",
    "query",
    "aggregate",
    "dataset",
    "time-window",
  ] as const) {
    if (flags[field] === undefined)
      throw new ValidationError(`--${field} is required.`, field);
  }
  if (flags.condition === undefined && flags.critical === undefined)
    throw new ValidationError(
      "Pass --critical <number> or native --condition JSON.",
      "condition",
    );
  return buildMonitorBody(flags) as MetricMonitorCreateBody;
}
