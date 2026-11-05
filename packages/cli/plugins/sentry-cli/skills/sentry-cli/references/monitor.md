---
name: sentry-cli-monitor
version: 0.48.0-dev.0
description: Manage Sentry monitors by type
requires:
  bins: ["sentry"]
  auth: true
---

# Monitor Commands

Manage Sentry monitors by type

### `sentry monitor list [<target>]`

List monitors of every type

**Arguments:**

| Argument | Description |
|----------|-------------|
| `[<target>]` | Organization or project target |

**Flags:**
- `-n, --limit <value> - Maximum number of monitors to list - (default: "25")`
- `-q, --query <value> - Native monitor search query`
- `-w, --web - Open monitors in the browser`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`
- `-c, --cursor <value> - Navigate pages: "next", "prev", "first" (or raw cursor string)`

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `owner` | object \| null |  |
| `createdBy` | string \| null |  |
| `latestGroup` | object \| null |  |
| `description` | string \| null |  |
| `id` | string | Monitor ID |
| `projectId` | string \| null |  |
| `name` | string | Monitor name |
| `type` | string |  |
| `workflowIds` | array \| null |  |
| `dateCreated` | string |  |
| `dateUpdated` | string |  |
| `dataSources` | array \| null |  |
| `conditionGroup` | object \| null |  |
| `config` | object |  |
| `enabled` | boolean |  |
| `orgSlug` | string | Organization slug |

**Examples:**

```bash
# List monitors
sentry monitor list my-org/

# Filter a project's monitors
sentry monitor list my-org/my-project --query 'name:Latency'
```

### `sentry monitor metric list [<target>]`

List metric monitors

**Arguments:**

| Argument | Description |
|----------|-------------|
| `[<target>]` | Organization or project target |

**Flags:**
- `-n, --limit <value> - Maximum number of metric monitors to list - (default: "25")`
- `-q, --query <value> - Native monitor search query`
- `-w, --web - Open monitors in the browser`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`
- `-c, --cursor <value> - Navigate pages: "next", "prev", "first" (or raw cursor string)`

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `owner` | object \| null |  |
| `createdBy` | string \| null |  |
| `latestGroup` | object \| null |  |
| `description` | string \| null |  |
| `id` | string | Monitor ID |
| `projectId` | string \| null |  |
| `name` | string | Monitor name |
| `type` | string |  |
| `workflowIds` | array \| null |  |
| `dateCreated` | string |  |
| `dateUpdated` | string |  |
| `dataSources` | array \| null |  |
| `conditionGroup` | object \| null |  |
| `config` | object |  |
| `enabled` | boolean |  |
| `orgSlug` | string | Organization slug |

**Examples:**

```bash
# List metric monitors
sentry monitor metric list my-org/

# Filter a project's monitors
sentry monitor metric list my-org/my-project --query 'name:Latency'
```

### `sentry monitor metric view <org/monitor-id-or-name>`

View a metric monitor

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<org/monitor-id-or-name>` | Monitor ID or exact name, optionally prefixed with org/ |

**Flags:**
- `-w, --web - Open this monitor in the browser`

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `owner` | object \| null |  |
| `createdBy` | string \| null |  |
| `latestGroup` | object \| null |  |
| `description` | string \| null |  |
| `id` | string | Monitor ID |
| `projectId` | string \| null |  |
| `name` | string | Monitor name |
| `type` | string |  |
| `workflowIds` | array \| null |  |
| `dateCreated` | string |  |
| `dateUpdated` | string |  |
| `dataSources` | array \| null |  |
| `conditionGroup` | object \| null |  |
| `config` | object |  |
| `enabled` | boolean |  |
| `org` | string | Organization slug |
| `workflows` | array | Connected notification alert documents |
| `workflowErrors` | array |  |

**Examples:**

```bash
# Inspect monitor configuration
sentry monitor metric view my-org/123 --json
```

### `sentry monitor metric create <org/project>`

Create a metric monitor

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<org/project>` | Exactly one target project |

