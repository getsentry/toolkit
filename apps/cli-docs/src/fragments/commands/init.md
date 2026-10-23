

> **Experimental:** `sentry init` is experimental and may modify your source files. Always review changes before committing.

**Authentication:** Interactive runs start the OAuth login flow automatically when credentials are missing or the stored session has expired. Non-interactive and CI runs must authenticate before running `sentry init`.

In organization, team, and monorepo app selectors, type to filter the loaded choices by name or slug. The filter appears as `/text` below the list. Matching ignores case and tolerates small typos, including in unfinished prefixes such as `frone` for `frontend-web`. Queries with one or two characters match literal text only. Use arrow keys to navigate, Enter to select, and Backspace to edit. Esc clears an active filter; with no filter, Esc cancels. Ctrl+C always cancels.

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
