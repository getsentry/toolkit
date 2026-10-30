import { parseFunction } from "@sentry/toolkit-core/events-fields";
import { getSortField } from "@sentry/toolkit-core/events-sort";
import type { PublicEventsDataset } from "../../../utils/events-datasets";

const TIMESTAMP_AGGREGATE_HINT =
  "In logs and metrics, `timestamp` is a string. Use `min(timestamp_precise)` or `max(timestamp_precise)` for the earliest or latest time; they return Unix timestamps in nanoseconds.";
const FIRST_SEEN_HINT =
  "The errors dataset has no `first_seen()`. Use `min(timestamp)` for the first occurrence, and `max(timestamp)` or `last_seen()` for the latest.";
const ISSUE_SORT_HINT =
  "The errors dataset cannot sort by `issue`. Sort by an aggregate such as `-count()`, or by `issue.id`.";

/**
 * Recovery hints for field expressions Sentry rejects in a dataset.
 *
 * Each hint needs both the expression in the request and Sentry's matching
 * diagnostic, so unrelated failures stay unchanged. Hints are fixed text and
 * never echo caller input.
 */
export function getFieldRecoveryHints({
  dataset,
  fields,
  sort,
  detail,
}: {
  dataset: PublicEventsDataset;
  fields: readonly string[];
  sort: string;
  detail: string;
}): string[] {
  const sortField = getSortField(sort.trim());
  const expressions = [...fields, sortField].map(parseFunction);
  const hints: string[] = [];

  if (
    (dataset === "logs" || dataset === "metrics") &&
    expressions.some(
      (parsed) =>
        (parsed?.name === "min" || parsed?.name === "max") &&
        parsed.arguments.length === 1 &&
        parsed.arguments[0] === "timestamp" &&
        detail.includes(
          `timestamp is invalid for parameter 1 in ${parsed.name}.`,
        ),
    )
  ) {
    hints.push(TIMESTAMP_AGGREGATE_HINT);
  }

  if (
    dataset === "errors" &&
    expressions.some((parsed) => parsed?.name === "first_seen") &&
    detail.includes("first_seen is not a valid function")
  ) {
    hints.push(FIRST_SEEN_HINT);
  }

  if (
    dataset === "errors" &&
    sortField === "issue" &&
    detail.includes("Cannot sort by a field that is not selected.")
  ) {
    hints.push(ISSUE_SORT_HINT);
  }

  return hints;
}
