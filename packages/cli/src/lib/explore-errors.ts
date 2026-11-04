/**
 * Recovery hints for backend-rejected Explore field expressions.
 * Only attribute a failure to a user flag when that expression reached the
 * request; rejected defaults and generated metric expressions remain API errors.
 */

import { parseFunction } from "@sentry/toolkit-core/events-fields";
import { getSortField } from "@sentry/toolkit-core/events-sort";
import { ApiError, validationError } from "./errors.js";

/** User-authored expressions and the request they contributed to. */
type ExploreErrorContext = {
  /** Effective request dataset, using its CLI name. */
  dataset: string;
  /** Fields actually sent after resolving defaults, metrics, and sorting. */
  fields: readonly string[];
  /** Explicit user fields retained by the command, excluding generated fields. */
  userFields: readonly string[];
  /** Effective request sort, including any CLI-generated default. */
  sort: string | undefined;
  /** Explicit --sort input, before resolving a default. */
  userSort: string | undefined;
};

/**
 * Match narrow backend diagnostics without maintaining an aggregate catalog.
 * Beyond the specific corrections, a diagnostic that names this expression's
 * own function and argument gets a generic hint.
 */
function recoveryHint(
  detail: string,
  expression: string,
  dataset: string,
): string | undefined {
  const parsed = parseFunction(expression);
  if (!parsed) {
    return;
  }

  if (
    dataset === "spans" &&
    parsed.name === "count" &&
    parsed.arguments.length === 1 &&
    parsed.arguments[0] === "span" &&
    detail.startsWith("span is invalid for parameter 1 in count.")
  ) {
    return "Use count() to count spans; replace count(span) in --field and any matching --sort. The argument to count is an attribute, not the dataset name.";
  }

  if (
    dataset === "logs" &&
    (parsed.name === "min" || parsed.name === "max") &&
    parsed.arguments.length === 1 &&
    parsed.arguments[0] === "timestamp" &&
    detail.startsWith(`timestamp is invalid for parameter 1 in ${parsed.name}.`)
  ) {
    return "Use min(timestamp_precise) / max(timestamp_precise) for the earliest / latest log time. These return Unix timestamps in nanoseconds, not formatted timestamps.";
  }

  if (detail === `Unknown function ${parsed.name}`) {
    return "Aggregate functions depend on the dataset. Check the function name and selected dataset; sentry explore --help includes usage examples.";
  }

  const rejected = rejectedArgument(detail);
  if (
    !rejected ||
    rejected.name !== parsed.name ||
    !parsed.arguments.includes(rejected.argument)
  ) {
    return;
  }
  const { argument, reason } = rejected;
  // `--dataset transactions` queries spans, which keep durations in span.duration.
  if (dataset === "spans" && argument === "transaction.duration") {
    return "Use span.duration instead of transaction.duration. Transactions are queried as spans, which store their duration in span.duration.";
  }
  const lookup = `sentry attribute list <org>/ ${argument} --dataset ${dataset}`;
  if (reason === "type") {
    return ATTRIBUTE_DATASETS.has(dataset)
      ? `${parsed.name}() needs a numeric attribute, and ${argument} is not numeric on dataset "${dataset}". Reference a numeric custom attribute with its type, e.g. tags[${argument},number]; to find it, run: ${lookup} --type number`
      : `${parsed.name}() needs a numeric column, and ${argument} is not numeric on dataset "${dataset}".`;
  }
  return ATTRIBUTE_DATASETS.has(dataset)
    ? `${parsed.name}() does not accept ${argument} on dataset "${dataset}". Check the attribute key; to find it, run: ${lookup}`
    : `${parsed.name}() does not accept ${argument} on dataset "${dataset}". Check the column name.`;
}

/** Datasets whose custom attributes use `tags[name,type]` keys listed by `sentry attribute list`. */
const ATTRIBUTE_DATASETS = new Set(["spans", "logs"]);

/** Backend diagnostics that name the function and argument they rejected. */
const REJECTED_ARGUMENT_PATTERNS: [RegExp, "type" | "invalid"][] = [
  // e.g. "duration is invalid for parameter 1 in p75. Its a string type field, ..."
  [/^(?<argument>.+?) is invalid for parameter \d+ in (?<name>\w+)\./, "type"],
  // e.g. "min: column argument invalid: title is not a numeric column"
  [
    /^(?<name>\w+): column argument invalid: (?<argument>.+?) is not a numeric column/,
    "type",
  ],
  // e.g. "avg: column argument invalid: memory is not a valid column"
  [
    /^(?<name>\w+): column argument invalid: (?<argument>.+?) is not a valid column/,
    "invalid",
  ],
  // e.g. "severity is not a valid argument for count_if"
  [/^(?<argument>.+?) is not a valid argument for (?<name>\w+)/, "invalid"],
];

/** The function and argument a backend diagnostic rejected, when it names them. */
function rejectedArgument(
  detail: string,
): { name: string; argument: string; reason: "type" | "invalid" } | undefined {
  for (const [pattern, reason] of REJECTED_ARGUMENT_PATTERNS) {
    const groups = pattern.exec(detail)?.groups;
    if (groups?.name && groups.argument) {
      return { name: groups.name, argument: groups.argument, reason };
    }
  }
}

/**
 * Add a correction for a rejected user expression, preserving the server
 * detail. Unknown failures and errors caused by CLI-generated input are returned
 * unchanged so they retain their API error classification and diagnostics.
 */
export function toExploreFieldError(
  error: unknown,
  context: ExploreErrorContext,
): unknown {
  if (!(error instanceof ApiError) || error.status !== 400 || !error.detail) {
    return error;
  }

  const expressions = context.userFields
    .filter((field) => context.fields.includes(field))
    .map((expression) => ({ expression, value: expression, flag: "field" }));
  if (context.userSort?.trim() && context.userSort.trim() === context.sort) {
    expressions.push({
      expression: getSortField(context.userSort.trim()),
      value: context.userSort.trim(),
      flag: "sort",
    });
  }

  for (const { expression, value, flag } of expressions) {
    const hint = recoveryHint(error.detail, expression, context.dataset);
    if (hint) {
      return validationError(
        `Sentry rejected --${flag} "${value}" for dataset "${context.dataset}".\n\n${error.detail}`,
        [hint],
        flag,
      );
    }
  }
  return error;
}
