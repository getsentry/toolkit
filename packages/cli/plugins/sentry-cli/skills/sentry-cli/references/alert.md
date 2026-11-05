---
name: sentry-cli-alert
version: 0.48.0-dev.0
description: Manage Sentry alerts
requires:
  bins: ["sentry"]
  auth: true
---

# Alert Commands

Manage Sentry alerts

### `sentry alert list [<org>]`

List alerts

**Arguments:**

| Argument | Description |
|----------|-------------|
| `[<org>]` | Organization slug (auto-detected if omitted) |

**Flags:**
- `-n, --limit <value> - Maximum number of alerts to list - (default: "25")`
- `-q, --query <value> - Native alert search query`
- `--project <value>... - Project IDs or slugs (repeatable)`
- `--monitor <value>... - Connected monitor IDs (repeatable or comma-separated)`
- `-w, --web - Open alerts in a browser`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`
- `-c, --cursor <value> - Navigate pages: "next", "prev", "first" (or raw cursor string)`

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Alert ID |
| `name` | string | Alert name |
| `organizationId` | string |  |
| `createdBy` | string \| null |  |
| `dateCreated` | string |  |
| `dateUpdated` | string |  |
| `triggers` | object \| null |  |
| `actionFilters` | array \| null |  |
| `environment` | string \| null |  |
| `config` | object |  |
| `detectorIds` | array \| null |  |
| `enabled` | boolean |  |
| `lastTriggered` | string \| null |  |
| `owner` | string \| null |  |
| `orgSlug` | string | Organization slug |

**Examples:**

```bash
# List all accessible alerts, including detached alerts
sentry alert list my-org/

# Filter by a connected monitor
sentry alert list my-org/ --monitor 123

# Search alerts
sentry alert list my-org/ --query "name:Latency"
```

### `sentry alert view <alert>`

View an alert

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<alert>` | [&lt;org&gt;/]&lt;id-or-name&gt; or alert URL |

**Flags:**
- `-w, --web - Open the alert in a browser`

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Alert ID |
| `name` | string | Alert name |
| `organizationId` | string |  |
| `createdBy` | string \| null |  |
| `dateCreated` | string |  |
| `dateUpdated` | string |  |
| `triggers` | object \| null |  |
| `actionFilters` | array \| null |  |
| `environment` | string \| null |  |
| `config` | object |  |
| `detectorIds` | array \| null |  |
| `enabled` | boolean |  |
| `lastTriggered` | string \| null |  |
| `owner` | string \| null |  |
| `org` | string | Organization slug |

**Examples:**

```bash
# View an alert
sentry alert view my-org/123

# View by name
sentry alert view "my-org/Latency notifications"
```

### `sentry alert create [<org>]`

Create an alert

**Arguments:**

| Argument | Description |
|----------|-------------|
| `[<org>]` | Organization slug (auto-detected if omitted) |

**Flags:**
- `--name <value> - Alert name`
- `-t, --trigger <value>... - Trigger name, native condition JSON, or full trigger group JSON (repeatable)`
- `-a, --action <value>... - Native action JSON for the first action-filter group (repeatable)`
- `--filter <value>... - Native condition JSON for the first action-filter group (repeatable)`
- `--filter-match <value> - First action-filter group logic: all or any`
- `--frequency <value> - config.frequency in minutes (0 or greater)`
- `--config <value> - Complete native workflow config JSON`
- `--action-filter <value>... - Complete native action-filter group JSON; replaces all groups (repeatable or JSON array)`
- `--monitor <value>... - Monitor IDs to connect (repeatable, comma-separated; empty string clears)`
- `--project <value> - Select a project's issues and activity (replaces monitor links)`
- `--environment <value> - Environment (empty string clears)`
- `--owner <value> - Owner: user:<id> or team:<id> (empty string clears)`
- `--enabled <value> - Whether this alert is enabled: true or false`
- `-n, --dry-run - Show what would happen without making changes`

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Alert ID |
| `name` | string | Alert name |
| `organizationId` | string |  |
| `createdBy` | string \| null |  |
| `dateCreated` | string |  |
| `dateUpdated` | string |  |
| `triggers` | object \| null |  |
| `actionFilters` | array \| null |  |
| `environment` | string \| null |  |
| `config` | object |  |
| `detectorIds` | array \| null |  |
| `enabled` | boolean |  |
| `lastTriggered` | string \| null |  |
| `owner` | string \| null |  |
| `org` | string | Organization slug |
| `dryRun` | boolean | True when --dry-run made no change |
| `body` | unknown | Exact native request body (--dry-run) |

