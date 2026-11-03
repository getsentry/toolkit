# Claude Code Plugin

How the Claude Code plugin is structured and how to modify it.

## Overview

The plugin registers a `sentry-mcp` subagent that Claude Code automatically delegates to when users ask about Sentry errors, issues, traces, or performance. The subagent connects to the remote MCP server and has access to all Sentry tools.

Two variants are published:

| Plugin                    | MCP URL                                     | Purpose                         |
| ------------------------- | ------------------------------------------- | ------------------------------- |
| `sentry-mcp`              | `https://mcp.sentry.dev/mcp`                | Default catalog gateway surface |
| `sentry-mcp-experimental` | `https://mcp.sentry.dev/mcp?experimental=1` | Forward-looking feature flags   |

## Directory Layout

```
.claude-plugin/
  marketplace.json        # Plugin registry — lists both variants

plugins/
  sentry-mcp/
    .claude-plugin/
      plugin.json         # Plugin metadata (name, description, author)
    .mcp.json             # MCP server connection config
    agents/
      sentry-mcp.md       # Agent prompt with YAML frontmatter

  sentry-mcp-experimental/
    .claude-plugin/
      plugin.json
    .mcp.json             # Same as stable but with ?experimental=1
    agents/
      sentry-mcp.md       # Same agent prompt as stable
```

## Agent `.md` Frontmatter

Each agent file (`plugins/*/agents/sentry-mcp.md`) has YAML frontmatter that controls how Claude Code loads the subagent:

```yaml
---
name: sentry-mcp
description: Sentry error tracking and performance monitoring agent. Use when
  the user asks about errors, exceptions, issues, stack traces, performance,
  traces, releases, or provides a Sentry URL.
mcpServers:
  - sentry # References the server name from .mcp.json
allowedTools:
  - analyze_issue_with_seer
  - search_issues
  - ... # Default-grant direct MCP tool names
---
```

- **`name`** — The subagent name Claude Code uses for delegation.
- **`description`** — Tells Claude Code when to delegate to this agent. This is critical for routing — it must mention the key trigger phrases (errors, issues, traces, etc.).
- **`mcpServers`** — References the server key from the sibling `.mcp.json` file.
- **`allowedTools`** — Restricts which MCP tools the subagent can call. This list is **auto-generated** by the `generate-definitions` script.

The body below the frontmatter is the agent's system prompt.

## Keeping `allowedTools` in Sync

The `allowedTools` list in the agent frontmatter must match the generated default-grant direct MCP surface. The `generate-definitions` script handles this automatically:

```bash
pnpm run --filter @sentry/mcp-core generate-definitions
```

This script:

1. Imports all tools from `packages/mcp-core/src/tools/index.ts`
2. Imports all skills from `packages/mcp-core/src/skills.ts`
3. Writes `toolDefinitions.json` and `skillDefinitions.json` to `packages/mcp-core/src/`
4. Updates `allowedTools` in both `plugins/sentry-mcp/agents/sentry-mcp.md` and `plugins/sentry-mcp-experimental/agents/sentry-mcp.md`, using the default-grant direct surface for each plugin mode. Optional-skill tools remain reachable through `search_sentry_tools` and `execute_sentry_tool` when available.

The script runs automatically as a `prebuild` and `pretest` hook in `packages/mcp-core/package.json`. Run it explicitly after:

- Adding, removing, or renaming tools
- Changing tool skills assignments
- Modifying agent prompts (to verify frontmatter stays valid)

The script skips regeneration if all outputs are newer than all inputs (tool source files, `skills.ts`, and the script itself).

## Modifying the Agent Prompt

1. Edit the body (below the `---` frontmatter) in `plugins/sentry-mcp/agents/sentry-mcp.md`.
2. Copy the same change to `plugins/sentry-mcp-experimental/agents/sentry-mcp.md` — the two variants share the same prompt.
3. Run `pnpm run --filter @sentry/mcp-core generate-definitions` to ensure `allowedTools` is still in sync.

Do **not** manually edit the `allowedTools` list — it will be overwritten on the next generation run.

## Adding a New Plugin Variant

1. Create a new directory under `plugins/` with `.claude-plugin/plugin.json`, `.mcp.json`, and `agents/sentry-mcp.md`.
2. Add an entry to `.claude-plugin/marketplace.json`.
3. Add the new directory name to the `agentDirs` array in `packages/mcp-core/scripts/generate-definitions.ts` so `allowedTools` gets synced.
