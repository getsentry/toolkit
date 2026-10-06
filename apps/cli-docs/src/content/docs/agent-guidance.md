---
title: Agent Guidance
description: Operational guidance for AI coding agents using the Sentry CLI
---

Best practices and operational guidance for AI coding agents using the Sentry CLI.

## Key Principles

- **Just run the command** — the CLI handles authentication and org/project detection automatically. Don't pre-authenticate or look up org/project before running commands. The CLI prompts for login if needed.
- **Prefer CLI commands over raw API calls** — the CLI has dedicated commands for most tasks. Reach for `sentry issue view`, `sentry issue list`, `sentry trace view`, etc. before constructing API calls manually or fetching external documentation.
- **Use `sentry docs` for setup questions** — if you need to know how to configure a Sentry SDK or feature, run `sentry docs "your question"` to query the documentation directly. This is faster and more accurate than fetching docs externally.
- **Use `sentry schema` to explore the API** — if you need to discover API endpoints, run `sentry schema` to browse interactively or `sentry schema <resource>` to search. This is faster than fetching OpenAPI specs externally.
- **Use `sentry issue view` to investigate issues** — when asked about a specific issue (e.g., `CLI-G5`, `PROJECT-123`), use `sentry issue view` directly. Multiple IDs can be passed in one invocation: `sentry issue view A B C --json` returns an array of the same objects.
- **Use `--json` for machine-readable output** — pipe through `jq` for filtering. Human-readable output includes formatting that is hard to parse.
- **The CLI auto-detects org/project — don't discover it yourself** — most commands work without explicit targets by checking `.sentryclirc` config files, scanning for DSNs in `.env` files and source code, and matching directory names. Do **not** run `sentry org list` and then `sentry project list` to figure out which project this checkout belongs to — that manual fan-out just replicates the detection the CLI already runs on every command. Only specify `<org>/<project>` when the CLI reports it can't detect the target or detects the wrong one.

## Design Principles

The `sentry` CLI follows conventions from well-known tools — if you're familiar with them, that knowledge transfers directly:

- **`gh` (GitHub CLI) conventions**: The `sentry` CLI uses the same `<noun> <verb>` command pattern (e.g., `sentry issue list`, `sentry org view`). Flags follow `gh` conventions: `--json` for machine-readable output, `--fields` to select specific fields, `-w`/`--web` to open in browser, `-q`/`--query` for filtering, `-n`/`--limit` for result count.
- **`sentry api` mimics `curl`**: The `sentry api` command provides direct API access with a `curl`-like interface — `--method` for HTTP method, `--data` for request body, `--header` for custom headers. It handles authentication automatically. If you know how to call a REST API with `curl`, the same patterns apply.

## Context Window Tips

- Use `--json --fields` to select specific fields and reduce output size. Run `<command> --help` to see available fields. Example: `sentry issue list --json --fields shortId,title,priority,level,status`
- Use `--json` when piping output between commands or processing programmatically
- Use `--limit` to cap the number of results (default is usually 10–100)
- Prefer `sentry issue view PROJECT-123` over listing and filtering manually
- Pass multiple issue IDs in one call (`sentry issue view A B C --json`) instead of looping `issue view` per ID
- Analyze multiple issues in one call (`sentry issue explain A B C --json`) instead of looping `issue explain` per ID
- Use `sentry api` for endpoints not covered by dedicated commands

## Safety Rules

- Always confirm with the user before running destructive commands: `project delete`, `trial start`
- For mutations, verify the org/project context looks correct in the command output before proceeding with further changes
- Never store or log authentication tokens — the CLI manages credentials automatically
- If the CLI reports the wrong org/project, override with explicit `<org>/<project>` arguments

## Exit Codes

The CLI uses semantic exit codes. Key ranges for agents:

