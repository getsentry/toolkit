---
name: sentry-cli-trial
version: 0.50.0-dev.0
description: Manage product trials
requires:
  bins: ["sentry"]
  auth: true
---

# Trial Commands

Manage product trials

### `sentry trial list [<org>]`

List product trials

**Arguments:**

| Argument | Description |
|----------|-------------|
| `[<org>]` | Organization slug (auto-detected if omitted) |

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | CLI trial name (e.g. seer), or "plan" for the plan trial |
| `category` | string | Trial category (e.g. seerUsers, seerAutofix) |
| `status` | string | Trial status |
| `daysRemaining` | number \| null | Days left on an active trial |
| `isStarted` | boolean | Whether the trial has started |
| `lengthDays` | number \| null | Trial duration in days |
| `startDate` | string \| null | Start date (ISO 8601) |
| `endDate` | string \| null | End date (ISO 8601) |

**Examples:**

```bash
# List all trials for the current organization
sentry trial list

# List trials for a specific organization
sentry trial list my-org

# Output as JSON
sentry trial list --json
```

### `sentry trial start <name> [<org>]`

Start a product trial

**Destructive:** This command deletes data or makes changes that can't easily be undone. Confirm with the user before running it.

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<name> [<org>]` | Trial name (seer, replays, performance, spans, profiling, logs, monitors, uptime, plan) and organization slug (auto-detected if omitted) |

**Examples:**

```bash
# Start a Seer trial
sentry trial start seer

# Start a trial for a specific organization
sentry trial start replays my-org

# Start a Business plan trial (opens the browser)
sentry trial start plan

# Output the result as JSON
sentry trial start --json seer
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
