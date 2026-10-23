---
name: sentry-cli-attribute
version: 0.48.0-dev.0
description: Explore span, log, and metric attributes
requires:
  bins: ["sentry"]
  auth: true
---

# Attribute Commands

Explore span, log, and metric attributes

### `sentry attribute list [<org/project>]`

List attribute keys for spans, logs, or metrics

**Flags:**
- `-d, --dataset <value> - Dataset to list attributes for (spans, logs, metrics) - (default: "spans")`
- `--type <value>... - Find attributes of these types (string, number, boolean, array; repeatable, comma-separated)`
- `-s, --search <value> - Find attribute keys containing this text (case-sensitive)`
- `--with <value>... - Find attributes that appear on the same items as all of these keys (repeatable, comma-separated)`
- `-t, --period <value> - Time range: "7d", "2024-01-01..2024-02-01", ">=2024-01-01" - (default: "7d")`
- `-n, --limit <value> - Maximum number of attributes to list - (default: "25")`
- `--context - Include each attribute's description, examples, and deprecation info (experimental API)`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`
- `-c, --cursor <value> - Navigate pages: "next", "prev", "first" (or raw cursor string)`

**Examples:**

```bash
# List span attribute keys for a project
sentry attribute list my-org/my-project

# List log attribute keys across the whole organization
sentry attribute list my-org/ --dataset logs

# Find keys containing "gen_ai" that are also of type string
sentry attribute list --search gen_ai --type string

# Attributes seen on the same spans as the specified attribute
sentry attribute list --with gen_ai.request.model

# Show descriptions, example values, and deprecation info
sentry attribute list --context

# Show more than the default 25
sentry attribute list my-org/my-project -n 100

# Show the next page of the previous listing (same flags)
sentry attribute list my-org/my-project -n 100 -c next

# Select fields as JSON
sentry attribute list --json --fields key,type,source
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
