---
name: sentry-cli-init
version: 0.48.0-dev.0
description: Print instructions for a coding agent to set up Sentry
requires:
  bins: ["sentry"]
  auth: true
---

# Init Commands

Print instructions for a coding agent to set up Sentry

### `sentry init`

Print instructions for a coding agent to set up Sentry

**Examples:**

```bash
# Print the setup guide
sentry init

# Print the guide as JSON
sentry init --json
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
