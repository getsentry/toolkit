

## Dashboard references

Numeric IDs accept `org/ID` and `org/project/ID` in `view`, `revisions`,
`restore`, and the widget commands. Dashboards belong to the organization;
the optional project segment does not filter the dashboard.

Titles containing `/` are still supported. If a title looks like a qualified
numeric ID, pass the organization separately to select it by title:
`sentry dashboard view my-org/ "incidents/2026"`.

Use `sentry dashboard revisions` to find a revision number before running
`sentry dashboard restore`.

## Saved transformations

Widget add, edit, and delete commands retain saved transformations on
untouched widgets. Title, layout, and filter edits preserve transformation order
and aggregate positions, including separate transformations for duplicate aggregates.
Query flags edit the first query and retain the remaining queries.

`dashboard view` executes saved transformations for span, log, and trace-metric chart
widgets. It prints exact values and provenance in full tables below the dashboard
grid. `null` marks a gap. The tables retain each query, axis, group, unit, comparison
value, and returned bucket flag. JSON uses a `transformed_timeseries` result with
one complete API response per saved query. Its timestamps and executed intervals
are in milliseconds.

Saved widget intervals take priority over automatic chart sizing. Use
`sentry dashboard view my-org/123 --interval 5m` to override them. Output records
the requested interval and each series' executed interval. Terminal resizing does
not change an explicit interval. Empty results have no executed interval.

Transformed tables, big numbers, and unsupported datasets report an unsupported
result. An unavailable transformation feature or a server that does not confirm
execution produces an explicit result instead of displaying raw values.

## Query Shorthand

The `--query` flag supports shorthand for aggregate functions:

| Input | Expands to |
|-------|-----------|
| `count` | `count()` |
| `p95:span.duration` | `p95(span.duration)` |
| `avg:span.duration` | `avg(span.duration)` |
| `count()` | `count()` (passthrough) |

## Sort Shorthand

| Input | Meaning |
|-------|---------|
| `count` | Sort by `count()` ascending |
| `-count` | Sort by `count()` descending |
