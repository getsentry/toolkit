---
name: sentry-cli-dsn
version: 0.48.0-dev.0
description: Find Sentry DSNs
requires:
  bins: ["sentry"]
  auth: true
---

# Dsn Commands

Find Sentry DSNs

### `sentry dsn list [<org/project>]`

List DSNs

**Flags:**
- `-n, --limit <value> - Maximum number of DSNs to list - (default: "25")`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`
- `-c, --cursor <value> - Navigate pages: "next", "prev", "first" (or raw cursor string)`

**Examples:**

```bash
# List client keys for detected projects, including monorepos
sentry dsn list

# List enabled and disabled DSNs for one project
sentry dsn list my-org/my-project

# List DSNs across all accessible projects in an organization
sentry dsn list my-org/

# Navigate between pages
sentry dsn list my-org/ --limit 10 -c next
sentry dsn list my-org/ --limit 10 -c prev

# Select public DSN fields as JSON
sentry dsn list my-org/my-project --json --fields name,dsn,isActive
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
