---
name: sentry-cli-trace
version: 0.48.0-dev.0
description: View distributed traces
requires:
  bins: ["sentry"]
  auth: true
---

# Trace Commands

View distributed traces

### `sentry trace list [<org/project>]`

List recent traces in a project

**Arguments:**

| Argument | Description |
|----------|-------------|
| `[<org/project>]` | &lt;org&gt;/&lt;project&gt; or &lt;project&gt; (search) |

**Flags:**
- `-n, --limit <value> - Number of traces (1-1000) - (default: "25")`
- `-q, --query <value> - Search query (Sentry search syntax)`
- `-s, --sort <value> - Sort by: date, duration - (default: "date")`
- `-t, --period <value> - Time range: "7d", "2024-01-01..2024-02-01", ">=2024-01-01" - (default: "7d")`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`
- `-c, --cursor <value> - Navigate pages: "next", "prev", "first" (or raw cursor string)`

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `trace` | string | Trace ID |
| `id` | string | Span ID of the root span |
| `transaction` | string | Transaction name |
| `timestamp` | string | Timestamp (ISO 8601) |
| `span.duration` | number | Duration (ms) |
| `project` | string | Project slug |

**Examples:**

```bash
# List recent traces
sentry trace list

# Show more traces
sentry trace list --limit 50

# Sort by slowest first
sentry trace list --sort duration

# Filter by transaction name in the last 24 hours
sentry trace list -q "transaction:GET /api/users" --period 24h

# Fetch the next page
sentry trace list my-org/backend -c next

# Find a project across organizations
sentry trace list backend
```

### `sentry trace view <org/project/trace-id...>`

View details of a specific trace

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<org/project/trace-id...>` | [&lt;org&gt;/&lt;project&gt;/]&lt;trace-id&gt; - Target (optional) and trace ID (required) |

**Flags:**
- `-w, --web - Open in browser`
- `--full - Fetch full span attributes (auto-enabled with --json)`
- `--spans <value> - Span tree depth limit (number, "all" for unlimited, "no" to disable) - (default: "3")`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`

**Examples:**

```bash
# View trace details with the span tree
sentry trace view abc123def456abc123def456abc12345

# Show the full trace across all projects
sentry trace view my-org/abc123def456abc123def456abc12345

# Filter the span tree to one project
sentry trace view my-org/cli-server/abc123def456abc123def456abc12345

# Recover the trace from an issue short ID
sentry trace view PROJ-123

# Open the trace in the browser
sentry trace view abc123def456abc123def456abc12345 -w

# Find a project across organizations
sentry trace view cli-server abc123def456abc123def456abc12345

# Select the trace ID and an attribute across the whole span tree
sentry trace view abc123def456abc123def456abc12345 --json --fields traceId,http.method

# Keep full spans while requesting an additional attribute
sentry trace view abc123def456abc123def456abc12345 --json --fields spans,http.method

# Select IDs and detail attributes from root spans only
sentry trace view abc123def456abc123def456abc12345 --json --fields spans.span_id,spans.data.http.method

# Select an additional attribute from immediate child spans
sentry trace view abc123def456abc123def456abc12345 --json --fields spans.children.additional_attributes.http.method
```

### `sentry trace logs <org/project/trace-id...>`

View logs associated with a trace

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<org/project/trace-id...>` | [&lt;org&gt;/[&lt;project&gt;/]]&lt;trace-id&gt; - Optional org/project and required trace ID |

**Flags:**
- `-w, --web - Open trace in browser`
- `-t, --period <value> - Time range: "7d", "2024-01-01..2024-02-01", ">=2024-01-01" - (default: "14d")`
- `-n, --limit <value> - Number of log entries (<=1000) - (default: "100")`
- `-q, --query <value> - Filter query (e.g., "severity:error", "project:backend", "project:[a,b]")`
- `-s, --sort <value> - Sort order: "newest" (default) or "oldest" - (default: "newest")`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`

**Examples:**

```bash
# View logs for a trace
sentry trace logs abc123def456abc123def456abc12345

# Filter trace logs to one project
sentry trace logs my-org/cli-server/abc123def456abc123def456abc12345

# Filter trace logs to several projects
sentry trace logs abc123def456abc123def456abc12345 -q "project:[cli-server,api]"

# Search with a longer time window
sentry trace logs --period 30d abc123def456abc123def456abc12345

# Only error logs
sentry trace logs -q 'severity:error' abc123def456abc123def456abc12345

# Output as JSON
sentry trace logs --json abc123def456abc123def456abc12345

# Logs for a trace in an explicit organization
sentry trace logs my-org/abc123def456abc123def456abc12345
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
