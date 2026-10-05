---
name: sentry-cli-platform
version: 0.47.0-dev.0
description: List valid Sentry platform identifiers
requires:
  bins: ["sentry"]
  auth: true
---

# Platform Commands

List valid Sentry platform identifiers

### `sentry platform list`

List all valid Sentry platform identifiers

**Flags:**
- `-q, --search <value> - Filter platforms by substring`

**Examples:**

```bash
# List all valid Sentry platform identifiers
sentry platform list

# Filter by substring
sentry platform list --search python

# Shortcut for `sentry platform list`
sentry platforms

# Output as JSON
sentry platform list --json
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
