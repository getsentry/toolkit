

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

Widget add and edit use `--transform-fill` and `--transform-smooth` to configure
transformations. `--transform-aggregate 2` selects the second aggregate in the
first query, matching the number in human output. Use `all` to apply the same edit
to every aggregate. The selector is optional when there is exactly one aggregate.
Multiple aggregates require an explicit selector, even when they have identical
expressions. The selector applies to the whole command, regardless of flag order.

For example, `--transform-aggregate 2 --transform-fill linear` replaces filling on
aggregate 2. It preserves that aggregate's smoothing and all other aggregates.
Use `--transform-fill none` or `--transform-smooth none` to remove one kind.
`--transform-clear` removes both kinds and conflicts with other transformation
settings.

`--transform-fill` accepts `zero`, `linear`, `locf`, or `none`.
`--transform-smooth` accepts `sma`, `ema`, `asap`, or `none`.
SMA and EMA require a positive integer `--transform-window`.
ASAP uses an automatic window unless `--transform-window` supplies a maximum.
EMA accepts an optional `--transform-alpha` greater than 0 and at most 1.
Window and alpha flags require an explicit compatible `--transform-smooth`.

Omitting a kind preserves its complete saved configuration. Supplying
`--transform-smooth` replaces its full configuration. For example,
`--transform-smooth ema --transform-window 7` uses automatic alpha, even if the
saved EMA has an explicit alpha.

Existing pairs preserve their application order. New pairs default to fill first.
`--transform-order fill-first` or `smooth-first` overrides that order and requires
both kinds to remain active. Flag order has no effect on application order.
Transformations support `spans`, `logs`, and `tracemetrics` datasets with `line`,
`area`, or `bar` displays.

Changing the ordered aggregate list with `--query` requires a complete decision
for every saved transformed position. Explicitly set both `--transform-fill` and
`--transform-smooth`, using `none` for an absent kind, or use `--transform-clear`.
This prevents saved transformations from moving to another aggregate.
`--transform-aggregate all --transform-clear` also clears removed positions,
including saved empty lists. An unchanged aggregate list needs no correction.
Different settings on several aggregates require separate commands. To replace
an aggregate list with different settings, clear all transformations while
changing `--query`, then configure each aggregate separately.

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
