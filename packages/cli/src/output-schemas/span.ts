/**
 * Output schemas of the `sentry span` commands.
 */

import {
  description,
  looseObject,
  nullable,
  number,
  optional,
  pipe,
  string,
} from "valibot";

/**
 * A span as `span list` outputs it: a {@link SpanListItem} with the fields
 * `spanListItemToFlatSpan` renames, plus any custom attributes `--fields`
 * requested.
 */
export const FlatSpanSchema = pipe(
  looseObject({
    span_id: pipe(string(), description("Span ID")),
    trace_id: optional(pipe(string(), description("Trace ID"))),
    parent_span_id: optional(
      nullable(pipe(string(), description("Parent span ID"))),
    ),
    op: optional(
      pipe(string(), description("Span operation (e.g. http.client, db)")),
    ),
    description: optional(
      nullable(pipe(string(), description("Span description"))),
    ),
    duration_ms: optional(pipe(number(), description("Duration (ms)"))),
    start_timestamp: pipe(number(), description("Start time (Unix seconds)")),
    project_slug: optional(pipe(string(), description("Project slug"))),
    transaction: optional(pipe(string(), description("Transaction name"))),
  }),
  description("Span list item"),
);
