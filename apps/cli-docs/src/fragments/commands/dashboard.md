

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

Widget add and edit accept `--transformations` as a JSON object. Keys are
zero-based aggregate positions in the first query. Arrays contain transformations
in execution order. Each supplied array replaces that position's transformations.
Omitted positions preserve saved values. An empty array clears a position.
An empty object changes nothing.

For example, `--transformations '{"0":["fill(linear)","smooth(ema,7)"],"1":[]}'`
sets ordered transformations on position 0 and clears position 1.

Transformations support `spans`, `logs`, and `tracemetrics` datasets with `line`,
`area`, or `bar` displays. Each axis accepts one `fill` transformation and one
`smooth` transformation, in either order. Supported transformations are
`fill(zero)`, `fill(linear)`, `fill(locf)`, `smooth(sma,N)`, `smooth(ema,N)`,
`smooth(ema,N,A)`, `smooth(asap)`, and `smooth(asap,N)`. `N` is a positive integer
window size. EMA's optional `A` is a factor greater than 0 and at most 1. ASAP
selects its window automatically when `N` is omitted.

Changing the ordered aggregate list with `--query` requires explicit
transformations or `[]` for every saved transformed position. This prevents
transformations from silently moving to another aggregate, including a duplicate.
Use `[]` to acknowledge a removed position. Positions without saved
transformations need no correction, except removed positions with saved empty
arrays.

Saving nonempty transformation lists requires the organization feature.
Unrelated edits preserve saved transformations when the feature is disabled.
Explicit clears remove the selected axes from the saved map. Clearing every
transformed axis sends an empty map. Changing to an unsupported display or dataset
requires clearing transformations from every query.

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