**Flags:**
- `--name <value> - Monitor name`
- `--query <value> - Query filter (empty string selects all matching events)`
- `--aggregate <value> - Aggregate expression, e.g. count() or p95(span.duration)`
- `--dataset <value> - Signal dataset: errors, events, spans, logs, metrics, sessions, tracemetrics`
- `--time-window <value> - Evaluation window in minutes (wire values are seconds)`
- `--condition <value>... - Native {type,comparison,conditionResult} JSON (repeatable; replaces all conditions)`
- `--config <value> - Native detection config JSON: static, percent or dynamic; comparisonDelta is seconds`
- `--critical <value> - Critical threshold (creates native alert and resolution conditions)`
- `--warning <value> - Optional warning threshold, used with --critical`
- `--resolve <value> - Resolution threshold (defaults to --critical)`
- `--comparison <value> - Threshold direction: gt or lt (default gt)`
- `--environment <value> - Environment filter (empty string clears it)`
- `--owner <value> - Owner actor, e.g. team:123 (empty string clears it)`
- `--description <value> - Monitor description`
- `--enabled <value> - Enable or disable: true or false`
- `--alert <value>... - Connected alert ID (repeatable or comma-separated; replaces workflowIds; empty clears)`
- `-n, --dry-run - Show what would happen without making changes`

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `owner` | object \| null |  |
| `createdBy` | string \| null |  |
| `latestGroup` | object \| null |  |
| `description` | string \| null |  |
| `id` | string | Monitor ID |
| `projectId` | string \| null |  |
| `name` | string | Monitor name |
| `type` | string |  |
| `workflowIds` | array \| null |  |
| `dateCreated` | string |  |
| `dateUpdated` | string |  |
| `dataSources` | array \| null |  |
| `conditionGroup` | object \| null |  |
| `config` | object |  |
| `enabled` | boolean |  |
| `org` | string | Organization slug |
| `project` | string | Project slug for create |
| `dryRun` | boolean | True for a dry-run preview |
| `body` | unknown | Exact native request body (--dry-run) |

**Examples:**

```bash
# Create an error volume monitor
sentry monitor metric create my-org/my-project --name 'Error volume' --query '' --aggregate 'count()' --dataset errors --time-window 5 --critical 100

# Preview warning and critical thresholds connected to an alert
sentry monitor metric create my-org/my-project --name 'Error volume' --query '' --aggregate 'count()' --dataset errors --time-window 5 --critical 100 --warning 80 --resolve 70 --alert 123 --dry-run
```

### `sentry monitor metric edit <org/monitor-id-or-name>`

Edit a metric monitor

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<org/monitor-id-or-name>` | Monitor ID or exact name, optionally prefixed with org/ |

**Flags:**
- `--name <value> - Monitor name`
- `--query <value> - Query filter (empty string selects all matching events)`
- `--aggregate <value> - Aggregate expression, e.g. count() or p95(span.duration)`
- `--dataset <value> - Signal dataset: errors, events, spans, logs, metrics, sessions, tracemetrics`
- `--time-window <value> - Evaluation window in minutes (wire values are seconds)`
- `--condition <value>... - Native {type,comparison,conditionResult} JSON (repeatable; replaces all conditions)`
- `--config <value> - Native detection config JSON: static, percent or dynamic; comparisonDelta is seconds`
- `--critical <value> - Critical threshold (creates native alert and resolution conditions)`
- `--warning <value> - Optional warning threshold, used with --critical`
- `--resolve <value> - Resolution threshold (defaults to --critical)`
- `--comparison <value> - Threshold direction: gt or lt (default gt)`
- `--environment <value> - Environment filter (empty string clears it)`
- `--owner <value> - Owner actor, e.g. team:123 (empty string clears it)`
- `--description <value> - Monitor description`
- `--enabled <value> - Enable or disable: true or false`
- `--alert <value>... - Connected alert ID (repeatable or comma-separated; replaces workflowIds; empty clears)`
- `-n, --dry-run - Show what would happen without making changes`

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `owner` | object \| null |  |
| `createdBy` | string \| null |  |
| `latestGroup` | object \| null |  |
| `description` | string \| null |  |
| `id` | string | Monitor ID |
| `projectId` | string \| null |  |
| `name` | string | Monitor name |
| `type` | string |  |
| `workflowIds` | array \| null |  |
| `dateCreated` | string |  |
| `dateUpdated` | string |  |
| `dataSources` | array \| null |  |
| `conditionGroup` | object \| null |  |
| `config` | object |  |
| `enabled` | boolean |  |
| `org` | string | Organization slug |
| `project` | string | Project slug for create |
| `dryRun` | boolean | True for a dry-run preview |
| `body` | unknown | Exact native request body (--dry-run) |

**Examples:**

```bash
# Disable a monitor
sentry monitor metric edit my-org/123 --enabled false
```

### `sentry monitor metric delete <org/monitor-id-or-name>`

Delete a metric monitor

**Destructive:** This command deletes data or makes changes that can't easily be undone. Use `--dry-run` to preview the changes first. Confirm with the user before running it.

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<org/monitor-id-or-name>` | Monitor ID or exact name, optionally prefixed with org/ |

