---
name: sentry-cli-docs
version: 0.48.0-dev.0
description: Search and query current Sentry documentation
requires:
  bins: ["sentry"]
  auth: true
---

# Docs Commands

Search and query current Sentry documentation

### `sentry docs list <keywords...>`

Find Sentry documentation pages by keyword

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<keywords...>` | Documentation keywords |

**Flags:**
- `-n, --limit <value> - Maximum matches to return (1-20) - (default: "8")`

**Examples:**

```bash
# Search the documentation index
sentry docs list "source maps"

# Limit the number of results
sentry docs list "session replay privacy" --limit 5

# Output as JSON
sentry docs list "source maps" --json
```

### `sentry docs query <question...>`

Ask a cited question about Sentry documentation

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<question...>` | Natural-language docs question |

**Examples:**

```bash
# Ask a documentation question
sentry docs "How do I configure tracing in Next.js?"

# Use the explicit subcommand
sentry docs query "How do I upload source maps?"

# Use the search alias
sentry docs search "How does session replay mask text?"

# Output the answer as JSON
sentry docs "How do I configure tracing?" --json
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
