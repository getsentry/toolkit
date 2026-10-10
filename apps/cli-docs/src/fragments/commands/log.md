
## Examples

### List logs

```bash
# List last 100 logs (default)
sentry log list
```

```
TIMESTAMP            LEVEL   MESSAGE
2024-01-20 14:22:01  info    User login successful
2024-01-20 14:22:03  debug   Processing request for /api/users
2024-01-20 14:22:05  error   Database connection timeout
2024-01-20 14:22:06  warn    Retry attempt 1 of 3

Showing 4 logs.
```

**Filter logs:**

```bash
# Show only error logs
sentry log list -q 'severity:error'

# Filter by message content
sentry log list -q 'database'

# Limit results
sentry log list --limit 50
```

### Stream logs in real-time

```bash
# Stream with default 2-second poll interval
sentry log list -f

# Stream with custom 5-second poll interval
sentry log list -f 5

# Stream error logs from a specific project
sentry log list my-org/backend -f -q 'severity:error'
```

### View a log entry

Copy the full ID from the `ID` column in `sentry log list` or `sentry trace logs`
into `sentry log view`. An abbreviated prefix can match multiple logs and cannot
be expanded into a unique full ID by itself.

Log ID lookups automatically narrow the search when a usable timestamp can be
determined from each ID. Otherwise, they use a 90-day lookup window. If a partial
scan leaves IDs missing, the CLI retries those IDs once with the highest
available scan accuracy.

```bash
sentry log view 968c763c740cfda8b6728f27fb9e9b01
```

```
Log 968c763c740c...
════════════════════

ID:         968c763c740cfda8b6728f27fb9e9b01
Timestamp:  2024-01-20 14:22:05
Severity:   ERROR

Message:
  Database connection timeout after 30s

─── Context ───

Project:      backend
Environment:  production
Release:      1.2.3

─── Trace ───

Trace ID:     abc123def456abc123def456abc12345
Span ID:      1234567890abcdef

─── Source Location ───

Function:     connect_to_database
File:         src/db/connection.py:142
```

```bash
# With explicit project
sentry log view my-org/backend 968c763c740cfda8b6728f27fb9e9b01

# Open in browser
sentry log view 968c763c740cfda8b6728f27fb9e9b01 -w
```

## Finding Log IDs

Log IDs can be found:

1. In the output of `sentry log list` (the ID column)
2. In the Sentry UI when viewing log entries
3. In the `sentry.item_id` field of JSON output

## JSON Output

Use `--json` for machine-readable output:

```bash
sentry log list --json | jq '.data[] | select(.severity == "error")'
```

In streaming mode with `--json`, each log entry is output as a separate JSON object (newline-delimited JSON), making it suitable for piping to other tools.
