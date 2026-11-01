---
name: sentry-cli-mcp
version: 0.48.0-dev.0
description: Start a local Sentry MCP server
requires:
  bins: ["sentry"]
  auth: true
---

# Mcp Commands

Start a local Sentry MCP server

### `sentry mcp`

Start a local Sentry MCP server

**Flags:**
- `--access-token <value> - Deprecated: set SENTRY_AUTH_TOKEN instead`
- `--org <value> - Limit every call to this organization`
- `--project <value> - Limit calls to this project`
- `--skills <value> - Skills to grant, comma-separated (default: active skills; seer is left out on self-hosted)`
- `--all-skills - Grant every active skill, including seer on self-hosted`
- `--disable-skills <value> - Skills to remove, comma-separated`
- `--experimental - Enable forward-looking tool variants and experimental features`
- `--agent-provider <value> - LLM provider for AI-powered search: openai, azure-openai, anthropic, or openrouter`
- `--openai-base-url <value> - OpenAI API base URL`
- `--openai-model <value> - OpenAI model (default: gpt-5)`
- `--anthropic-base-url <value> - Anthropic API base URL`
- `--anthropic-model <value> - Anthropic model (default: claude-sonnet-4-5)`
- `--mcp-url <value> - MCP server URL reported in telemetry`
- `--sentry-dsn <value> - DSN for the server's own telemetry`

**Examples:**

```bash
# Start the server with the current CLI login
sentry mcp

# Grant every skill, including seer on self-hosted
sentry mcp --all-skills

# Grant only some skills
sentry mcp --skills inspect,triage

# Pick the LLM provider for AI-powered search
sentry mcp --agent-provider anthropic
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