| Range | Meaning | Agent Action |
|-------|---------|-------------|
| 0 | Success | Proceed normally |
| 10–19 | Auth error | Prompt user to run `sentry auth login` |
| 20–29 | Input error | Check command arguments and retry |
| 30–39 | API error | Retry or report to user |
| 40–49 | Feature unavailable | Inform user about plan/settings |
| 50–59 | Operation error | Report to user |
| 60–69 | Command-specific | Check stderr for details |

See [Exit Codes](/exit-codes/) for the complete reference.

## Workflow Patterns

### Investigate an Issue

```bash
# 1. Find the issue (auto-detects org/project from DSN or config)
sentry issue list --query "is:unresolved" --limit 5

# 2. Get details. For agents, prefer --json — it includes the full issue plus
# the latest event under `event`, so you get everything in one call.
sentry issue view PROJECT-123 --json

# 3. Get AI root cause analysis
sentry issue explain PROJECT-123

# 4. Get a fix plan
sentry issue plan PROJECT-123
```

`sentry issue view <SHORT-ID> --json` is the fastest way to get an agent up to
speed on an issue. Select just the fields you need with `--fields` instead of
consuming the whole payload — the latest event's `request` entry can carry live
session data (cookies, headers, body), so extract named fields rather than
dumping the entire object:

```bash
# Top-level issue fields
sentry issue view PROJECT-123 --json --fields shortId,title,culprit,count,userCount,permalink

# Named fields from the latest event — avoids pulling the full request/session blob
sentry issue view PROJECT-123 --json --fields event.id,event.title,event.dateCreated

# Just the request URL and method (not the whole request entry). Event data
# lives under event.entries[], each tagged with a `type` and `data` payload.
sentry issue view PROJECT-123 --json | jq '.event.entries[] | select(.type == "request") | .data | {url, method}'
```

### Explore Traces and Performance

```bash
# 1. List recent traces (auto-detects org/project)
sentry trace list --limit 5

# 2. View a specific trace with span tree
sentry trace view abc123def456...

# 3. View spans for a trace
sentry span list abc123def456...

# 4. View logs associated with a trace
sentry trace logs abc123def456...
```

### Stream Logs

```bash
# Stream logs in real-time (auto-detects org/project)
sentry log list --follow

# Filter logs by severity
sentry log list --query "severity:error"
```

### Capture Events Locally (Spotlight)

```bash
# Run the app with the local server auto-enabled; tail errors/traces/logs.
# No DSN needed — with no DSN, events go ONLY to the local server (nothing
# reaches the user's Sentry org, no production quota). With a DSN set, the
# SDK sends to both.
sentry local run -- npm run dev          # or: python manage.py runserver, etc.

# From a CLI source checkout, run the Local UI in a second terminal, then open it.
pnpm --filter local dev
sentry local run --open -- npm run dev

# Watch only AI/agent (gen_ai, mcp) spans while iterating on an agent.
sentry local -f ai

# Server-side SDKs read SENTRY_SPOTLIGHT automatically. The CLI also injects
# the URL under every framework client prefix (NEXT_PUBLIC_, VITE_, PUBLIC_,
# NUXT_PUBLIC_, REACT_APP_, VUE_APP_, GATSBY_). Until the browser SDK reads
# these automatically (getsentry/sentry-javascript#18198), reference the var
# matching your framework in the client config:
# Sentry.init({ spotlight: process.env.NEXT_PUBLIC_SENTRY_SPOTLIGHT ?? false })
```

### Query Sentry Documentation

```bash
# Ask a documentation question
sentry docs "How do I configure tracing in Next.js?"

# Search the documentation index
sentry docs list "source maps"
```

### Check Sentry Service Status

```bash
# Show current status of Sentry services
sentry status

# Machine-readable status
sentry status --json
```

### Explore the API Schema

```bash
# Browse all API resource categories
sentry schema

# Search for endpoints related to a resource
sentry schema issues

# Get details about a specific endpoint
sentry schema "GET /api/0/organizations/{organization_id_or_slug}/issues/"
```

### Manage Releases

