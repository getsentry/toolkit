# sentry-mcp

This is a prototype of an MCP server, acting as a middleware to the upstream Sentry API provider.

This package is primarily for running the `stdio` MCP server. If you do not know what that is, or do not need it, we suggest using the public remote service:

<https://mcp.sentry.dev>

**Note:** Some tools require additional configuration:
- **AI-powered search tools** (the dataset search tools such as `search_errors`/`search_traces`/`search_logs`, and `search_issues`): These tools use a configured LLM provider to translate natural language queries into Sentry's query syntax. Set one provider key, such as `OPENAI_API_KEY` or `OPENROUTER_API_KEY`. Without a provider key, these specific tools will be unavailable, but all other tools will function normally.

## Authorization

The MCP server uses a **skills-based authorization system** that maps user-friendly capabilities to technical API permissions.

### Available Skills

By default (no `--skills` flag), the MCP server grants active, non-deprecated skills for non-interactive convenience:

- **`inspect`** (default) - View organizations, projects, teams, issues, traces, and search for errors
- **`seer`** (default) - Use Seer to analyze issues and generate fix recommendations
- **`triage`** - Resolve, assign, and update issues
- **`project-management`** - Create and modify projects, teams, and DSNs

Documentation tools are available through the `inspect` skill via the catalog: use `search_sentry_tools` to find documentation tools, then call `search_docs` or `get_doc` through `execute_sentry_tool`. The legacy `docs` skill can still be requested explicitly for docs-only catalog access, but it is not granted by default.

### Customizing Skills

You can limit which skills are granted using the `--skills` flag:

```shell
# Default: active skills (inspect, seer, triage, project-management)
npx @sentry/mcp-server@latest --access-token=sentry-user-token

# Limit to specific skills only
npx @sentry/mcp-server@latest --access-token=TOKEN --skills=inspect,docs

# Grant all active, non-deprecated skills, overriding MCP_SKILLS
npx @sentry/mcp-server@latest --access-token=TOKEN --all-skills

# Self-hosted Sentry
npx @sentry/mcp-server@latest --access-token=TOKEN --host=sentry.example.com

# Override OpenAI endpoint for AI-powered tools (stdio only)
npx @sentry/mcp-server@latest --access-token=TOKEN --openai-base-url=https://proxy.example.com/v1

# Azure OpenAI / Azure-compatible deployment routing (stdio only)
npx @sentry/mcp-server@latest --access-token=TOKEN --agent-provider=azure-openai --openai-base-url=https://example.openai.azure.com/openai/v1/
```

For Azure OpenAI or Azure-compatible deployment proxies, use the dedicated
`azure-openai` provider instead of generic `openai` mode:

- `/openai/v1` endpoints use the Responses API
- `/openai/deployments/<deployment>` endpoints use chat completions

Generic `openai` mode always uses the Responses API and treats `OPENAI_MODEL`
as an opaque model identifier.

### Constraint-Based Tool Exclusion

When a session is scoped to a specific organization or project (tenant-bound context), certain tools are automatically excluded when they would escape or duplicate that scope:

- **`find_organizations`** is hidden when the session is constrained to a specific organization (`organizationSlug` constraint)
- **`find_projects`** is hidden when the session is constrained to a specific project (`projectSlug` constraint)
- **`create_project`** is hidden when the session is constrained to a specific project (`projectSlug` constraint)

This ensures that only relevant tools are available in constrained contexts. When constraints are not set, all tools are available based on your granted skills.

### Environment Variables

You can also use environment variables:

```shell
SENTRY_ACCESS_TOKEN=your-token
# Optional overrides. Leave unset to use the default SaaS host
SENTRY_HOST=sentry.example.com         # Self-hosted Sentry hostname
MCP_SKILLS=inspect,docs,triage         # Limit to specific skills
MCP_SCOPES=org:read,event:read         # Override default scopes (replaces defaults) - DEPRECATED, use MCP_SKILLS
MCP_ADD_SCOPES=event:write             # Add to default scopes (keeps defaults) - DEPRECATED, use MCP_SKILLS

# LLM provider configuration for AI-powered search tools
OPENAI_API_KEY=your-openai-key         # Use OpenAI for AI-powered search tools
OPENAI_MODEL=gpt-5                     # OpenAI model to use (default: "gpt-5")
OPENROUTER_API_KEY=your-openrouter-key # Or use OpenRouter for AI-powered search tools
OPENROUTER_MODEL=openai/gpt-5.6-luna   # OpenRouter model to use (default: "openai/gpt-5.6-luna")
OPENROUTER_REASONING_EFFORT=high       # OpenRouter reasoning effort: "none", "minimal", "low", "medium", "high", "xhigh" ("max" aliases xhigh), or "" to omit (default: "high")
OPENAI_REASONING_EFFORT=low            # Reasoning effort for o1 models: "low", "medium", "high", or "" to disable (default: "low")

# No environment variable exists for the OpenAI base URL override; use --openai-base-url instead.
# This restriction prevents unexpected environment overrides that could silently reroute requests to a
# malicious proxy capable of harvesting the OpenAI API key provided at runtime.
```

If `SENTRY_HOST` is not provided, the CLI automatically targets the Sentry SaaS endpoint. Configure this variable only when you operate a self-hosted Sentry deployment.

**Note:** Command-line flags override environment variables.

### Required Sentry Token Scopes

To utilize the `stdio` transport, create a User Auth Token in Sentry with these scopes:

**Minimum (read-only)**:
- `org:read`, `project:read`, `team:read`, `event:read`

**Additional (for write operations)**:
- `event:write` - Required for `triage` skill
- `project:write`, `team:write` - Required for `project-management` skill

The MCP server will automatically request the appropriate scopes based on your granted skills.

### Migration from Scopes (Deprecated)

> ⚠️ **Deprecated**: The `--scopes` and `--add-scopes` flags are deprecated. Use `--skills` instead.

If you're currently using scopes:

```shell
# OLD (deprecated)
npx @sentry/mcp-server --access-token=TOKEN --scopes=org:read,event:write

# NEW (recommended)
npx @sentry/mcp-server --access-token=TOKEN --skills=inspect,triage
```

The host configuration accepts two distinct formats:

- **`SENTRY_HOST`**: Hostname only (no protocol)
  - Examples: `sentry.example.com`, `sentry.internal.example.com`, `localhost:8000`

**Note**: Only HTTPS connections are supported for security reasons.

By default we also enable Sentry reporting (traces, errors) upstream to our cloud service. You can disable that, or send it to a different Sentry instance by using the `--sentry-dsn` flag:

```shell
# disable sentry reporting
npx @sentry/mcp-server@latest --sentry-dsn=

# use custom sentry instance
npx @sentry/mcp-server@latest --sentry-dsn=https://publicKey@mysentry.example.com/...
```
