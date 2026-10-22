/**
 * Shared validation and parsing helpers for alert mutation commands (create/edit).
 */

import { ValidationError } from "../../lib/errors.js";

const ISSUE_MATCH_MODES = new Set(["all", "any"]);
const METRIC_DATASET_VALUES = new Set([
  "errors",
  "sessions",
  "events",
  "spans",
  "logs",
  "metrics",
]);

/**
 * Maps user-provided dataset aliases to canonical metric alert dataset values.
 *
 * Only aliases that resolve to a value already accepted by the metric alert API
 * are listed here: the singular forms (`error` → `errors`, `span` → `spans`)
 * and the dashboard terminology for the error dataset (`error-events` →
 * `errors`). This lets users copying from dashboard docs avoid a validation
 * error without changing which dataset is sent.
 *
 * Names that denote a *distinct* dataset in the metric alert path — e.g.
 * `tracemetrics`, `metricsenhanced`, `eap`, `events_analytics_platform` — are
 * deliberately NOT aliased here. Rewriting them onto `metrics`/`spans` would
 * silently send the wrong dataset in the create/edit payload (the CLI's
 * canonical `metrics` is session/crash-rate, not trace metrics), with no
 * validation error to catch it.
 *
 * The deprecated `transaction`/`transactions` datasets are handled separately
 * by {@link resolveMetricDataset} — they route to `spans` with an added
 * `is_transaction:true` filter rather than a plain rename, so they are not
 * listed here.
 */
const METRIC_DATASET_ALIASES: Record<string, string> = {
  // Singular forms
  error: "errors",
  session: "sessions",
  metric: "metrics",
  span: "spans",
  log: "logs",
  // Dashboard terminology for the error dataset
  "error-events": "errors",
};

/** Deprecated dataset names that now route to `spans` with `is_transaction:true`. */
const TRANSACTION_DATASET_NAMES = new Set(["transaction", "transactions"]);

/** Query filter appended when migrating a `transaction(s)` request to `spans`. */
const IS_TRANSACTION_FILTER = "is_transaction:true";

/** Splits a query string on runs of whitespace. */
const QUERY_TOKEN_SEPARATOR = /\s+/;
/** Workflow (alert) ids are numeric. */
const WORKFLOW_ID_PATTERN = /^\d+$/;
const METRIC_TIME_WINDOWS = new Set([
  1, 5, 10, 15, 30, 60, 120, 240, 360, 720, 1440,
]);

/** Parse and validate an "all" | "any" match mode flag. Returns `undefined` when absent. */
export function parseMatchMode(
  value: string | undefined,
  field: "action-match" | "filter-match",
): "all" | "any" | undefined {
  if (value === undefined || value === "") {
    return;
  }
  const normalized = value.trim().toLowerCase();
  if (ISSUE_MATCH_MODES.has(normalized)) {
    return normalized as "all" | "any";
  }
  throw new ValidationError(
    `${field} must be 'all' or 'any' (got ${JSON.stringify(value)}).`,
    field,
  );
}

/**
 * Map an action-filter match mode to a workflow DataConditionGroup logic type.
 *
 * Applies to the **action-filter** ("if") group only. Mirrors the backend
 * issue-alert dual-write: "any" → "any-short", "all" → "all". The filter group
 * never holds trigger-type conditions, so the workflows create validator
 * accepts either logic type here.
 */
export function matchToLogicType(
  match: "all" | "any" | undefined,
): "all" | "any-short" {
  return match === "any" ? "any-short" : "all";
}

/**
 * Logic type for an issue alert's **trigger** ("when") DataConditionGroup.
 *
 * Always "any-short". The org-scoped workflows create endpoint rejects a
 * trigger group that carries an issue-alert trigger condition
 * (first_seen_event / regression_event / reappeared_event /
 * issue_resolved_trigger) with any other logic type — see
 * `BaseDataConditionGroupValidator._validate_logic_type` in getsentry/sentry.
 * An issue alert attaches to one error detector, so `all` vs `any` on the
 * trigger group is not a meaningful choice; use `--filter-match` to control
 * the action-filter group's match mode instead.
 */
export function triggerLogicType(): "any-short" {
  return "any-short";
}

/** Parse and validate an "active" | "disabled" status flag. Returns `undefined` when absent. */
export function parseStatusFlag(
  value: string | undefined,
): "active" | "disabled" | undefined {
  if (value === undefined || value === "") {
    return;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "active" || normalized === "disabled") {
    return normalized;
  }
  throw new ValidationError(
    `Status must be 'active' or 'disabled' (got ${JSON.stringify(value)}).`,
    "status",
  );
}

