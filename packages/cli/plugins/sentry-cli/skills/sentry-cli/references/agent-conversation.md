---
name: sentry-cli-agent-conversation
version: 0.48.0-dev.0
description: List and view agent conversations
requires:
  bins: ["sentry"]
  auth: true
---

# Agent-conversation Commands

List and view agent conversations

### `sentry agent-conversation list [<org/project>]`

List recent agent conversations

**Flags:**
- `-n, --limit <value> - Number of conversations (1-1000) - (default: "25")`
- `-q, --query <value> - Any matching span selects its conversation; totals include all spans in selected projects and time range`
- `-t, --period <value> - Time range: "7d", "2024-01-01..2024-02-01", ">=2024-01-01" - (default: "7d")`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`
- `-c, --cursor <value> - Navigate pages: "next", "prev", "first" (or raw cursor string)`

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `conversationId` | string |  |
| `webUrl` | string |  |
| `title` | string \| null |  |
| `flow` | array |  |
| `errors` | number |  |
| `llmCalls` | number |  |
| `toolCalls` | number |  |
| `totalTokens` | number |  |
| `totalCost` | number |  |
| `startTimestamp` | number |  |
| `endTimestamp` | number |  |
| `traceCount` | number |  |
| `traceIds` | array |  |
| `firstInput` | string \| null |  |
| `lastOutput` | string \| null |  |
| `user` | object \| null |  |
| `toolNames` | array |  |
| `toolErrors` | number |  |

**Examples:**

```bash
# List recent agent conversations
sentry agent-conversation list

# Explicit organization (all projects)
sentry agent-conversation list my-org/

# One project
sentry agent-conversation list my-org/my-project

# Find a project across organizations
sentry agent-conversation list my-project

# Show more, last 24 hours
sentry agent-conversation list --limit 50 --period 24h

# Find conversations with errors
sentry agent-conversation list -q "conversation.errors:>0"

# Find conversations for an agent
sentry agent-conversation list -q "gen_ai.agent.name:my-agent"

# Find conversations with more than two tool calls
sentry agent-conversation list -q "conversation.toolCalls:>2"

# Find conversations that used a tool
sentry agent-conversation list -q "gen_ai.tool.name:search_issues"

# Paginate through project results
sentry agent-conversation list my-org/my-project -c next
```

### `sentry agent-conversation view [<org>/]<conversation-id>`

View an agent conversation transcript

**Flags:**
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`

**Examples:**

```bash
# View full transcript (organization auto-detected)
sentry agent-conversation view conv-123

# Explicit organization
sentry agent-conversation view my-org/conv-123

# JSON output
sentry agent-conversation view my-org/conv-123 --json
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