**Examples:**

```bash
# Create an alert connected to a metric monitor
sentry alert create my-org/ --name "Latency notifications" --monitor 123 --action '{"type":"email","data":{},"config":{"targetType":"team","targetIdentifier":"1"}}'

# Create an alert for a project's new issues
sentry alert create my-org/ --project my-project --name "New issues" --trigger first-seen --frequency 30 --action '{"type":"email","data":{},"config":{"targetType":"team","targetIdentifier":"7"}}'

# Preview a detached alert with native configuration
sentry alert create my-org/ --name "New issues" --trigger first-seen --config '{"frequency":0}' --dry-run
```

### `sentry alert edit <alert>`

Edit an alert

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<alert>` | [&lt;org&gt;/]&lt;id-or-name&gt; or alert URL |

**Flags:**
- `--name <value> - Alert name`
- `-t, --trigger <value>... - Trigger name, native condition JSON, or full trigger group JSON (repeatable)`
- `-a, --action <value>... - Native action JSON for the first action-filter group (repeatable)`
- `--filter <value>... - Native condition JSON for the first action-filter group (repeatable)`
- `--filter-match <value> - First action-filter group logic: all or any`
- `--frequency <value> - config.frequency in minutes (0 or greater)`
- `--config <value> - Complete native workflow config JSON`
- `--action-filter <value>... - Complete native action-filter group JSON; replaces all groups (repeatable or JSON array)`
- `--monitor <value>... - Monitor IDs to connect (repeatable, comma-separated; empty string clears)`
- `--project <value> - Select a project's issues and activity (replaces monitor links)`
- `--environment <value> - Environment (empty string clears)`
- `--owner <value> - Owner: user:<id> or team:<id> (empty string clears)`
- `--enabled <value> - Whether this alert is enabled: true or false`
- `-n, --dry-run - Show what would happen without making changes`

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Alert ID |
| `name` | string | Alert name |
| `organizationId` | string |  |
| `createdBy` | string \| null |  |
| `dateCreated` | string |  |
| `dateUpdated` | string |  |
| `triggers` | object \| null |  |
| `actionFilters` | array \| null |  |
| `environment` | string \| null |  |
| `config` | object |  |
| `detectorIds` | array \| null |  |
| `enabled` | boolean |  |
| `lastTriggered` | string \| null |  |
| `owner` | string \| null |  |
| `org` | string | Organization slug |
| `dryRun` | boolean | True when --dry-run made no change |
| `body` | unknown | Exact native request body (--dry-run) |

**Examples:**

```bash
# Rename a disabled alert without re-enabling it
sentry alert edit my-org/123 --name "Production latency"

# Connect an alert to two monitors
sentry alert edit my-org/123 --monitor 456,789

# Scope an alert to a project's issues and activity
sentry alert edit my-org/123 --project my-project

# Preview disabling an alert selected by name
sentry alert edit "my-org/Latency" --enabled false --dry-run
```

### `sentry alert delete <alert>`

Delete an alert

**Destructive:** This command deletes data or makes changes that can't easily be undone. Use `--dry-run` to preview the changes first. Confirm with the user before running it.

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<alert>` | [&lt;org&gt;/]&lt;id-or-name&gt; or alert URL |

**Flags:**
- `-y, --yes - Skip confirmation prompt`
- `-f, --force - Force the operation without confirmation`
- `-n, --dry-run - Show what would happen without making changes`

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `org` | string | Organization slug |
| `id` | string | Alert ID |
| `name` | string | Alert name |
| `dryRun` | boolean | True when --dry-run made no change |
| `deleted` | boolean | True when the alert was deleted |

**Examples:**

```bash
# Preview deleting an alert
sentry alert delete my-org/123 --dry-run

# Delete by exact name
sentry alert delete "my-org/Latency notifications" --yes
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
