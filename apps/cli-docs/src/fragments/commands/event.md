


## Examples

### Sending Events

```bash
# Send an error event (default level)
sentry event send -m "Something went wrong"

# Specify level, release, and environment
sentry event send -m "Deploy check" -l info -r 1.0.0 -E production

# Add tags and extra data
sentry event send -m "Payment failed" --tag env:prod --tag region:us-east --extra amount:99.99

# Set user context
sentry event send -m "Login error" --user id:42 --user email:alice@example.com

# Custom fingerprint to group related events together
sentry event send -m "DB timeout" --fingerprint db-timeout --fingerprint {{ default }}
```

### Send from a JSON file

```bash
# Send a serialized Sentry Event object
sentry event send ./crash.json

# Send without re-parsing (raw mode — also supports pre-built envelopes)
sentry event send --raw ./crash.json
sentry event send --raw ./captured.envelope
```

Prefix relative file paths with `./` to distinguish them from a project target.

### DSN authentication

`sentry event send` authenticates with ingest via a **DSN**, not a user token.
An explicit DSN, `SENTRY_DSN`, and project auto-detection do not require login.
Passing `<project>` or `<org>/<project>` does: the CLI uses your session to
resolve the project and fetch its active DSN, then sends to ingest. If a project
has multiple active DSNs, pass the desired DSN explicitly.

The DSN is resolved in priority order:

1. A leading `<dsn>`, `<project>`, or `<org>/<project>` positional
2. `SENTRY_DSN` environment variable
3. Auto-detection from the current project (`.env`, source code, env files)

```bash
# Explicit DSN
sentry event send "https://key@o123.ingest.us.sentry.io/456" -m "Test"

# Via environment variable
export SENTRY_DSN="https://key@o123.ingest.us.sentry.io/456"
sentry event send -m "Test"

# Project target (logged-in session; CLI fetches its sole active DSN)
sentry event send cli -m "Test"

# Org/project target
sentry event send sentry/cli -m "Test"

# Auto-detect from the current project
sentry event send -m "Test"
```

### Listing Events

```bash
# List events for an issue (using short ID)
sentry event list PROJ-ABC

# List events for an issue (using numeric ID)
sentry event list 123456789

# Filter by search query
sentry event list PROJ-ABC --query "browser:Chrome"

# Include full event bodies (stacktraces)
sentry event list PROJ-ABC --full

# Limit results and time range
sentry event list PROJ-ABC --limit 50 --period 24h

# Paginate through results
sentry event list PROJ-ABC -c next
sentry event list PROJ-ABC -c prev

# Output as JSON
sentry event list PROJ-ABC --json
```

### Viewing Events

```bash
sentry event view abc123def456abc123def456abc12345
```

```
Event: abc123def456abc123def456abc12345
Issue: FRONT-ABC
Timestamp: 2024-01-20 14:22:00

Exception:
  TypeError: Cannot read property 'foo' of undefined
    at processData (app.js:123:45)
    at handleClick (app.js:89:12)
    at HTMLButtonElement.onclick (app.js:45:8)

Tags:
  browser: Chrome 120
  os: Windows 10
  environment: production
  release: 1.2.3

Context:
  url: https://example.com/app
  user_id: 12345
```

```bash
# Open in browser
sentry event view abc123def456abc123def456abc12345 -w

# Download an attachment listed by `sentry event view --json`
sentry api "https://sentry.io/api/0/projects/my-org/my-project/events/EVENT_ID/attachments/ATTACHMENT_ID/?download=1" > screenshot.png
```

## Finding Event IDs

Event IDs can be found:

1. In the Sentry UI when viewing an issue's events
2. In the output of `sentry issue view` commands
3. In error reports sent to Sentry (as `event_id`)

## Backward compatibility

The old sentry-cli top-level command is available as a hidden alias:

```bash
sentry send-event    # same as: sentry event send
```
