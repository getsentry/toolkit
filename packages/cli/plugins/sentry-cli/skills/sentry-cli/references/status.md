---
name: sentry-cli-status
version: 0.47.0-dev.0
description: Check Sentry service status
requires:
  bins: ["sentry"]
  auth: true
---

# Status Commands

Check Sentry service status

### `sentry status show`

Show Sentry service status

**Flags:**
- `--url <value> - Status page base URL to query - (default: "https://status.sentry.io")`

**Examples:**

```bash
# Show the current status of Sentry's services
sentry status

# Get machine-readable status (useful in scripts)
sentry status --json

# Check a self-hosted or regional status page (Statuspage CNAME)
sentry status --url https://status.acme.com
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
