# sentry-mcp

Sentry's MCP service is primarily designed for human-in-the-loop coding agents. Our tool selection and priorities are focused on developer workflows and debugging use cases, rather than providing a general-purpose MCP server for all Sentry functionality.

This remote MCP server acts as middleware to the upstream Sentry API, optimized for coding assistants like Cursor, Claude Code, and similar development tools. It's based on [Cloudflare's work towards remote MCPs](https://blog.cloudflare.com/remote-model-context-protocol-servers-mcp/).

## Getting Started

You'll find everything you need to know by visiting the deployed service in production:

<https://mcp.sentry.dev>

If you're looking to contribute, learn how it works, or to run this for self-hosted Sentry, continue below.

### Claude Code Plugin

Install as a Claude Code plugin for automatic subagent delegation:

```shell
claude plugin marketplace add getsentry/sentry-mcp
claude plugin install sentry-mcp@sentry-mcp
```

This provides a `sentry-mcp` subagent that Claude automatically delegates to when you ask about Sentry errors, issues, traces, or performance.

For forward-looking tool variants and features:

```shell
claude plugin install sentry-mcp@sentry-mcp-experimental
```

### Stdio vs Remote

While this repository is focused on acting as an MCP service, we also support a `stdio` transport. This is still a work in progress, but is the easiest way to adapt run the MCP against a self-hosted Sentry install.

**Note:** The AI-powered search tools (`search_errors`, `search_traces`, `search_logs`, `search_issues`, etc.) require an LLM provider (OpenAI, Azure OpenAI, Anthropic, or OpenRouter). These tools use natural language processing to translate queries into Sentry's query syntax. Without a configured provider, these specific tools will be unavailable, but all other tools will function normally.

To utilize the `stdio` transport, you'll need to create an User Auth Token in Sentry with the necessary scopes. As of writing this is:

```
org:read
project:read
project:write
team:read
team:write
event:write
```

Launch the transport:

```shell
npx @sentry/mcp-server@latest --access-token=sentry-user-token
```

Need to connect to a self-hosted deployment? Add <code>--host</code> (hostname
only, e.g. <code>--host=sentry.example.com</code>) when you run the command.
For isolated internal deployments that only expose plain HTTP, also add
<code>--insecure-http</code>.

Seer is not part of self-hosted Sentry, so the `seer` skill is left out of the
default skill set whenever `--host` points at a non-`sentry.io` host. If your
self-hosted deployment does run Seer, opt back in explicitly:

```shell
npx @sentry/mcp-server@latest --access-token=TOKEN --host=sentry.example.com --skills=inspect,seer
```

You can also disable any other skill to prevent unsupported tools from being
exposed:

```shell
npx @sentry/mcp-server@latest --access-token=TOKEN --host=sentry.example.com --disable-skills=project-management
```

For self-hosted instances without TLS:

```shell
npx @sentry/mcp-server@latest --access-token=TOKEN --host=sentry.internal:9000 --insecure-http
```

#### Remote with an Explicit Sentry Token

Remote clients that support custom HTTP headers can pass an upstream Sentry API
token directly to the Cloudflare transport:

```json
{
  "mcpServers": {
    "sentry": {
      "url": "https://mcp.sentry.dev/mcp",
      "headers": {
        "Authorization": "Sentry-Bearer ${SENTRY_ACCESS_TOKEN}"
      }
    }
  }
}
```

`Sentry-Bearer` is intentionally separate from `Bearer`: `Bearer` is reserved
for MCP OAuth access tokens. With `Sentry-Bearer`, the worker does not store,
validate, exchange, or refresh the upstream token. It forwards the token through
the same Sentry API calls used by OAuth-backed sessions, and the client or
upstream provider remains responsible for token lifetime and refresh.

Direct remote auth defaults to all active MCP skills. You can narrow the exposed
tools with `?skills=inspect,triage` or `?disable-skills=seer`.

#### Environment Variables

```shell
SENTRY_ACCESS_TOKEN=         # Required: Your Sentry auth token

# LLM Provider Configuration (required for AI-powered search tools)
EMBEDDED_AGENT_PROVIDER=     # Required when multiple provider keys are set: 'openai', 'azure-openai', 'anthropic', or 'openrouter'
OPENAI_API_KEY=              # Required if using OpenAI
ANTHROPIC_API_KEY=           # Required if using Anthropic
OPENROUTER_API_KEY=          # Required if using OpenRouter
OPENROUTER_MODEL=            # Optional OpenRouter model, defaults to 'openai/gpt-5.6-luna'
OPENROUTER_REASONING_EFFORT= # Optional OpenRouter reasoning effort, defaults to 'high'

# Optional overrides
SENTRY_HOST=                 # For self-hosted deployments (drops 'seer' from the default skills)
MCP_SKILLS=                  # Grant specific skills (comma-separated, e.g. 'inspect,seer')
MCP_DISABLE_SKILLS=          # Disable specific skills (comma-separated, e.g. 'project-management')
```

**Important:** Always set `EMBEDDED_AGENT_PROVIDER` to explicitly specify your LLM provider. Auto-detection based on API keys alone is deprecated and will be removed in a future release. See [docs/operations/embedded-agents.md](docs/operations/embedded-agents.md) for detailed configuration options.

#### Example MCP Configuration

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

If you leave the host variable unset, the CLI automatically targets the Sentry
SaaS service. Only set the override when you operate self-hosted Sentry.

Setting `SENTRY_HOST` to a self-hosted host also drops the `seer` skill from
the default set, since Seer is not available on self-hosted Sentry. For a
self-hosted deployment that does run Seer, opt in with `MCP_SKILLS`:

```json
{
  "mcpServers": {
    "sentry": {
      "command": "npx",
      "args": ["@sentry/mcp-server"],
      "env": {
        "SENTRY_ACCESS_TOKEN": "your-token",
        "SENTRY_HOST": "sentry.example.com",
        "MCP_SKILLS": "inspect,seer"
      }
    }
  }
}
```

### MCP Inspector

MCP includes an [Inspector](https://modelcontextprotocol.io/docs/tools/inspector), to easily test the service:

```shell
pnpm inspector
```

Enter the MCP server URL (<http://localhost:5173>) and hit connect. This should trigger the authentication flow for you.

Note: If you have issues with your OAuth flow when accessing the inspector on `127.0.0.1`, try using `localhost` instead by visiting `http://localhost:6274`.

## Local Development

To contribute changes, you'll need to set up your local environment:

1. **Set up environment and agent skills:**

   ```shell
   make setup-env  # Creates .env files and installs shared agent skills
   ```

   This also runs `npx @sentry/dotagents install` to install shared skills from [getsentry/skills](https://github.com/getsentry/skills) into `.agents/skills/` (symlinked into `.claude/skills` and `.cursor/skills`). If you need to update skills later, run it directly:

   ```shell
   npx @sentry/dotagents install
   ```

2. **Create an OAuth App in Sentry** (Settings => API => [Applications](https://sentry.io/settings/account/api/applications/)):

   - Homepage URL: `http://localhost:5173`
   - Authorized Redirect URIs: `http://localhost:5173/oauth/callback`
   - Note your Client ID and generate a Client secret

3. **Configure your credentials:**

   - Edit `.env` in the root directory and add either `OPENAI_API_KEY` or `OPENROUTER_API_KEY`
   - Edit `packages/mcp-cloudflare/.env` and add:
     - `SENTRY_CLIENT_ID=your_development_sentry_client_id`
     - `SENTRY_CLIENT_SECRET=your_development_sentry_client_secret`
     - `COOKIE_SECRET=my-super-secret-cookie`

4. **Start the development server:**

   ```shell
   pnpm dev
   ```

### Verify

Run the server locally to make it available at `http://localhost:5173`

```shell
pnpm dev
```

To test the local server, enter `http://localhost:5173/mcp` into Inspector and hit connect. Once you follow the prompts, you'll be able to "List Tools".

### Tests

There are three test suites included: unit tests, evaluations, and manual testing.

**Unit tests** can be run using:

```shell
pnpm test
```

**Evaluations** require a `.env` file in the project root with some config:

```shell
# .env (in project root)
OPENAI_API_KEY=      # Use OpenAI-backed AI-powered tools
OPENROUTER_API_KEY=  # Or use OpenRouter-backed AI-powered tools
```

Note: The root `.env` file provides defaults for all packages. Individual packages can have their own `.env` files to override these defaults during development.

Once that's done you can run them using:

```shell
pnpm eval
```

**Manual testing** (preferred for testing MCP changes):

```shell
# Test with local dev server (default: http://localhost:5173)
pnpm -w run cli "who am I?"

# Test against production
pnpm -w run cli --mcp-host=https://mcp.sentry.dev "query"

# Test with local stdio mode (requires SENTRY_ACCESS_TOKEN)
pnpm -w run cli --access-token=TOKEN "query"
```

Note: The CLI defaults to `http://localhost:5173`. Override with `--mcp-host` or set `MCP_URL` environment variable.

**Comprehensive testing playbooks:**
- **Stdio testing:** See `docs/testing/stdio.md` for complete guide on building, running, and testing the stdio implementation (IDEs, MCP Inspector)
- **Remote testing:** See `docs/testing/remote.md` for complete guide on testing the remote server (OAuth, web UI, CLI client)

## Development Notes

### Automated Code Review

This repository uses automated code review tools (like Cursor BugBot) to help identify potential issues in pull requests. These tools provide helpful feedback and suggestions, but **we do not recommend making these checks required** as the accuracy is still evolving and can produce false positives.

The automated reviews should be treated as:

- ✅ **Helpful suggestions** to consider during code review
- ✅ **Starting points** for discussion and improvement
- ❌ **Not blocking requirements** for merging PRs
- ❌ **Not replacements** for human code review

When addressing automated feedback, focus on the underlying concerns rather than strictly following every suggestion.

### Contributor Documentation

Looking to contribute or explore the full documentation map? See `CLAUDE.md` (also available as `AGENTS.md`) for contributor workflows and the complete docs index. The `docs/` folder contains the per-topic guides and tool-integrated `.md` files.