```bash
# Create a release — version must match Sentry.init({ release }) exactly
sentry release create my-org/1.0.0 --project my-project

# Associate commits via repository integration (needs local git checkout)
sentry release set-commits my-org/1.0.0 --auto

# Or read commits from local git history (no integration needed)
sentry release set-commits my-org/1.0.0 --local

# Mark the release as finalized
sentry release finalize my-org/1.0.0

# Record a production deploy
sentry release deploy my-org/1.0.0 production
```

**Key details:**
- The positional is `<org-slug>/<version>`. In `sentry release create sentry/1.0.0`, `sentry` is the org and `1.0.0` is the version — the slash separates org from version, it is not part of the version string.
- The **version** must match the `release` value in `Sentry.init()`. If your SDK uses `"1.0.0"`, the command must use `org/1.0.0`.
- `--auto` requires a Sentry repository integration (GitHub/GitLab/Bitbucket) **and** a local git checkout. It matches your `origin` remote against Sentry's repo list. Without a checkout, use `--local`.
- With no flag, `set-commits` tries `--auto` first and falls back to `--local` on failure.

### View Agent Conversations

```bash
# List recent agent conversations (org auto-detected)
sentry agent-conversation list

# Explicit org, last 24 hours
sentry agent-conversation list my-org --period 24h

# View a conversation transcript
sentry agent-conversation view my-org/conv-123

# JSON output for programmatic access
sentry agent-conversation view conv-123 --json
```

### Process WebAssembly Modules

```bash
# Add a build id to a wasm module (no auth required)
sentry wasm-split app.wasm

# Capture the build id for a later debug-files upload
BUILD_ID=$(sentry wasm-split app.wasm)

# Split debug data into a companion and strip the shipped binary
sentry wasm-split app.wasm --debug-out app.debug.wasm --strip
```

### Arbitrary API Access

```bash
# GET request (default)
sentry api /api/0/organizations/my-org/

# POST request with data
sentry api /api/0/organizations/my-org/projects/ --method POST --data '{"name":"new-project","platform":"python"}'
```

## Dashboard Layout

Sentry dashboards use a **6-column grid**. When adding widgets, aim to fill complete rows (widths should sum to 6).

Display types with default sizes:

| Display Type | Width | Height | Category | Notes |
|---|---|---|---|---|
| `big_number` | 2 | 1 | common | Compact KPI — place 3 per row (2+2+2=6) |
| `line` | 3 | 2 | common | Half-width chart — place 2 per row (3+3=6) |
| `area` | 3 | 2 | common | Half-width chart — place 2 per row |
| `bar` | 3 | 2 | common | Half-width chart — place 2 per row |
| `table` | 6 | 2 | common | Full-width — always takes its own row |
| `stacked_area` | 3 | 2 | specialized | Stacked area chart |
| `top_n` | 3 | 2 | specialized | Top N ranked list |
| `categorical_bar` | 3 | 2 | specialized | Categorical bar chart |
| `text` | 3 | 2 | specialized | Static text/markdown widget |
| `details` | 3 | 2 | internal | Detail view |
| `wheel` | 3 | 2 | internal | Pie/wheel chart |
| `rage_and_dead_clicks` | 3 | 2 | internal | Rage/dead click visualization |
| `server_tree` | 3 | 2 | internal | Hierarchical tree display |
| `agents_traces_table` | 3 | 2 | internal | Agents traces table |

Use **common** types for general dashboards. Use **specialized** only when specifically requested. Avoid **internal** types unless the user explicitly asks.

Available datasets: `spans` (default), `errors`, `metrics`, `issue`, `logs`. Run `sentry dashboard widget --help` for dataset descriptions, query formats, and examples.

**Row-filling examples:**

