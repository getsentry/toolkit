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

### `sentry org list [<filter>]`

List organizations

**Flags:**
- `-n, --limit <value> - Maximum number of organizations to list - (default: "25")`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`
- `-a, --account <value> - Only list organizations of this account (email, username, or account id; <who>:<server> for one server; env:SENTRY_AUTH_TOKEN)`

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
# The same email on several servers: add the server
sentry org list -a jane@example.com:sentry.io

# Only organizations whose slug or name matches "acme", best matches first
# (case-insensitive; prefix, substring, and small typos match too)
sentry org list acme
# ...or matches a glob
sentry org list 'acme-*'

# View organization details
sentry org view my-org

# Open in browser
sentry org view my-org -w

# JSON output
sentry org list --json
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
