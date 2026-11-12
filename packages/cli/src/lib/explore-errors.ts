/**
 * Recovery hints for backend-rejected Explore field expressions.
 * Only attribute a failure to a user flag when that expression reached the
 * request; rejected defaults and generated metric expressions remain API errors.
 */

import { parseFunction } from "@sentry/toolkit-core/events-fields";
import { getSortField } from "@sentry/toolkit-core/events-sort";
import { sentry } from "./app-identity.js";
import { ApiError, type FunctionArgument, validationError } from "./errors.js";

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

/** `code` of a 400 that names the function argument it rejected (getsentry/sentry#129954). */
const INVALID_FUNCTION_ARGUMENT_CODE = "invalid_function_argument";

/**
 * Match narrow backend diagnostics without maintaining an aggregate catalog.
 * Beyond the specific corrections, a 400 whose structured fields name this
 * expression's own function and argument gets the server's hint, or a generic
 * one when the server sent none.
 */
function recoveryHint(
  detail: string,
  rejected: FunctionArgument | undefined,
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
    return `Aggregate functions depend on the dataset. Check the function name and selected dataset; ${sentry`explore --help`} includes usage examples.`;
  }

  if (
    !rejected ||
    rejected.function !== parsed.name ||
    !parsed.arguments.includes(rejected.argument)
  ) {
    return;
  }
  if (rejected.hint) {
    return rejected.hint;
  }
  const { argument } = rejected;
  const problem = `${parsed.name}() does not accept ${argument} on dataset "${dataset}": it may not exist there, or may not have the type ${parsed.name}() needs.`;
  return ATTRIBUTE_DATASETS.has(dataset)
    ? `${problem} Reference a numeric custom attribute with its type, e.g. tags[${argument},number]; to check the key and its type, run: ${sentry`attribute list <org>/ ${argument} --dataset ${dataset}`}`
    : `${problem} Check the column name and its type.`;
}

/** Datasets whose custom attributes use `tags[name,type]` keys listed by `sentry attribute list`. */
const ATTRIBUTE_DATASETS = new Set(["spans", "logs"]);

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

  const rejected =
    error.code === INVALID_FUNCTION_ARGUMENT_CODE
      ? error.functionArgument
      : undefined;
  for (const { expression, value, flag } of expressions) {
    const hint = recoveryHint(
      error.detail,
      rejected,
      expression,
      context.dataset,
    );
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
