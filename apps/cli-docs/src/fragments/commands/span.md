

## Examples

### List spans

```bash
# List recent spans in the current project
sentry span list

# Find all DB spans
sentry span list -q "op:db"

# Slow spans in the last 24 hours
sentry span list -q "duration:>100ms" --period 24h

# List spans within a specific trace
sentry span list abc123def456abc123def456abc12345

# Paginate through results
sentry span list -c next
```

### Filter by project in a trace

```bash
# Show only spans from one project within a trace
sentry span list my-org/cli-server/abc123def456abc123def456abc12345

# Or use --query to filter by project
sentry span list abc123def456abc123def456abc12345 -q "project:cli-server"

# Multiple projects at once
sentry span list abc123def456abc123def456abc12345 -q "project:[cli-server,api]"
```

### View spans

```bash
# View a single span
sentry span view abc123def456abc123def456abc12345 a1b2c3d4e5f67890

# View multiple spans at once
sentry span view abc123def456abc123def456abc12345 a1b2c3d4e5f67890 b2c3d4e5f6789012

# With explicit org/project
sentry span view my-org/backend/abc123def456abc123def456abc12345 a1b2c3d4e5f67890
```
