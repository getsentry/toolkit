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

/** Match narrow backend diagnostics without maintaining an aggregate catalog. */
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
}

/**
 * Add a correction for a known rejected user expression, preserving the server
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
