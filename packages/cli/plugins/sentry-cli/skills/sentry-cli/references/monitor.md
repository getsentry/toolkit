---
name: sentry-cli-monitor
version: 0.48.0-dev.0
description: Work with Sentry cron monitors
requires:
  bins: ["sentry"]
  auth: true
---

# Monitor Commands

Work with Sentry cron monitors

### `sentry monitor run <monitor-slug command...>`

Wrap a command with cron monitor check-ins

**Flags:**
- `--dsn <value> - DSN to send check-ins to (overrides SENTRY_DSN env var)`
- `-e, --environment <value> - Environment of the monitor - (default: "production")`
- `-s, --schedule <value> - Upsert the monitor with this crontab schedule (e.g. '0 * * * *')`
- `--check-in-margin <value> - Minutes after the expected check-in before it is missed (requires --schedule)`
- `--max-runtime <value> - Minutes a check-in may run before timing out (requires --schedule)`
- `--timezone <value> - Timezone of the schedule, tz database string (requires --schedule)`
- `--failure-issue-threshold <value> - Consecutive failures before an issue is created (requires --schedule)`
- `--recovery-threshold <value> - Consecutive successes before an issue is resolved (requires --schedule)`

### `sentry monitor list [<org/project>]`

List cron monitors

**Flags:**
- `-n, --limit <value> - Maximum number of monitors to list - (default: "25")`
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

**Examples:**

```bash
# Wrap a command with cron monitor check-ins (DSN-based)
SENTRY_DSN=https://examplePublicKey@o0.ingest.sentry.io/0 \
  sentry monitor run nightly-job -- python manage.py cron

# The -- separator is optional when the command has no flags
sentry monitor run nightly-job npm run task

# Create/update the monitor on the first check-in via --schedule (crontab)
sentry monitor run nightly-job -s "0 0 * * *" --max-runtime 30 --timezone UTC -- ./backup.sh

# List cron monitors in an org
sentry monitor list my-org/

# Paginate through monitors
sentry monitor list my-org/ -c next

# Output as JSON
sentry monitor list --json
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
