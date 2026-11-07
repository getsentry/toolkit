---
name: sentry-cli-event
version: 0.50.0-dev.0
description: View, list, and send Sentry events
requires:
  bins: ["sentry"]
  auth: true
---

# Event Commands

View, list, and send Sentry events

### `sentry event view <org/project/event-id...>`

View details of one or more events

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<org/project/event-id...>` | [&lt;org&gt;/&lt;project&gt;] [&lt;event-id&gt;...] - Target (optional) and event IDs, or a selector (default: @latest) |

**Flags:**
- `-w, --web - Open in browser`
- `--spans <value> - Span tree depth limit (number, "all" for unlimited, "no" to disable) - (default: "3")`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | ID of the event |
| `groupID` | string \| null | ID of the issue the event belongs to |
| `eventID` | string | UUID-format event ID |
| `projectID` | string | ID of the project the event belongs to |
| `message` | string \| null | Event message |
| `title` | string | Event title |
| `location` | string \| null | Source location of the event, such as a file and line |
| `platform` | string \| null | Platform of the event, such as python or javascript |
| `dateReceived` | string \| null | When Sentry received the event (ISO 8601) |
| `size` | number \| null | Size of the event payload in bytes |
| `entries` | array | Event interfaces, such as exception, breadcrumbs and request, each with a type and data |
| `dist` | string \| null | Distribution of the release the event was sent with |
| `packages` | object | Modules loaded when the event occurred, keyed by module name with their versions |
| `type` | string | Event type, such as error, default or transaction |
| `metadata` | object | Event metadata |
| `occurrence` | object \| null |  |
| `_meta` | object | Metadata about changes Sentry made to the event's fields, such as data scrubbing or trimming |
| `user` | object \| null | User context of the event |
| `tags` | array | Tags attached to the event |
| `contexts` | object \| null | Contexts of the event, such as device, os, browser and runtime |
| `sdk` | object \| null | SDK that sent the event |
| `context` | object \| null | Additional data sent with the event in its extra field |
| `errors` | array | Errors Sentry found while processing the event |
| `crashFile` | string \| null | Crash report attachment of the event, if any |
| `culprit` | string \| null | Function or module that caused the event |
| `dateCreated` | string | When the event occurred (ISO 8601) |
| `fingerprints` | array | Grouping hashes calculated for the event |
| `groupingConfig` | object | Grouping configuration used to group the event |
| `startTimestamp` | number | When the transaction started, as a Unix timestamp in seconds |
| `endTimestamp` | number | When the transaction ended, as a Unix timestamp in seconds |
| `measurements` | object \| null | Measurements recorded for the transaction, such as web vitals, keyed by name |
| `breakdowns` | object \| null | Span operation breakdowns for the transaction, keyed by breakdown name |
| `release` | object \| null | Release the event was sent with. Null when the event has no release |
| `userReport` | object \| null | User feedback submitted for the event. Null when there's none |
| `sdkUpdates` | array | Suggested updates for the SDK that sent the event |
| `resolvedWith` | array | How the event's stack frames were resolved during processing, such as which source map lookup method was used |
| `nextEventID` | string \| null | ID of the next event in the issue. Null for the latest event or when adjacentEvents is collapsed |
| `previousEventID` | string \| null | ID of the previous event in the issue. Null for the first event or when adjacentEvents is collapsed |
| `formatted` | object | Event rendered as Markdown, XML, or JSON; only returned for API requests with llmFormat |
| `trace` | object \| null | Trace context, or null when unavailable |
| `attachments` | array | Event attachments; each includes metadata and an absolute authenticated download URL |

**Examples:**

```bash
# View an event
sentry event view abc123def456abc123def456abc12345

# View a specific event using an issue short ID
sentry event view PROJ-ABC 7388f6a62b7d436ab77bb5365f97a1ac

# View a specific event with an explicit organization
sentry event view my-org/PROJ-ABC 7388f6a62b7d436ab77bb5365f97a1ac

# View the latest event for an issue
sentry event view PROJ-ABC

# View the latest event of the most recent unresolved issue in a project
sentry event view my-org/my-project

# View the latest event of the most frequent issue
sentry event view @most_frequent

# Open in the browser
sentry event view abc123def456abc123def456abc12345 -w

# Download an attachment listed by --json (with sentry api)
sentry api 'https://sentry.io/api/0/projects/my-org/my-project/events/EVENT_ID/attachments/ATTACHMENT_ID/?download=1' > screenshot.png

# View an event in an explicit project
sentry event view my-org/my-project abc123def456abc123def456abc12345

# View several events, finding the project across organizations
sentry event view my-project abc123def456abc123def456abc12345 def456abc123def456abc123def45678
```

### `sentry event list <issue>`

List events for an issue

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<issue>` | Issue: @latest, @most_frequent, &lt;org&gt;/ID, &lt;org&gt;/&lt;project&gt;#ID, &lt;project&gt;-suffix, ID, or suffix |

