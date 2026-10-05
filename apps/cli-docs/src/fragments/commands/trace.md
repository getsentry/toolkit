

## Examples

### List traces

```bash
# List last 20 traces (default)
sentry trace list

# Sort by slowest first
sentry trace list --sort duration

# Filter by transaction name, last 24 hours
sentry trace list -q "transaction:GET /api/users" --period 24h

# Paginate through results
sentry trace list my-org/backend -c next
```

### View a trace

```bash
# View trace details with span tree
sentry trace view abc123def456abc123def456abc12345

# Open trace in browser
sentry trace view abc123def456abc123def456abc12345 -w

# Auto-recover from an issue short ID
sentry trace view PROJ-123
```

### Cross-project traces

```bash
# Filter trace view to one project's spans
sentry trace view my-org/cli-server/abc123def456abc123def456abc12345

# Full trace across all projects (default)
sentry trace view my-org/abc123def456abc123def456abc12345

# Filter trace logs by project
sentry trace logs my-org/cli-server/abc123def456abc123def456abc12345

# Multiple projects via --query
sentry trace logs abc123def456abc123def456abc12345 -q "project:[cli-server,api]"
```

### View trace logs

```bash
# View logs for a trace
sentry trace logs abc123def456abc123def456abc12345

# Search with a longer time window
sentry trace logs --period 30d abc123def456abc123def456abc12345

# Filter logs within a trace
sentry trace logs -q 'severity:error' abc123def456abc123def456abc12345
```
