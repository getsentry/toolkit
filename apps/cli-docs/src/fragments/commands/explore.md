

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

## Target Patterns

| Target | Behavior |
|--------|----------|
| `<org>/<project>` | Auto-adds `project:<slug>` to query |
| `<org>/` | All projects in org (no project filter) |
| `<project>` | Searches for project across all accessible orgs |
| (omitted) | Auto-detect from DSN/config |
