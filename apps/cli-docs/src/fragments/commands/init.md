

> **Experimental:** `sentry init` is experimental and may modify your source files. Always review changes before committing.

**Authentication:** Interactive runs start the OAuth login flow automatically when credentials are missing or the stored session has expired. Non-interactive and CI runs must authenticate before running `sentry init`.

## Examples

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

## Target Syntax

| Syntax | Meaning |
|--------|---------|
| _(omitted)_ | Auto-detect org and project |
| `acme/` | Use org `acme`, auto-detect or create project |
| `acme/my-app` | Use org `acme` and project `my-app` |
| `my-app` | Search for project `my-app` across all accessible orgs |

Path-like arguments (starting with `.`, `/`, or `~`) are always treated as the directory. The order of target and directory can be swapped — the CLI will auto-correct with a warning.

## Available Features

| Feature | Description |
|---------|-------------|
| `errors` | Error monitoring |
| `tracing` | Performance tracing |
| `logs` | Log integration |
| `replay` | Session replay |
| `profiling` | Profiling |
| `crons` | Cron job monitoring |
| `agent-tracing` | Agent tracing for AI/LLM apps |
| `mcp-observability` | MCP (Model Context Protocol) observability |

## What the Wizard Does

1. **Detects your framework** — scans your project files to identify the platform and framework
2. **Installs the SDK** — adds the appropriate Sentry SDK package to your project
3. **Instruments your code** — configures error monitoring, tracing, and any selected features

### Supported Platforms

- **JavaScript / TypeScript** — Next.js, Express, SvelteKit, React
- **Python** — Flask, FastAPI

More platforms and frameworks are coming soon.
