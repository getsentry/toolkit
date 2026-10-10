---
title: Agentic Usage
description: Enable AI coding agents to use the Sentry CLI
---

AI coding agents can use the Sentry CLI through the skill system. The CLI detects and supports Claude Code (including Cowork), Cursor, Windsurf, GitHub Copilot, Gemini CLI, OpenAI Codex, Goose, Amp, Augment, OpenCode, Cline, Grok, Kimi, Junie, OpenClaw, and any agent that reads skills from `~/.agents`. This allows agents to interact with Sentry directly from your development environment.

## Automatic Installation

The curl installer and Homebrew run `sentry cli setup`, which installs agent skills into detected agent root directories (`~/.claude`, `~/.agents`). After a package-manager install, run `sentry cli setup` yourself. `sentry cli upgrade` also refreshes skills. No network fetch is needed — skill files are embedded in the binary.

This uses the same `~/.agents` convention as [dotagents](https://github.com/getsentry/dotagents), Sentry's first-party tool for installing agent skills. See [Manual Installation](#manual-installation) to add the skill with dotagents yourself.

To skip automatic skill installation, pass `--no-agent-skills` to `sentry cli setup`.

## Manual Installation

### dotagents (recommended)

[dotagents](https://github.com/getsentry/dotagents) is Sentry's first-party tool for installing agent skills. It configures Claude, Cursor, Codex, Grok, VS Code, OpenCode, and more from a single `agents.toml`.

Add the Sentry CLI skill from its well-known source:

```bash
npx @sentry/dotagents add https://cli.sentry.dev sentry-cli
```

This installs the skill globally under `~/.agents/` and makes it available across all your projects. The first `add` bootstraps `~/.agents/agents.toml` for you — no `init` step is required.

To install the skill for a single repository instead, initialize project scope first, then add it:

```bash
npx @sentry/dotagents --project init
npx @sentry/dotagents --project add https://cli.sentry.dev sentry-cli
```

### skills

Alternatively, use the `skills` CLI:

```bash
npx skills add https://cli.sentry.dev
```

Either command registers the Sentry CLI as a skill that your agent can invoke when needed.

## Capabilities

With this skill, agents can:

- **View issues** - List and inspect Sentry issues from your projects
- **Inspect events** - Look at specific error events and their details
- **AI analysis** - Get root cause analysis and fix plans via Seer AI
- **Browse projects** - List projects and organizations you have access to
- **Explore the API** - Browse API endpoints with `sentry schema` and make arbitrary requests with `sentry api`
- **Query documentation** - Ask questions about Sentry setup and configuration with `sentry docs`
- **Make API calls** - Execute arbitrary Sentry API requests
- **Authenticate** - Help you set up CLI authentication
- **View agent conversations** - List and inspect AI agent conversation transcripts with `sentry agent-conversation`
- **Check service status** - Query the Sentry status page with `sentry status` (no auth required)
- **Process WebAssembly** - Add build IDs and split debug data from wasm modules with `sentry wasm-split` (no auth required)

## How It Works

When you ask your agent about Sentry errors or want to investigate an issue, the agent uses CLI commands to fetch real data from your Sentry account. For example:

- "Show me the latest issues in my project" → `sentry issue list`
- "What's the stack trace for ISSUE-123?" → `sentry issue view ISSUE-123`
- "List all projects in my organization" → `sentry project list my-org`
- "What API endpoints exist for releases?" → `sentry schema releases`
- "How do I set up source maps for Next.js?" → `sentry docs "source maps Next.js"`
- "What is Sentry's status right now?" → `sentry status`
- "Show me recent agent conversations" → `sentry agent-conversation list`

The CLI has dedicated commands for most Sentry tasks, so agents should prefer `sentry` commands over constructing raw API calls. The `sentry docs` command queries Sentry's documentation directly from the terminal, the `sentry schema` command provides built-in API exploration, and `sentry api` handles authenticated requests for anything not covered by a dedicated command.

The skill uses your existing CLI authentication, so you'll need to run `sentry auth login` first if you haven't already.

## Requirements

- An authenticated Sentry CLI installation (`sentry auth login`)
- An AI coding agent that supports the skills system (e.g., Claude Code, Cursor, Windsurf, GitHub Copilot, Gemini CLI, Codex, Goose, Amp, Augment, OpenCode, Cline, Grok, Kimi, Junie, OpenClaw, or any agent that reads from `~/.agents`)
