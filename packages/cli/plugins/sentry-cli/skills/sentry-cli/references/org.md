---
name: sentry-cli-org
version: 0.48.0-dev.0
description: Work with Sentry organizations
requires:
  bins: ["sentry"]
  auth: true
---

# Org Commands

Work with Sentry organizations

### `sentry org list`

List organizations

**Flags:**
- `-n, --limit <value> - Maximum number of organizations to list - (default: "25")`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`
- `--account <value> - Only list organizations of this stored account (email, username, or account id)`

### `sentry org view [<org>]`

View details of an organization

**Flags:**
- `-w, --web - Open in browser`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`

**Examples:**

```bash
# List organizations
sentry org list

# Only one account's organizations
sentry org list --account jane@acme.com

# View organization details
sentry org view my-org

# Open in browser
sentry org view my-org -w

# JSON output
sentry org list --json
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