```bash
# 3 KPIs filling one row (2+2+2 = 6)
sentry dashboard widget add <dashboard> "Error Count" --display big_number --query count
sentry dashboard widget add <dashboard> "P95 Duration" --display big_number --query p95:span.duration
sentry dashboard widget add <dashboard> "Throughput" --display big_number --query epm

# 2 charts filling one row (3+3 = 6)
sentry dashboard widget add <dashboard> "Errors Over Time" --display line --query count
sentry dashboard widget add <dashboard> "Latency Over Time" --display line --query p95:span.duration

# Full-width table (6 = 6)
sentry dashboard widget add <dashboard> "Top Endpoints" --display table \
  --query count --query p95:span.duration \
  --group-by transaction --sort -count --limit 10
```

## Quick Reference

### Time filtering

Use `--period` (alias: `-t`) to filter by time window:

```bash
sentry trace list --period 1h
sentry span list --period 24h
sentry span list -t 7d
```

### Scoping to an org or project

Org and project are positional arguments following `gh` CLI conventions:

```bash
sentry trace list my-org/my-project
sentry issue list my-org/my-project
sentry span list my-org/my-project/abc123def456...
```

### Listing spans in a trace

Pass the trace ID as a positional argument to `span list`:

```bash
sentry span list abc123def456...
sentry span list my-org/my-project/abc123def456...
```

### Dataset names for the Events API

When querying the Events API (directly or via `sentry api`), valid dataset values are: `spans`, `logs`, `errors`, `tracemetrics`, `profile_functions`, and `uptime_results`.

## Common Mistakes

- **Wrong issue ID format**: Use `PROJECT-123` (short ID), not the numeric ID `123456789`. The short ID includes the project prefix.
- **Pre-authenticating unnecessarily**: Don't run `sentry auth login` before every command. The CLI detects missing/expired auth and prompts automatically. Only run `sentry auth login` if you need to switch accounts.
- **Missing `--json` for piping**: Human-readable output includes formatting. Use `--json` when parsing output programmatically.
- **Specifying org/project when not needed**: Auto-detection resolves org/project from `.sentryclirc` config files, DSNs, env vars, and directory names. Let it work first — only add `<org>/<project>` if the CLI says it can't detect the target or detects the wrong one.
- **Manually discovering the project before running a command**: Don't list the orgs you belong to, then list every project in each, to match the local checkout to a project — the CLI already does exactly this resolution internally on each command. Skip the fan-out and run the command directly; correct the target afterwards only if the output shows the wrong org/project.
- **Confusing `--query` syntax**: The `--query` flag uses Sentry search syntax (e.g., `is:unresolved`, `assigned:me`), not free text search.
- **Not using `--web`**: View commands support `-w`/`--web` to open the resource in the browser — useful for sharing links.
- **Fetching API schemas instead of using the CLI**: Prefer `sentry schema` to browse the API and `sentry api` to make requests — the CLI handles authentication and endpoint resolution, so there's rarely a need to download OpenAPI specs separately.
- **Fetching Sentry docs externally**: Use `sentry docs "your question"` to query Sentry's documentation from the CLI — this returns concise answers with source links, without needing to fetch or parse documentation pages.
- **Release version mismatch**: The `org/version` positional is `<org-slug>/<version>`, where `org/` is the org, not part of the version. `sentry release create sentry/1.0.0` creates version `1.0.0` in org `sentry`. If your `Sentry.init()` uses `release: "1.0.0"`, this is correct. Don't double-prefix like `sentry/myapp/1.0.0`.
- **Running `set-commits --auto` without a git checkout**: `--auto` needs a local git repo to discover the origin remote URL and HEAD commit. In CI, ensure `actions/checkout` with `fetch-depth: 0` runs before `set-commits --auto`.
- **Using `sentry api` when CLI commands suffice**: `sentry issue list --json` and `sentry issue view --json` already include `shortId`, `title`, `count`, `userCount`, `priority`, `level`, `status`, `permalink`, and other fields at the top level. When using `--fields` to select specific fields like `count` or `userCount`, the CLI automatically ensures these fields are present in the API response. Use `--fields` to select specific fields and `--help` to see all available fields. Only fall back to `sentry api` for data the CLI doesn't expose.
