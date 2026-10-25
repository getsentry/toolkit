

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
