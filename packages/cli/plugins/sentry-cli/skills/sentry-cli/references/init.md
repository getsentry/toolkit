---
name: sentry-cli-init
version: 0.50.0-dev.0
description: Print instructions for a coding agent to set up Sentry
requires:
  bins: ["sentry"]
  auth: true
---

# Init Commands

Print instructions for a coding agent to set up Sentry

### `sentry init`

Print instructions for a coding agent to set up Sentry

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `guide` | string | The setup guide's Markdown source |

**Examples:**

```bash
# Print the setup guide
sentry init

# Print the guide as JSON
sentry init --json
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