**Flags:**
- `-y, --yes - Skip confirmation prompt`
- `-f, --force - Force the operation without confirmation`
- `-n, --dry-run - Show what would happen without making changes`

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `org` | string | Organization slug |
| `id` | string | Deleted monitor ID |
| `name` | string | Deleted monitor name |
| `dryRun` | boolean |  |
| `deleted` | boolean | True when deletion succeeded |

**Examples:**

```bash
# Delete a monitor without prompting
sentry monitor metric delete my-org/123 --yes
```

### `sentry monitor cron list [<org/project>]`

List cron monitors

**Arguments:**

| Argument | Description |
|----------|-------------|
| `[<org/project>]` | &lt;org&gt;/ (all), &lt;org&gt;/&lt;name&gt; or &lt;name&gt; (a project, else matching names), or a name glob (&lt;org&gt;/web-*) |

**Flags:**
- `-n, --limit <value> - Maximum number of cron monitors to list - (default: "25")`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`
- `-c, --cursor <value> - Navigate pages: "next", "prev", "first" (or raw cursor string)`

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Monitor ID |
| `slug` | string | Monitor slug |
| `name` | string | Monitor name |
| `status` | string | Monitor status (e.g. active, disabled) |
| `isMuted` | boolean | Whether the monitor is muted |
| `config` | object | Schedule configuration |
| `dateCreated` | string | Creation date (ISO 8601) |
| `project` | object | Owning project |
| `orgSlug` | string | Organization slug |

**Examples:**

```bash
# List monitors (organization auto-detected)
sentry monitor cron list

# List cron monitors in an organization
sentry monitor cron list my-org/

# Fetch the next page
sentry monitor cron list my-org/ -c next

# Only monitors whose slug or name matches a glob
sentry monitor cron list 'my-org/nightly-*'

# Monitors named like 'nightly' (fuzzy when nothing matches exactly)
sentry monitor cron list my-org/nigthly

# Output as JSON
sentry monitor cron list --json
```

### `sentry monitor cron run <monitor-slug command...>`

Wrap a command with cron monitor check-ins

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<monitor-slug command...>` | Monitor slug followed by the command to run |

**Flags:**
- `--dsn <value> - DSN to send check-ins to (overrides SENTRY_DSN env var)`
- `-e, --environment <value> - Environment of the monitor - (default: "production")`
- `-s, --schedule <value> - Upsert the monitor with this crontab schedule (e.g. '0 * * * *')`
- `--check-in-margin <value> - Minutes after the expected check-in before it is missed (requires --schedule)`
- `--max-runtime <value> - Minutes a check-in may run before timing out (requires --schedule)`
- `--timezone <value> - Timezone of the schedule, tz database string (requires --schedule)`
- `--failure-issue-threshold <value> - Consecutive failures before an issue is created (requires --schedule)`
- `--recovery-threshold <value> - Consecutive successes before an issue is resolved (requires --schedule)`

**Examples:**

```bash
# Wrap a command with cron monitor check-ins (DSN-based)
SENTRY_DSN=https://examplePublicKey@o0.ingest.sentry.io/0 sentry monitor cron run nightly-job -- python manage.py cron

# The -- separator is optional when the command has no flags
sentry monitor cron run nightly-job npm run task

# Create or update the monitor on the first check-in
sentry monitor cron run nightly-job -s "0 0 * * *" --max-runtime 30 --timezone UTC -- ./backup.sh
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
