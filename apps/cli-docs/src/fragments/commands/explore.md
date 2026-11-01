

## Time series

Use `--time-series` (`-b`) to see how an aggregate changes over time. The target,
`--query`, `--environment`, and `--period` filters work as they do for tabular
queries. Without `--field`, temporal queries count matching events in each time
bucket. For performance analysis, select aggregates such as `p95(span.duration)`;
repeat `--field` to request more than one series.

With no value or `auto`, the CLI chooses a bucket interval from the requested time range.
Pass a duration, such as `--time-series 15m` or `-b 15m`, to set the bucket width.
When omitting the value, place an explicit target before the flag.
Use `--period` (`-t`) to set the overall time range. Each invocation returns a
snapshot and exits; it does not follow live data.

Temporal queries support errors, spans, logs, and metrics. Metrics require
`--metric` or an explicit aggregate in the raw tracemetrics format described
below. Grouping columns, replays, `--sort`, `--limit`, and `--cursor` are not
supported in temporal mode. Use a tabular query to break down a series by a field
or inspect individual events.

JSON output includes `timeSeries`, `meta`, and `dataset`. Each series retains its
bucket timestamps, values, and available sampling or completeness metadata.
Null values remain null, and incomplete buckets remain marked as incomplete;
recent buckets may still be waiting for ingestion or for the interval to end.
Temporal output has no pagination cursor.

In terminals with Kitty or Sixel graphics support, each numeric aggregate gets
its own chart with a value axis, UTC time labels, and a colored aggregate legend,
using the same presentation as dashboard charts. Null and incomplete buckets leave
gaps; a table below the chart retains their timestamps, original values, and
completeness reasons. Complete buckets have at least a baseline tick, including
zero values. The interval and sampling or scan warnings appear in a compact
caption below each chart. The full aggregate expression is included there when
the legend abbreviates it. Ingestion details follow the results. All times are UTC;
the query range in the header is distinct from the bucket-start labels on the axes.

Other terminals use tables, as do series with strings, negative values, irregular
bucket spacing, too many buckets to draw individually, or too little room for
readable axes. The CLI never averages buckets to fit an Explore chart. Use
`SENTRY_NO_GRAPHICS=1` or the graphics default setting to keep table output.
Graphics do not change `--json` or `--fields`.

## Metrics

Use `--metric` (`-m`) to query metrics by name. The CLI auto-resolves the metric's type and unit.
You can also use the raw tracemetrics format: `aggregation(value,metric_name,metric_type,unit)`.

## Datasets

| Dataset | Description |
|---------|-------------|
| `errors` | Error events (default) |
| `spans` | Span/transaction data for performance analysis |
| `metrics` | Custom and built-in metrics |
| `logs` | Structured log entries |
| `replays` | Session replay recordings |

## Rejected expressions

Aggregate support depends on the selected dataset. When Sentry rejects a known
expression supplied through `--field` or `--sort`, Explore preserves the backend
detail and explains how to correct that expression. It does not rewrite or rerun
the query.

Use `count()` to count spans. For the earliest or latest log time, use
`min(timestamp_precise)` or `max(timestamp_precise)`; their results are Unix
timestamps in nanoseconds, rather than formatted timestamps. A function accepted
by one dataset may be unsupported by another.

## Target Patterns

| Target | Behavior |
|--------|----------|
| `<org>/<project>` | Auto-adds `project:<slug>` to query |
| `<org>/` | All projects in org (no project filter) |
| `<project>` | Searches for project across all accessible orgs |
| (omitted) | Auto-detect from DSN/config |
