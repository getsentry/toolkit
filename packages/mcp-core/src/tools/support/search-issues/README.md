# Search Issues Agent

AI-powered natural language to Sentry issue search translation.

## Overview

The `search_issues` tool uses an embedded AI agent to translate natural language queries into Sentry issue search syntax. It provides intelligent searching for grouped issues/problems rather than individual events.

## Architecture

- **Handler**: `handler.ts` - MCP tool definition and orchestration
- **Agent**: `agent.ts` - AI translation logic
- **Config**: `config.ts` - System prompts and settings
- **Formatters**: `formatters.ts` - Result formatting

## Agent Tools

The AI agent has access to these shared agent tools from `../../agent-tools/`:

1. **issueFields**: Discovers available fields for issue searches using `dataset="search_issues"`
2. **whoami**: Gets current user information to resolve 'me' references

## Natural Language Examples

- "critical bugs from last week" → `is:unresolved lastSeen:-7d`
- "issues assigned to me" → Uses whoami tool → `assigned_or_suggested:user@email.com`
- "affecting 100+ users" → `userCount:>100`
- "production errors" → `environment:production level:error`

## Features

- ✅ Natural language query translation
- ✅ Error feedback loop for self-correction
- ✅ 'Me' reference resolution via whoami tool
- ✅ Field discovery with custom tags
- ✅ Smart sort options (date, freq, new, user, recommended)
- ✅ Configurable result limits (1-100, default 10)
- ✅ Project-specific and organization-wide searches

## Usage

```typescript
search_issues({
  organizationSlug: "my-org",
  query: "critical bugs from last week",
  limit: 25,
  includeExplanation: true,
});
```
