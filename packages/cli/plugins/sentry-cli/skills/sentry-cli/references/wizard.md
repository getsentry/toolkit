---
name: sentry-cli-wizard
version: 0.52.0-dev.0
description: Set up the Sentry SDK in your project interactively
requires:
  bins: ["sentry"]
  auth: true
---

# Wizard Commands

Set up the Sentry SDK in your project interactively

### `sentry wizard [<org>/<project>] [<integration>]`

Set up the Sentry SDK in your project interactively

**Arguments:**

| Argument | Description |
|----------|-------------|
| `[<org>/<project>] [<integration>]` | &lt;org&gt;/&lt;project&gt; to set up (skips the project picker), then the integration (skips the integration picker) |

**Flags:**
- `-f, --force - Change a project with uncommitted changes without asking, and install the SDK even when the package manager's checks fail`

**Examples:**

```bash
# Pick an integration and a project, then set it up
sentry wizard

# Set up Next.js, picking the project
sentry wizard nextjs

# Set up Next.js for a known org and project
sentry wizard my-org/my-project nextjs

# Set up Next.js for Spotlight, without a Sentry account
SENTRY_SPOTLIGHT=1 sentry wizard nextjs
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
