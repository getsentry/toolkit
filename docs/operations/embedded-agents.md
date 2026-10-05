# Embedded Agent Configuration

Configuration guide for embedded AI agents used by AI-powered search tools in Sentry MCP.

## Overview

Sentry MCP uses embedded AI agents for the following tools:
- `search_errors`, `search_logs`, `search_traces`, `search_metrics`, `search_profiles`, `search_replays` - Natural language search over one dataset each (share one handler; `search_events` remains as a deprecated catalog alias)
- `search_issues` - Natural language search across issues
- `search_issue_events` - Search events within a specific issue

These tools require an LLM provider (OpenAI, Azure OpenAI, Anthropic, or OpenRouter) to be configured.

## Provider Selection

### Explicit Configuration (Recommended)

Always set `EMBEDDED_AGENT_PROVIDER` to explicitly specify your LLM provider:

```bash
export EMBEDDED_AGENT_PROVIDER=openai   # or 'azure-openai' / 'anthropic' / 'openrouter'
export OPENAI_API_KEY=sk-...            # corresponding API key
```

> **Deprecation Notice:** Auto-detection based on API keys alone is deprecated and will be removed in a future release. Please update your configuration to explicitly set `EMBEDDED_AGENT_PROVIDER`.

### Resolution Order

Sentry MCP resolves the LLM provider in this order:

1. **Explicit configuration** (highest priority)
   - `EMBEDDED_AGENT_PROVIDER` environment variable
   - `--agent-provider` CLI flag

2. **Conflict detection**
   - If multiple provider keys are set without explicit provider selection, an error is thrown
   - This prevents silent bugs when external tools inject API keys

3. **Auto-detection** (lowest priority, **deprecated**)
   - If only `ANTHROPIC_API_KEY` is set → use Anthropic
   - If only `OPENAI_API_KEY` is set → use OpenAI
   - If only `OPENROUTER_API_KEY` is set → use OpenRouter
   - A deprecation warning is logged when this fallback is used

### Configuration Methods

#### Method 1: Environment Variable (Recommended)

Set `EMBEDDED_AGENT_PROVIDER` to explicitly choose a provider:

```bash
export EMBEDDED_AGENT_PROVIDER=openai
export OPENAI_API_KEY=sk-...
```

Or:

```bash
export EMBEDDED_AGENT_PROVIDER=azure-openai
export OPENAI_API_KEY=sk-...
npx @sentry/mcp-server --openai-base-url=https://example.openai.azure.com/openai/v1/
```

Or:

```bash
export EMBEDDED_AGENT_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-ant-...
```

For OpenRouter:

```bash
export OPENROUTER_API_KEY=sk-or-...
# Optional; defaults to openai/gpt-5.6-luna with reasoning effort high
export OPENROUTER_MODEL=openai/gpt-5.6-luna
export OPENROUTER_REASONING_EFFORT=high
# Recommended, and required when multiple provider keys are set
export EMBEDDED_AGENT_PROVIDER=openrouter
```

#### Method 2: CLI Flag

```bash
npx @sentry/mcp-server --agent-provider=openai --access-token=...
```

#### Method 3: MCP Configuration File

In your MCP settings (e.g., Claude Desktop config):

