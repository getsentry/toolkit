

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

Widget add, edit, and delete commands retain saved transformations on untouched
widgets. Title, layout, and filter edits preserve transformation order and
aggregate positions, including separate transformation lists for duplicate
aggregates.
Query flags edit the first query and retain the remaining queries.

`dashboard view` and `dashboard widget edit` list each query's saved
transformations by aggregate position, in the order Sentry applies them. JSON
output keeps the saved `transformations` map, keyed by zero-based aggregate
position. Explicitly saved empty transformation lists appear as `none`.
Servers that omit transformation settings show an unavailable notice for each
query. Widgets whose queries report no saved transformations show no extra output.

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
