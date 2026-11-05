---
name: sentry-cli-docs
version: 0.49.0-dev.0
description: Search the Sentry documentation
requires:
  bins: ["sentry"]
  auth: true
---

# Docs Commands

Search the Sentry documentation

### `sentry docs <words...>`

Search the Sentry documentation

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<words...>` | Words to search for |

**Flags:**
- `-e, --regexp <value>... - Only pages whose title or URL path matches this regular expression (repeatable)`
- `-n, --limit <value> - Maximum pages to return (1-50) - (default: "8")`
- `-f, --fresh - Refresh the cached docs index before searching`

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `results` | array | Matching pages, best match first |
| `warnings` | array | What the search changed about the input, such as a corrected typo |

**Examples:**

```bash
# Find pages by keywords
sentry docs nextjs tracing

# Combine several topics
sentry docs tracing cloudflare tanstack start

# Match URL paths with a regular expression
sentry docs -e 'guides/(nextjs|remix|sveltekit)/manual-setup$'

# Combine a pattern and words
sentry docs -e '/python/integrations/' celery

# Output as JSON
sentry docs source maps vite --json
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