```json
{
  "mcpServers": {
    "sentry": {
      "command": "npx",
      "args": ["@sentry/mcp-server"],
      "env": {
        "SENTRY_ACCESS_TOKEN": "your-token",
        "EMBEDDED_AGENT_PROVIDER": "openai",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

## Handling Conflicts with External Tools

### Problem: Claude Agent SDK Injection

When using Sentry MCP with tools like the Claude Agent SDK, the SDK may inject `ANTHROPIC_API_KEY` into the environment. This causes conflicts if you want to use OpenAI instead.

**Before (incorrect auto-detection):**
```bash
# Claude SDK injects ANTHROPIC_API_KEY
# Your MCP config only sets OPENAI_API_KEY
# Result: Sentry MCP incorrectly uses Anthropic
```

**After (explicit provider selection):**
```bash
# Claude SDK injects ANTHROPIC_API_KEY
# Your MCP config sets OPENAI_API_KEY and EMBEDDED_AGENT_PROVIDER=openai
# Result: Sentry MCP correctly uses OpenAI
```

### Solution

Always set `EMBEDDED_AGENT_PROVIDER` when multiple API keys might be present:

```json
{
  "mcpServers": {
    "sentry": {
      "command": "npx",
      "args": ["@sentry/mcp-server"],
      "env": {
        "SENTRY_ACCESS_TOKEN": "your-token",
        "EMBEDDED_AGENT_PROVIDER": "openai",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

## Error Messages

### "Multiple LLM API keys are set"

```
Error: Multiple LLM API keys are set.
Please specify which provider to use by setting the EMBEDDED_AGENT_PROVIDER
environment variable to 'openai', 'azure-openai', 'anthropic', or 'openrouter'.
```

**Cause:** Multiple API keys detected without explicit provider selection.

**Solution:** Set `EMBEDDED_AGENT_PROVIDER` to choose which provider to use.

### "Provider configured but API key not set"

```
Error: Provider "openai" is configured but OPENAI_API_KEY is not set.
Please set the API key environment variable.
```

**Cause:** Explicit provider selected but corresponding API key is missing.

**Solution:** Set the required API key environment variable.

### "No embedded agent provider configured"

```
Error: No embedded agent provider configured.
Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or OPENROUTER_API_KEY environment variable,
or use --agent-provider flag to specify a provider.
```

**Cause:** No API keys found and no provider specified.

**Solution:** Set at least one API key environment variable.

## Advanced Configuration

### Custom Base URLs

For custom OpenAI-compatible endpoints or Anthropic proxies:

```bash
export EMBEDDED_AGENT_PROVIDER=openai
export OPENAI_API_KEY=sk-...
npx @sentry/mcp-server --openai-base-url=https://custom.openai.example.com
```

For Azure OpenAI or Azure-compatible deployment proxies, use the dedicated
provider instead of the generic `openai` mode:

```bash
export EMBEDDED_AGENT_PROVIDER=azure-openai
export OPENAI_API_KEY=sk-...
export OPENAI_API_VERSION=2024-02-15-preview

# Azure v1 endpoint -> Responses API
npx @sentry/mcp-server --openai-base-url=https://example.openai.azure.com/openai/v1/

# Deployment endpoint -> chat completions
npx @sentry/mcp-server --openai-base-url=https://example.openai.azure.com/openai/deployments/my-assistant
```

### Model Selection

Override the default model for each provider:

```bash
# OpenAI (default: gpt-5)
export OPENAI_MODEL=gpt-4

# Anthropic (default: claude-opus-4-5-20251101)
export ANTHROPIC_MODEL=claude-sonnet-4-5-20250929

# OpenRouter (default: openai/gpt-5.6-luna @ high)
export OPENROUTER_MODEL=anthropic/claude-sonnet-4
export OPENROUTER_REASONING_EFFORT=high
```

### Verify Configuration

Check which provider is being used:

```bash
npx @sentry/mcp-server --access-token=... 2>&1 | grep "Using"
```

Expected output:
```
Using openai responses API for AI-powered search tools (from EMBEDDED_AGENT_PROVIDER).
```

Or:
```
Using anthropic for AI-powered search tools (auto-detected).
```

Or:
```
Using openrouter for AI-powered search tools (auto-detected).
```

## Troubleshooting

### Provider not detected

**Check environment variables:**
```bash
echo $ANTHROPIC_API_KEY
echo $OPENAI_API_KEY
echo $OPENROUTER_API_KEY
echo $EMBEDDED_AGENT_PROVIDER
```

**Verify API key format:**
- OpenAI: `sk-...` (starts with `sk-`)
- Anthropic: `sk-ant-...` (starts with `sk-ant-`)
- OpenRouter: `sk-or-...` (starts with `sk-or-`)

### External tool conflicts

If external tools (like Claude SDK, LangChain, etc.) inject API keys:

1. Use `EMBEDDED_AGENT_PROVIDER` to override auto-detection
2. Consider using a wrapper script to filter environment variables
3. Report the issue to the external tool's maintainers

### Testing provider selection

Test with both API keys present:

```bash
export ANTHROPIC_API_KEY=sk-ant-test
export OPENAI_API_KEY=sk-test
export EMBEDDED_AGENT_PROVIDER=openai

npx @sentry/mcp-server --access-token=...
```

Should output:
```
Using openai responses API for AI-powered search tools (from EMBEDDED_AGENT_PROVIDER).
```

## Related Documentation

- [Security](security.md) - Authentication and token management
- [Testing](../testing/overview.md) - Testing MCP server functionality
- [Common Patterns](../contributing/common-patterns.md) - Error handling and shared formatting patterns
- [Tool Responses](../contributing/tool-responses.md) - Tool output policy and QA review checklist
