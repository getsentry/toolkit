/**
 * Shared validation and parsing helpers for alert mutation commands (create/edit).
 */

import type {
  DatasetCompletion,
  DatasetFields,
} from "../../lib/completion-target.js";
import { ValidationError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import {
  METRIC_ALERT_DATASET_ALIASES,
  METRIC_ALERT_DATASET_NAMES,
  type MetricAlertDataset,
  metricAlertSource,
} from "../../types/metric-alert.js";

const log = logger.withTag("alert");

/** Match modes of an issue alert's filter group. */
export const ISSUE_MATCH_MODES = ["all", "any"] as const;
/** Deprecated dataset names that now route to `spans` with `is_transaction:true`. */
const TRANSACTION_DATASET_NAMES = new Set(["transaction", "transactions"]);

/*
 * Aggregates metric alerts accept, from getsentry/sentry (`@sentry/api`
 * types detector `data_sources` as `Array<unknown>`, so it has none):
 * - Spans and logs (EAP) skip column checks for the functions in
 *   `EAP_FUNCTIONS` (`sentry.incidents.logic`); the subscription then
 *   resolves them with the dataset's EAP definitions, so logs, which have
 *   no formulas (`sentry.search.eap.ourlogs.aggregates`), take only the
 *   plain aggregates.
 * - Errors take a function of no column or of `user`, `release`, `dist`
 *   (`SUPPORTED_COLUMNS`, `TRANSLATABLE_COLUMNS` in the same module).
 * - Crash rate takes only `percentage(sessions_crashed|users_crashed,
 *   sessions|users)` (`CRASH_RATE_ALERT_AGGREGATE_RE` in
 *   `sentry.snuba.entity_subscription`).
 */

/** `EAP_FUNCTIONS` that logs also define. */
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
export const METRIC_ALERT_FIELD_COMPLETION: DatasetCompletion = {
  datasets: {
    errors: ERROR_ALERT_FIELDS,
    events: ERROR_ALERT_FIELDS,
    spans: { entity: "span-attribute", functions: SPAN_ALERT_FUNCTIONS },
    logs: { entity: "log-attribute", functions: LOG_ALERT_FUNCTIONS },
    metrics: CRASH_RATE_ALERT_FIELDS,
    sessions: CRASH_RATE_ALERT_FIELDS,
  } satisfies Record<MetricAlertDataset, DatasetFields>,
  aliases: {
    ...METRIC_ALERT_DATASET_ALIASES,
    ...Object.fromEntries(
      [...TRANSACTION_DATASET_NAMES].map((name) => [name, "spans"]),
    ),
  },
};

/** Query filter appended when migrating a `transaction(s)` request to `spans`. */
const IS_TRANSACTION_FILTER = "is_transaction:true";

/** Splits a query string on runs of whitespace. */
const QUERY_TOKEN_SEPARATOR = /\s+/;
/** Workflow (alert) ids are numeric. */
const WORKFLOW_ID_PATTERN = /^\d+$/;
const METRIC_TIME_WINDOWS = new Set([
  1, 5, 10, 15, 30, 60, 120, 240, 360, 720, 1440,
]);

/** The `--time-window` values a metric alert accepts, offered by completion. */
export const METRIC_TIME_WINDOW_VALUES = [...METRIC_TIME_WINDOWS].map(String);

/** Parse and validate an "all" | "any" match mode flag. Returns `undefined` when absent. */
export function parseMatchMode(
  value: string | undefined,
  field: "action-match" | "filter-match",
): "all" | "any" | undefined {
  if (value === undefined || value === "") {
    return;
  }
  const normalized = value.trim().toLowerCase();
  if ((ISSUE_MATCH_MODES as readonly string[]).includes(normalized)) {
    return normalized as (typeof ISSUE_MATCH_MODES)[number];
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

/** Statuses `--status` sets on an alert rule. */
export const RULE_STATUSES = ["active", "disabled"] as const;

/** Parse and validate an "active" | "disabled" status flag. Returns `undefined` when absent. */
export function parseStatusFlag(
  value: string | undefined,
): (typeof RULE_STATUSES)[number] | undefined {
  if (value === undefined || value === "") {
    return;
  }
  const normalized = value.trim().toLowerCase();
  if ((RULE_STATUSES as readonly string[]).includes(normalized)) {
    return normalized as (typeof RULE_STATUSES)[number];
  }
  throw new ValidationError(
    `Status must be 'active' or 'disabled' (got ${JSON.stringify(value)}).`,
    "status",
  );
}

/*
 * Issue-alert triggers whose comparison is a plain boolean: the
 * `WorkflowTriggerDataConditionHandler`s in getsentry/sentry
 * (`sentry.workflow_engine.handlers.condition`) with
 * `comparison_json_schema = {"type": "boolean"}`. Each is fully described by
 * its type, so `--condition` takes the bare name too.
 */
const ISSUE_TRIGGER_TYPES = [
  "first_seen_event",
  "regression_event",
  "reappeared_event",
  "issue_resolved_trigger",
  "new_high_priority_issue",
  "existing_high_priority_issue",
  "every_event",
] as const;

type IssueTriggerType = (typeof ISSUE_TRIGGER_TYPES)[number];

/** Short names for {@link ISSUE_TRIGGER_TYPES}, after `-` → `_`. */
const ISSUE_TRIGGER_ALIASES: Readonly<Record<string, IssueTriggerType>> = {
  first_seen: "first_seen_event",
  regression: "regression_event",
  reappeared: "reappeared_event",
  resolved: "issue_resolved_trigger",
  issue_resolved: "issue_resolved_trigger",
  new_high_priority: "new_high_priority_issue",
  existing_high_priority: "existing_high_priority_issue",
};

/**
 * Trigger names shown in errors and help: each type's first alias (or the
 * type itself), kebab-cased. `every_event` is accepted but not suggested: an
 * error that offers it would invite an alert on every event.
 */
export const ISSUE_TRIGGER_NAMES = ISSUE_TRIGGER_TYPES.filter(
  (type) => type !== "every_event",
).map((type) =>
  (
    Object.keys(ISSUE_TRIGGER_ALIASES).find(
      (alias) => ISSUE_TRIGGER_ALIASES[alias] === type,
    ) ?? type
  ).replaceAll("_", "-"),
);

const ISSUE_TRIGGER_KEYS = new Set(["type", "comparison", "conditionResult"]);

/** One shell word of a JSON value whose double quotes were stripped. */
const BARE_JSON_TOKEN = /\s*(?:([{}[\]:,])|([\w.+-]+))\s*/y;
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const JSON_LITERALS = new Set(["true", "false", "null"]);
/** Separates trigger names in one `--condition first-seen,regression` value. */
const TRIGGER_NAME_SEPARATOR = /\s*,\s*/;

function resolveTriggerName(name: string): IssueTriggerType | undefined {
  const normalized = name.trim().toLowerCase().replaceAll("-", "_");
  if ((ISSUE_TRIGGER_TYPES as readonly string[]).includes(normalized)) {
    return normalized as IssueTriggerType;
  }
  return ISSUE_TRIGGER_ALIASES[normalized];
}

function triggerCondition(type: IssueTriggerType): Record<string, unknown> {
  return { type, comparison: true, conditionResult: true };
}

/**
 * Re-add the double quotes a shell stripped from a JSON value, as Windows
 * PowerShell 5.1 does with arguments to native programs:
 * `{type:first_seen_event}` → `{"type":"first_seen_event"}`.
 *
 * Only words of letters, digits, `_`, `.`, `+`, and `-` are re-quoted; any
 * other character means the original string boundaries are unknown, so it
 * returns `undefined`. So do two adjacent words (`value:status code`), which
 * leave invalid JSON. A word that reads as a number or `true`/`false`/`null`
 * stays one, so callers must only trust the result where that cannot matter.
 * Objects come back in an array.
 */
function requoteBareJson(raw: string): unknown {
  const text = raw.trim();
  if (!(text.startsWith("{") || text.startsWith("["))) {
    return;
  }
  let json = "";
  let index = 0;
  while (index < text.length) {
    BARE_JSON_TOKEN.lastIndex = index;
    const match = BARE_JSON_TOKEN.exec(text);
    if (!match) {
      return;
    }
    const [, punctuation, word = ""] = match;
    json +=
      punctuation ??
      (JSON_LITERALS.has(word) || JSON_NUMBER.test(word)
        ? word
        : JSON.stringify(word));
    index = BARE_JSON_TOKEN.lastIndex;
  }
  try {
    // Wrap objects so `{...},{...}` (comma-joined) reads as well.
    return JSON.parse(text.startsWith("{") ? `[${json}]` : json);
  } catch (error) {
    log.debug("Re-quoted value is not valid JSON either", error);
    return;
  }
}

/**
 * Map a re-quoted `--condition` value to trigger conditions, or return
 * `undefined`. Accepts only boolean triggers with no other keys and no
 * `false` comparisons: then the type alone determines the object, and
 * re-quoting cannot have changed what the user meant.
 */
function toTriggerConditions(
  value: unknown,
): Record<string, unknown>[] | undefined {
  const entries = Array.isArray(value) ? value : [value];
  const conditions: Record<string, unknown>[] = [];
  for (const entry of entries) {
    if (!isJsonObject(entry)) {
      return;
    }
    const type = ISSUE_TRIGGER_TYPES.find((t) => t === entry.type);
    const exact =
      Object.keys(entry).every((key) => ISSUE_TRIGGER_KEYS.has(key)) &&
      (entry.comparison ?? true) === true &&
      (entry.conditionResult ?? true) === true;
    if (!(type && exact)) {
      return;
    }
    conditions.push(triggerCondition(type));
  }
  return conditions;
}

/** `{...},{...}`: several objects joined by commas instead of an array. */
function parseCommaJoinedObjects(raw: string): unknown[] | undefined {
  const text = raw.trim();
  if (!(text.startsWith("{") && text.endsWith("}"))) {
    return;
  }
  try {
    const parsed: unknown = JSON.parse(`[${text}]`);
    return Array.isArray(parsed) && parsed.every(isJsonObject)
      ? parsed
      : undefined;
  } catch (error) {
    log.debug("Value is not comma-joined JSON objects", error);
    return;
  }
}

/** Error for a value that is not JSON and could not be recovered. */
function invalidJsonError(raw: string, field: string): ValidationError {
  let message = `${field} must be valid JSON (got ${JSON.stringify(raw)}).`;
  if (requoteBareJson(raw) !== undefined) {
    message +=
      "\n  The shell seems to have stripped the double quotes (Windows PowerShell 5.1" +
      '\n  does this): escape them as \\" or use PowerShell 7.3+.';
  }
  return new ValidationError(message, field);
}

function parseJsonValue(
  raw: string,
  field: string,
  recover?: (raw: string) => unknown,
): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    log.debug(`${field} value is not valid JSON`, error);
  }
  const joined = parseCommaJoinedObjects(raw);
  if (joined) {
    log.warn(
      `Read --${field} ${JSON.stringify(raw)} as a JSON array of ${joined.length} objects.`,
    );
    return joined;
  }
  const recovered = recover?.(raw);
  if (recovered !== undefined) {
    return recovered;
  }
  throw invalidJsonError(raw, field);
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
 * Each value is a JSON object, a JSON array of objects, or objects joined by
 * commas (`{...},{...}`, read as an array with a warning). `recover` may map a
 * value that is not JSON to objects instead of failing. Returns `undefined`
 * when absent.
 */
export function parseJsonObjectList(
  values: readonly string[] | undefined,
  field: string,
  recover?: (raw: string) => unknown,
): Record<string, unknown>[] | undefined {
  if (!values || values.length === 0) {
    return;
  }

  return values.flatMap((value) => {
    const parsed = parseJsonValue(value, field, recover);
    const entries: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    return entries.map((entry) => toObject(entry, field));
  });
}

const TRIGGER_USAGE = `Pass a trigger name (${ISSUE_TRIGGER_NAMES.join(", ")}) or JSON like '{"type":"first_seen_event","comparison":true,"conditionResult":true}'.`;

/**
 * Recover a `--condition` value that is not JSON: trigger names
 * (`first-seen`, `first_seen_event,regression`) or trigger JSON whose double
 * quotes a shell stripped. Returns `undefined` when neither applies.
 */
function recoverTriggerConditions(
  raw: string,
): Record<string, unknown>[] | undefined {
  const names = raw.split(TRIGGER_NAME_SEPARATOR).map(resolveTriggerName);
  if (names.every((type): type is IssueTriggerType => type !== undefined)) {
    return names.map(triggerCondition);
  }
  const requoted = requoteBareJson(raw);
  const conditions =
    requoted === undefined ? undefined : toTriggerConditions(requoted);
  if (conditions) {
    log.warn(
      `--condition ${JSON.stringify(raw)} is missing its double quotes (the shell stripped them); ` +
        `using ${JSON.stringify(conditions)}.`,
    );
  }
  return conditions;
}

/**
 * Parse `--condition` values into issue-alert trigger conditions.
 *
 * Takes everything {@link parseJsonObjectList} does, plus trigger names
 * (`first-seen`, `regression`, or the API type such as `first_seen_event`),
 * comma-separated in one value or repeated, and trigger JSON whose double
 * quotes the shell stripped.
 */
export function parseIssueConditions(
  values: readonly string[] | undefined,
): Record<string, unknown>[] | undefined {
  try {
    return parseJsonObjectList(values, "condition", recoverTriggerConditions);
  } catch (error) {
    if (error instanceof ValidationError && error.field === "condition") {
      throw new ValidationError(
        `${error.message}\n  ${TRIGGER_USAGE}`,
        "condition",
      );
    }
    throw error;
  }
}

/**
 * Require an issue alert to have triggers or action filters.
 *
 * The workflow engine treats an empty trigger group as triggered by every
 * event (`process_data_condition_group` in getsentry/sentry), so filters alone
 * make a valid alert: "every event that matches these filters". With neither,
 * the alert would fire on every event, which is never what an omitted
 * `--condition` means, so that stays an error.
 */
export function validateIssueTriggers(
  conditions: readonly Record<string, unknown>[] | undefined,
  filters: readonly unknown[] | undefined,
): void {
  if (conditions && conditions.length > 0) {
    return;
  }
  if (filters && filters.length > 0) {
    log.warn(
      "No --condition trigger: the alert checks its --filter conditions on every event.",
    );
    return;
  }
  throw new ValidationError(
    `Pass at least one --condition trigger, or --filter conditions to check on every event.\n  ${TRIGGER_USAGE}`,
    "condition",
  );
}

/** Require at least one entry in the actions array. */
export function validateIssueActions(
  actions: readonly Record<string, unknown>[] | undefined,
): void {
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
  return METRIC_ALERT_DATASET_ALIASES[lower] ?? lower;
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
  if (metricAlertSource(normalizeMetricDataset(dataset))) {
    return;
  }
  throw new ValidationError(
    `dataset must be one of: ${METRIC_ALERT_DATASET_NAMES.join(", ")}.`,
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