**Flags:**
- `-n, --limit <value> - Number of events (1-1000) - (default: "25")`
- `-q, --query <value> - Search query (Sentry search syntax)`
- `--full - Include full event body (stacktraces)`
- `-t, --period <value> - Time range: "7d", "2024-01-01..2024-02-01", ">=2024-01-01" - (default: "7d")`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`
- `-c, --cursor <value> - Navigate pages: "next", "prev", "first" (or raw cursor string)`

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Internal event ID |
| `event.type` | string | Event type (error, default, transaction) |
| `groupID` | string \| null | ID of the issue the event belongs to |
| `eventID` | string | UUID-format event ID |
| `projectID` | string | ID of the project the event belongs to |
| `message` | string | Event message |
| `title` | string | Event title |
| `location` | string \| null | Source location of the event, such as a file and line |
| `culprit` | string \| null | Function or module that caused the event |
| `user` | object \| null | User context of the event |
| `tags` | array | Tags attached to the event |
| `platform` | string \| null | Platform of the event, such as python or javascript |
| `dateCreated` | string | When the event occurred (ISO 8601) |
| `crashFile` | string \| null | Crash report attachment of the event, if any |
| `metadata` | object | Event metadata |

**Examples:**

```bash
# List events for an issue (short ID)
sentry event list PROJ-ABC

# List events for an issue (numeric ID)
sentry event list 123456789

# List events for the most recent issue
sentry event list @latest --limit 50

# Filter by search query
sentry event list PROJ-ABC --query "browser:Chrome"

# Include full event bodies (stacktraces)
sentry event list PROJ-ABC --full

# Limit results and time range
sentry event list PROJ-ABC --limit 50 --period 24h

# Fetch the next page
sentry event list PROJ-ABC -c next

# Fetch the previous page
sentry event list PROJ-ABC -c prev

# Output as JSON
sentry event list PROJ-ABC --json
```

### `sentry event send <target-or-file...>`

Send a Sentry event

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<target-or-file...>` | Optional DSN/project target followed by JSON event file path(s) |

**Flags:**
- `-m, --message <value>... - Event message (repeat for multi-line)`
- `-a, --message-arg <value>... - Arguments for message template (repeat for multiple)`
- `-l, --level <value> - Event severity level - (default: "error")`
- `-r, --release <value> - Release version`
- `-d, --dist <value> - Distribution identifier`
- `-E, --env <value> - Environment name (e.g. production, staging)`
- `-p, --platform <value> - Platform identifier (default: other)`
- `-t, --tag <value>... - Tag as KEY:VALUE (repeat for multiple)`
- `-e, --extra <value>... - Extra data as KEY:VALUE (repeat for multiple)`
- `-u, --user <value>... - User info as KEY:VALUE — id, email, username, ip_address, or custom`
- `-f, --fingerprint <value>... - Custom fingerprint part (repeat for multiple)`
- `--timestamp <value> - Event timestamp (Unix epoch, ISO 8601, or RFC 2822)`
- `--no-environ - Do not include environment variables in the event`
- `--logfile <value> - Path to a log file — last 100 lines are attached as breadcrumbs`
- `--with-categories - Parse 'CATEGORY: message' prefixes from logfile breadcrumbs`
- `--raw - Send file contents as-is without parsing`

**Examples:**

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

# Send a serialized Sentry Event object
sentry event send ./crash.json

# Send without re-parsing (raw mode)
sentry event send --raw ./crash.json

# Send a pre-built envelope
sentry event send --raw ./captured.envelope

# Send with an explicit DSN
sentry event send "https://key@o123.ingest.us.sentry.io/456" -m "Test"

# Send to a project (logged-in session; the CLI fetches its sole active DSN)
sentry event send my-project -m "Test"

# Send to an org/project target
sentry event send my-org/my-project -m "Test"
```

### `sentry event analytics [<org/project>]`

Analytics for events Sentry accepted and dropped

**Arguments:**

| Argument | Description |
|----------|-------------|
| `[<org/project>]` | &lt;org&gt;/&lt;project&gt; or &lt;project&gt; (search) |

**Flags:**
- `-d, --dataset <value> - Dropped-data type: errors, spans, logs, metrics - (default: "errors")`
- `-t, --period <value> - Time range: "7d", "2024-01-01..2024-02-01", ">=2024-01-01" - (default: "7d")`

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `outcome` | string | Outcome code: accepted, or a drop such as rate_limited or filtered |
| `label` | string | Human-readable outcome label |
| `reason` | string | Reason within the outcome (e.g. spike_protection); accepted for accepted volume |
| `category` | string | Data category (e.g. error, span) |
| `events` | number | Events in this slice |
| `share` | number | Fraction of total volume (0-1), not a percentage string |
| `tags` | array | Drop classification: intentional or unintentional; empty for accepted |

**Examples:**

```bash
# Accepted and dropped event analytics for a project
sentry event analytics my-org/my-project

# Analytics for a different dataset
sentry event analytics my-org/my-project --dataset spans

# Widen the time range
sentry event analytics my-org/my-project --period 7d

# Select specific JSON fields
sentry event analytics my-org/my-project --json --fields outcome,reason,events
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
