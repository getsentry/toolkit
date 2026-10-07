---
name: sentry-cli-explore
version: 0.48.0-dev.0
description: Query aggregate event data (Explore)
requires:
  bins: ["sentry"]
  auth: true
---

# Explore Commands

Query aggregate event data (Explore)

### `sentry explore [<target>]`

Query aggregate event data (Explore)

**Flags:**
- `-F, --field <value>... - API field or aggregate (repeatable). E.g., title, "count()", "p50(span.duration)"`
- `-m, --metric <value> - Metric name for --dataset metrics. Auto-resolves type/unit via API.`
- `--agg <value> - Aggregation for --metric (sum, avg, count, p50, p95, etc.) - (default: "sum")`
- `-d, --dataset <value> - Dataset to query (errors, spans, metrics, logs, replays; transaction(s) routes to spans) - (default: "errors")`
- `-q, --query <value> - Search query (Sentry search syntax)`
- `-s, --sort <value> - Sort field (prefix with - for desc, e.g., "-count()")`
- `-e, --environment <value>... - Environment filter (repeatable, comma-separated)`
- `-n, --limit <value> - Number of rows (1-1000) - (default: "25")`
- `-t, --period <value> - Time range: "7d", "2024-01-01..2024-02-01", ">=2024-01-01" - (default: "24h")`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`
- `-c, --cursor <value> - Navigate pages: "next", "prev", "first" (or raw cursor string)`

**Examples:**

```bash
# Top errors in the last 24 hours, scoped to a project
sentry explore my-org/cli

# All projects in an org
sentry explore my-org/

# Bare project slug (searches across orgs)
sentry explore cli

# Auto-detect from DSN/config
sentry explore

# Errors with user impact for a specific UTC window
sentry explore my-org/cli -F title -F "count()" -F "count_unique(user)" \
  --period "2024-01-15T00:00:00Z/2024-01-16T00:00:00Z"

# Filter by specific error type (combines with auto-injected project filter)
sentry explore my-org/cli -F title -F "count()" \
  -q "error.type:TypeError" --period 1h

# Span operation latency by route
sentry explore my-org/cli -F span.op -F "p50(span.duration)" \
  -F "p95(span.duration)" --dataset spans --period 1h

# Top spans by count
sentry explore my-org/cli -F span.op -F "count()" \
  --dataset spans --sort "-count()"

# Sum a custom metric (e.g., LLM token usage) across an org
sentry explore my-org/ -m llm.token_usage --dataset metrics --period 7d

# Break down by a tag column (e.g., model name)
sentry explore my-org/seer -F gen_ai.request.model \
  -m llm.token_usage --dataset metrics --period 7d

# Use a different aggregation (default is sum)
sentry explore my-org/ -m cache.hit_rate --agg avg --dataset metrics

sentry explore my-org/ \
  -F "sum(value,llm.token_usage,distribution,none)" \
  --dataset metrics --period 7d

# List recent replays
sentry explore my-org/cli --dataset replays --period 24h

# Filter replays by activity level
sentry explore my-org/cli --dataset replays -F activity -F duration \
  -F "count_errors" --period 7d

# Log severity counts in the last hour
sentry explore my-org/cli -F severity -F "count()" \
  --dataset logs --period 1h

# Pipe to jq for filtering
sentry explore my-org/cli -F title -F "count()" --json | jq '.data[:5]'

# Get raw data for analysis
sentry explore my-org/cli -F title -F "count()" -F "count_unique(user)" \
  --json --limit 100
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
