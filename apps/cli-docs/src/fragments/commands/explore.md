

## Examples

### Top errors (default)

```bash
# Top errors in the last 24 hours, scoped to a project
sentry explore my-org/cli

# All projects in an org
sentry explore my-org/

# Bare project slug (searches across orgs)
sentry explore cli

# Auto-detect from DSN/config
sentry explore
```

### Spike analysis

```bash
# Errors with user impact for a specific UTC window
sentry explore my-org/cli -F title -F "count()" -F "count_unique(user)" \
  --period "2024-01-15T00:00:00Z/2024-01-16T00:00:00Z"

# Filter by specific error type (combines with auto-injected project filter)
sentry explore my-org/cli -F title -F "count()" \
  -q "error.type:TypeError" --period 1h
```

### Span queries (performance)

```bash
# Span operation latency by route
sentry explore my-org/cli -F span.op -F "p50(span.duration)" \
  -F "p95(span.duration)" --dataset spans --period 1h

# Top spans by count
sentry explore my-org/cli -F span.op -F "count()" \
  --dataset spans --sort "-count()"
```

### Metrics

Use `--metric` (`-m`) to query metrics by name. The CLI auto-resolves the metric's type and unit.

```bash
# Sum a custom metric (e.g., LLM token usage) across an org
sentry explore my-org/ -m llm.token_usage --dataset metrics --period 7d

# Break down by a tag column (e.g., model name)
sentry explore my-org/seer -F gen_ai.request.model \
  -m llm.token_usage --dataset metrics --period 7d

# Use a different aggregation (default is sum)
sentry explore my-org/ -m cache.hit_rate --agg avg --dataset metrics
```

You can also use the raw tracemetrics format: `aggregation(value,metric_name,metric_type,unit)`.

```bash
sentry explore my-org/ \
  -F "sum(value,llm.token_usage,distribution,none)" \
  --dataset metrics --period 7d
```

### Replays

```bash
# List recent replays
sentry explore my-org/cli --dataset replays --period 24h

# Filter replays by activity level
sentry explore my-org/cli --dataset replays -F activity -F duration \
  -F "count_errors" --period 7d
```

### Logs

```bash
# Log severity counts in the last hour
sentry explore my-org/cli -F severity -F "count()" \
  --dataset logs --period 1h
```

### JSON output for scripting

```bash
# Pipe to jq for filtering
sentry explore my-org/cli -F title -F "count()" --json | jq '.data[:5]'

# Get raw data for analysis
sentry explore my-org/cli -F title -F "count()" -F "count_unique(user)" \
  --json --limit 100
```

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
