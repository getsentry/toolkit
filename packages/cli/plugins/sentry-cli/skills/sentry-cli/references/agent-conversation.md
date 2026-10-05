---
name: sentry-cli-agent-conversation
version: 0.47.0-dev.0
description: List and view agent conversations
requires:
  bins: ["sentry"]
  auth: true
---

# Agent-conversation Commands

List and view agent conversations

### `sentry agent-conversation list <org>`

List recent agent conversations

**Flags:**
- `-n, --limit <value> - Number of conversations (1-1000) - (default: "25")`
- `-q, --query <value> - Search query`
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

# Explicit organization
sentry agent-conversation list my-org

# Show more, last 24 hours
sentry agent-conversation list --limit 50 --period 24h

# Filter conversations
sentry agent-conversation list -q "has:errors"

# Paginate through results
sentry agent-conversation list my-org -c next
```

### `sentry agent-conversation view <org/conversation-id>`

View an agent conversation transcript

**Flags:**
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`

**Examples:**

```bash
# View full transcript (org auto-detected)
sentry agent-conversation view conv-123

# Explicit org (slash-separated)
sentry agent-conversation view my-org/conv-123

# JSON output
sentry agent-conversation view my-org/conv-123 --json
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
