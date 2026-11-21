

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

`dashboard view` and `dashboard widget edit` also show each transformed series
of the first query the way `--transform` writes it.

## Transformations

Write transformations around a `--query` aggregate. Calls nest, and the
innermost runs first: `--query 'smooth(fill(count, linear), ema, 7)'` fills
gaps in `count()`, then smooths the result. Add `--query count` next to it to
chart the raw series too.

| Transformation | Does |
|----------------|------|
| `fill(<series>, zero)` | Fills gaps with 0 |
| `fill(<series>, linear)` | Interpolates across gaps |
| `fill(<series>, locf)` | Carries the last value forward |
| `smooth(<series>, sma, N)` | Simple moving average over `N` points |
| `smooth(<series>, ema, N[, A])` | Exponential moving average; `A` is in (0, 1] |
| `smooth(<series>, asap[, N])` | ASAP; picks a window when `N` is omitted |

A series takes at most one `fill` and one `smooth`, in either order. The
aggregate inside takes the same shorthand as `--query` (`count`,
`p95:span.duration`). Transformations need the `spans`, `logs`, or
`tracemetrics` dataset with a `line`, `area`, or `bar` display. Shell completion
completes each part: aggregates, `fill(` and `smooth(`, then their arguments.

`widget edit --query` replaces the series list. A series written without
transformations keeps the ones it had: the n-th `count()` keeps those of the
n-th saved `count()`, wherever it moves. A removed series takes its
transformations with it, and the command says so.

`widget edit --transform` sets one series' transformations without restating
`--query`. It names the series by its aggregate, and a bare aggregate clears
them. When the first query has the same aggregate more than once, add `#<n>`
to pick one, counting from 1: `--transform 'smooth(count#2, sma, 5)'` smooths
the second `count()`. Completion offers the widget's own series once its
dashboard has been viewed or edited.

Saving transformations requires the organization feature. Edits that leave
them alone send none, so they work without it. Changing to a dataset or display
without transformations requires clearing them from every query first.

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
