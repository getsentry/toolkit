---
name: sentry-cli-schema
version: 0.48.0-dev.0
description: Browse the Sentry API schema
requires:
  bins: ["sentry"]
  auth: true
---

# Schema Commands

Browse the Sentry API schema

### `sentry schema <resource...>`

Browse the Sentry API schema

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<resource...>` | API concept, CLI command path, exact operation ID, or METHOD /path |

**Flags:**
- `--all - Show all endpoints in a flat list`
- `-q, --search <value> - Search endpoints by keyword`

**Examples:**

```bash
# List all API resources
sentry schema

# Browse issue endpoints
sentry schema issues

# Find list operations (there may be multiple candidates)
sentry schema issues list

# Find APIs used by log listing
sentry schema log list

# Find APIs used by trace listing, including command aliases
sentry schema trace ls

# Find APIs used by a command group
sentry schema alert metrics

# Find APIs used by a nested command
sentry schema alert metrics view

# Look up an endpoint by its exact operation ID
sentry schema listOrganizationEvents

# Look up an endpoint by HTTP method and path
sentry schema "GET /api/0/organizations/{organization_id_or_slug}/issues/"

# Search for monitoring-related endpoints
sentry schema --search monitor

# Browse resources matching a glob
sentry schema 'monitor*'

# Flat list of every endpoint
sentry schema --all
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