function parseJsonValue(raw: string, field: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError(
      `${field} must be valid JSON (got ${JSON.stringify(raw)}).`,
      field,
    );
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toObject(value: unknown, field: string): Record<string, unknown> {
  if (!isJsonObject(value)) {
    throw new ValidationError(`${field} entries must be JSON objects.`, field);
  }
  return value;
}

/**
 * Parse CLI flag values into an array of JSON objects.
 *
 * Accepts a single JSON array string, a single JSON object string,
 * or multiple JSON object strings. Returns `undefined` when absent.
 */
export function parseJsonObjectList(
  values: readonly string[] | undefined,
  field: string,
): Record<string, unknown>[] | undefined {
  if (!values || values.length === 0) {
    return;
  }

  if (values.length === 1) {
    const onlyValue = values[0];
    if (onlyValue === undefined) {
      return;
    }
    const parsed = parseJsonValue(onlyValue, field);
    if (Array.isArray(parsed)) {
      return parsed.map((entry) => toObject(entry, field));
    }
    return [toObject(parsed, field)];
  }

  return values.map((value) => toObject(parseJsonValue(value, field), field));
}

/** Require at least one entry in the conditions or actions array. */
export function validateIssueRuleArrays(
  conditions: readonly Record<string, unknown>[] | undefined,
  actions: readonly Record<string, unknown>[] | undefined,
  field: "conditions" | "actions",
): void {
  if (field === "conditions") {
    if (!conditions || conditions.length === 0) {
      throw new ValidationError(
        "Pass at least one --condition JSON object.",
        "condition",
      );
    }
    return;
  }

  if (!actions || actions.length === 0) {
    throw new ValidationError(
      "Pass at least one --action JSON object.",
      "action",
    );
  }
}

/** Split comma-separated project slugs, trim whitespace, and filter empties. */
export function normalizeProjectList(
  projects: readonly string[] | undefined,
): string[] | undefined {
  if (!projects || projects.length === 0) {
    return;
  }

  const values = projects
    .flatMap((project) => project.split(","))
    .map((project) => project.trim())
    .filter((project) => project.length > 0);
  return values.length > 0 ? values : undefined;
}

/**
 * Normalise a user-provided `--dataset` value to the canonical metric alert
 * dataset name accepted by the Sentry API.
 *
 * Resolves known aliases (e.g. `error-events` → `errors`) so that values copied
 * from dashboard docs or using singular forms work without manual
 * translation.
 */
export function normalizeMetricDataset(dataset: string): string {
  const lower = dataset.trim().toLowerCase();
  return METRIC_DATASET_ALIASES[lower] ?? lower;
}

/**
 * Result of resolving a `--dataset` value, accounting for the deprecated
 * `transaction(s)` datasets that now route to `spans`.
 */
export type ResolvedMetricDataset = {
  /** Canonical dataset to send to the API. */
  readonly dataset: string;
  /** Query with `is_transaction:true` appended when routed off `transaction(s)`. */
  readonly query: string;
  /** A gentle one-line nudge to show the user, or `undefined` when none applies. */
  readonly notice?: string;
};

/**
 * Append the `is_transaction:true` filter to a query, unless it is already
 * present. Keeps existing filters intact and avoids duplicate tokens.
 */
function appendIsTransactionFilter(query: string): string {
  const trimmed = query.trim();
  const tokens = trimmed.length > 0 ? trimmed.split(QUERY_TOKEN_SEPARATOR) : [];
  if (tokens.includes(IS_TRANSACTION_FILTER)) {
    return trimmed;
  }
  return [...tokens, IS_TRANSACTION_FILTER].join(" ");
}

/**
 * Resolve a user-provided `--dataset` (and its accompanying `--query`) to the
 * dataset/query actually sent to the API.
 *
 * The `transactions` dataset was removed from alerts; the same use cases are
 * served by `spans` filtered to transaction-like spans. Rather than hard-fail a
 * `transaction(s)` request, route it to `spans` and add `is_transaction:true`
 * to the query so existing muscle memory keeps working, returning a `notice`
 * that nudges the user toward the canonical form.
 */
export function resolveMetricDataset(
  dataset: string,
  query: string,
): ResolvedMetricDataset {
  const lower = dataset.trim().toLowerCase();
  if (TRANSACTION_DATASET_NAMES.has(lower)) {
    return {
      dataset: "spans",
      query: appendIsTransactionFilter(query),
      notice: `The '${lower}' dataset is no longer supported for alerts. Routing to the 'spans' dataset with '${IS_TRANSACTION_FILTER}' added to the query. Use --dataset spans directly to silence this notice.`,
    };
  }
  return { dataset: normalizeMetricDataset(dataset), query };
}

/** Validate that `dataset` is one of the allowed Sentry metric alert dataset values. */
export function validateMetricDataset(dataset: string): void {
  const normalized = normalizeMetricDataset(dataset);
  if (METRIC_DATASET_VALUES.has(normalized)) {
    return;
  }
  throw new ValidationError(
    `dataset must be one of: ${[...METRIC_DATASET_VALUES].join(", ")}.`,
    "dataset",
  );
}

/** Validate that `timeWindow` is one of the allowed metric alert window sizes (in minutes). */
export function validateMetricTimeWindow(timeWindow: number): void {
  if (METRIC_TIME_WINDOWS.has(timeWindow)) {
    return;
  }
  throw new ValidationError(
    `timeWindow must be one of: ${[...METRIC_TIME_WINDOWS].join(", ")} minutes.`,
    "timeWindow",
  );
}

const METRIC_TRIGGER_LABELS = new Set(["critical", "warning"]);

/** Whether a trigger is a native detector condition rather than an `alertThreshold` trigger. */
function isDetectorCondition(trigger: Record<string, unknown>): boolean {
  return typeof trigger.type === "string";
}

/**
 * Validate one native detector condition (`{type, comparison, conditionResult}`).
 * The backend checks the operator and priority values; only presence is checked here.
 */
function validateNativeMetricCondition(trigger: Record<string, unknown>): void {
  if (
    trigger.comparison === undefined ||
    trigger.conditionResult === undefined
  ) {
    throw new ValidationError(
      "Detector conditions with 'type' must include comparison and conditionResult.",
      "trigger",
    );
  }
}

/** Validate one `alertThreshold`-style trigger. */
function validateThresholdTrigger(trigger: Record<string, unknown>): void {
  const threshold = trigger.alertThreshold;
  if (
    (typeof threshold !== "number" && typeof threshold !== "string") ||
    !Number.isFinite(Number(threshold))
  ) {
    throw new ValidationError(
      "Each trigger must include a numeric alertThreshold.",
      "trigger",
    );
  }
  if (
    trigger.label !== undefined &&
    !METRIC_TRIGGER_LABELS.has(String(trigger.label).toLowerCase())
  ) {
    throw new ValidationError(
      `Trigger label must be 'critical' or 'warning' (got ${JSON.stringify(trigger.label)}).`,
      "trigger",
    );
  }
  if (Array.isArray(trigger.actions) && trigger.actions.length > 0) {
    throw new ValidationError(
      "Metric alerts no longer carry notification actions on triggers. " +
        "Remove 'actions' and connect an existing alert with --workflow <id>.",
      "trigger",
    );
  }
}

/**
 * Validate metric alert triggers.
 *
 * Each trigger is either a threshold (`alertThreshold`, optional `label`
 * critical|warning, `resolveThreshold`, `thresholdType` 0 above / 1 below) or
 * a native detector condition (`type`, `comparison`, `conditionResult`).
 * Notification actions are rejected: the detectors API does not accept them,
 * so they would otherwise be dropped silently.
 */
export function validateMetricTriggers(
  triggers: readonly Record<string, unknown>[] | undefined,
): void {
  if (!triggers || triggers.length === 0) {
    throw new ValidationError(
      "Pass at least one --trigger JSON object.",
      "trigger",
    );
  }

  const nativeCount = triggers.filter(isDetectorCondition).length;
  if (nativeCount > 0 && nativeCount < triggers.length) {
    throw new ValidationError(
      "Do not mix detector conditions (with 'type') and alertThreshold triggers.",
      "trigger",
    );
  }

  for (const trigger of triggers) {
    if (isDetectorCondition(trigger)) {
      validateNativeMetricCondition(trigger);
    } else {
      validateThresholdTrigger(trigger);
    }
  }
}

/** Parse `--workflow` values (repeatable or comma-separated) into numeric workflow ids. */
export function parseWorkflowIds(
  values: readonly string[] | undefined,
): number[] | undefined {
  const ids = normalizeProjectList(values);
  if (!ids) {
    return;
  }
  return ids.map((id) => {
    if (!WORKFLOW_ID_PATTERN.test(id)) {
      throw new ValidationError(
        `Workflow id must be numeric (got ${JSON.stringify(id)}).`,
        "workflow",
      );
    }
    return Number(id);
  });
}

/** Map a human-readable status string to the numeric value the metric alert API expects. */
export function statusToMetricValue(status: "active" | "disabled"): 0 | 1 {
  return status === "active" ? 0 : 1;
}
