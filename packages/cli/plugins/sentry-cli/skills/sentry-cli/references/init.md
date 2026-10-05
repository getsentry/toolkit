---
name: sentry-cli-init
version: 0.47.0-dev.0
description: Initialize Sentry in your project (experimental)
requires:
  bins: ["sentry"]
  auth: true
---

# Init Commands

Initialize Sentry in your project (experimental)

### `sentry init <target> <directory>`

Initialize Sentry in your project (experimental)

**Flags:**
- `-y, --yes - Accept non-interactive defaults (requires --features outside a TTY)`
- `-n, --dry-run - Show what would happen without making changes`
- `--features <value>... - Features to enable: errors,tracing,logs,replay,profiling,crons,agent-tracing,mcp-observability`
- `-t, --team <value> - Team slug to create the project under`
- `--app <value> - App to initialize in a monorepo (required with --yes when multiple apps are detected)`
- `--tui - Use the Ink-based interactive UI (default). Pass --no-tui to fall back to plain log output.`

**Examples:**

```bash
# Interactive setup
sentry init

# Non-interactive agent/CI setup
sentry init --yes --features errors,tracing,replay

# Dry run to preview changes
sentry init --dry-run

# Target a subdirectory
sentry init ./my-app

# Use a specific org (auto-detect project)
sentry init acme/

# Use a specific org and project
sentry init acme/my-app

# Assign a team when creating a new project
sentry init acme/ --team backend

# Enable specific features
sentry init --features profiling,replay
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
