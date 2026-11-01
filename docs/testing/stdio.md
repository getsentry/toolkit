# Testing the Stdio Implementation

Complete playbook for building, running, and testing the stdio MCP server.

## Overview

The stdio transport runs the MCP server as a subprocess that communicates via stdin/stdout pipes. This is the standard way IDEs and local tools integrate with MCP servers. The stdio server is implemented in the Sentry CLI (`packages/cli`) on top of `@sentry/mcp-core`. It is published as `@sentry/mcp-server` and is also available as `sentry mcp`.

**When to use stdio:**

- Testing with IDEs (Cursor, VSCode with MCP extension)
- Self-hosted Sentry deployments
- Local development without OAuth
- Direct API token authentication

**When to use remote instead:**

- Testing OAuth flows
- Testing constraint-based access control
- Testing the web chat interface
- Production-like environment testing

## Prerequisites

- Node.js 22.13+
- pnpm installed
- A Sentry login (`pnpm --filter sentry run cli auth login`) or a Sentry access
  token with appropriate scopes

### Required Scopes

For full functionality, create a Sentry User Auth Token with:

- `org:read` - List organizations
- `project:read` - Access project data
- `project:write` - Create/update projects
- `team:read` - Access team data
- `team:write` - Create teams
- `event:read` - Access events and issues
- `event:write` - Update issues, add comments

For read-only testing, use just: `org:read`, `project:read`, `team:read`, `event:read`

## Running Stdio Locally

### 1. Setup

```bash
pnpm install
pnpm -w run build   # builds mcp-core, which `sentry mcp` imports
```

### 2. Run From Source

```bash
# From the repo root. Uses your CLI login when no token is passed.
pnpm --silent --dir packages/cli run cli mcp --help
pnpm --silent --dir packages/cli run cli mcp
SENTRY_AUTH_TOKEN=YOUR_TOKEN pnpm --silent --dir packages/cli run cli mcp
```

`--silent` keeps pnpm's banner off stdout, which carries JSON-RPC frames.

### 3. Run the Built Package

Source runs skip the bundling step, so check the bundle that ships as
`@sentry/mcp-server` before a release:

```bash
pnpm --filter @sentry/mcp-server run bundle
node packages/mcp-server/dist/sentry-mcp.cjs mcp --help
SENTRY_AUTH_TOKEN=YOUR_TOKEN node packages/mcp-server/dist/sentry-mcp.cjs

# Or drive it with the test client
pnpm -w run cli --transport stdio --stdio-bundle --list-tools
```

### 4. Run the Published Package

```bash
npx @sentry/mcp-server@latest
SENTRY_AUTH_TOKEN=YOUR_TOKEN npx @sentry/mcp-server@latest
```

To test a local `@sentry/mcp-server` bundle, build it with
`pnpm --filter @sentry/mcp-server run bundle`, then run
`node packages/mcp-server/dist/sentry-mcp.cjs`.

## Testing with MCP Inspector

The MCP Inspector is the best tool for interactive testing of the stdio transport.

### 1. Start the Inspector

```bash
# From repo root; launches `sentry mcp` from source
pnpm inspector:stdio
```

This opens the MCP Inspector at `http://localhost:6274`

### 2. Connect to Stdio Server

**In the Inspector UI:**

1. Click "Add Server"
2. Select "Stdio" transport type
3. Configure the command:

**For development (TypeScript):**

```json
{
  "command": "pnpm",
  "args": [
    "--silent",
    "--dir",
    "/absolute/path/to/toolkit/packages/cli",
    "run",
    "cli",
    "mcp"
  ],
  "env": { "SENTRY_AUTH_TOKEN": "YOUR_TOKEN" }
}
```

**For self-hosted Sentry:**

```json
{
  "command": "npx",
  "args": ["@sentry/mcp-server@latest"],
  "env": {
    "SENTRY_AUTH_TOKEN": "YOUR_TOKEN",
    "SENTRY_HOST": "sentry.example.com"
  }
}
```

**For self-hosted Sentry on plain HTTP:**

```json
{
  "command": "npx",
  "args": ["@sentry/mcp-server@latest"],
  "env": {
    "SENTRY_AUTH_TOKEN": "YOUR_TOKEN",
    "SENTRY_URL": "http://sentry.internal:9000"
  }
}
```

4. Click "Connect"
5. Click "List Tools" to verify connection

### 3. Test Tools Interactively

**Basic workflow:**

1. **List Tools** - Verify expected tools appear
2. **Call a tool** - Start with `execute_sentry_tool` using `name="whoami"` and `arguments={}`
3. **Test with parameters** - Try `find_organizations()`
4. **Test complex operations** - Try `search_errors(query="errors in the last hour")`

**Example test sequence:**

```
1. execute_sentry_tool(name="whoami", arguments={})
2. find_organizations()
3. find_projects(organizationSlug="your-org")
4. search_errors(
     organizationSlug="your-org",
     query="errors from yesterday"
   )
```

## Testing with CLI Client (Recommended for Quick Tests)

The `mcp-test-client` package provides a CLI-based way to test the stdio transport without needing a browser.

### Transport Selection

The CLI client supports explicit transport selection:

- **Auto**: `--transport auto` (default) uses stdio when an access token is present, otherwise HTTP
- **Stdio**: `--transport stdio`
- **Remote HTTP**: `--transport http`

### Basic Usage

**Test stdio transport (local):**

```bash
# Single query
pnpm -w run cli --transport stdio --access-token=YOUR_TOKEN "who am I?"

# Interactive mode
pnpm -w run cli --transport stdio --access-token=YOUR_TOKEN
> who am I?
> find my organizations
> exit

# Auth/tool-discovery only (no OPENAI_API_KEY required)
pnpm -w run cli --transport stdio --list-tools
```

**Verify stdio is being used:**
Look for this in the output:

```
● Connected to MCP server (stdio)
  ⎿  tools available
```

### Example Test Session

```bash
# Test 1: Verify connection and tool count
$ pnpm -w run cli --access-token=YOUR_TOKEN "list all available tools"

● Connected to MCP server (stdio)
  ⎿  Tools available

● Here are the available tools:
  1. execute_sentry_tool
  2. find_organizations
  3. find_projects
  [...]

# Test 2: Test a specific tool
$ pnpm -w run cli --access-token=YOUR_TOKEN "who am I?"

● Connected to MCP server (stdio)
  ⎿  Tools available

● execute_sentry_tool(name="whoami", arguments={})
  ⎿  You are authenticated as: user@example.com
```

### Testing with Fake Token

For testing the stdio mechanics without real API calls:

```bash
# This will test:
# - Stdio transport initialization ✅
# - Tool loading ✅
# - Tool execution ✅
# - API error handling ✅ (expected 400 error)

pnpm -w run cli --transport stdio --access-token=test-fake-token-12345 "who am I?"
```

**Expected output:**

```
● Connected to MCP server (stdio)
  ⎿  Tools available

● execute_sentry_tool(name="whoami", arguments={})
  ⎿  **Input Error**
      API error (400): Bad Request
```

### Comparing Stdio vs Remote

```bash
# Stdio
pnpm -w run cli --transport stdio --access-token=YOUR_TOKEN "query"
# Output: "Connected to MCP server (stdio)"

# Remote HTTP
pnpm -w run cli --transport http --mcp-host=https://mcp.sentry.dev "query"
# Output: "Connected to MCP server (remote)"
```

## Testing with IDEs

### Cursor IDE

**1. Configure in Cursor Settings:**

Create or edit `.cursor/config.json`:

```json
{
  "mcpServers": {
    "sentry": {
      "command": "npx",
      "args": ["@sentry/mcp-server@latest"]
    }
  }
}
```

This uses your CLI login (`npx @sentry/mcp-server@latest auth login`).

**2. Or Use a Token:**

Create `.cursor/.env`:

```bash
SENTRY_AUTH_TOKEN=your-token-here
```

Update config:

```json
{
  "mcpServers": {
    "sentry": {
      "command": "npx",
      "args": ["@sentry/mcp-server@latest"],
      "env": {
        "SENTRY_AUTH_TOKEN": "${SENTRY_AUTH_TOKEN}"
      }
    }
  }
}
```

**3. Test in Cursor:**

- Restart Cursor
- Open command palette (Cmd/Ctrl + Shift + P)
- Search for "MCP" to verify server is connected
- Ask Cursor: "What Sentry projects do I have access to?"

### VSCode with MCP Extension

**1. Install MCP Extension:**

- Search for "Model Context Protocol" in VSCode extensions
- Install the official MCP extension

**2. Configure in VSCode Settings:**

Add to `.vscode/settings.json`:

```json
{
  "mcp.servers": {
    "sentry": {
      "command": "npx",
      "args": ["@sentry/mcp-server@latest"],
      "env": {
        "SENTRY_AUTH_TOKEN": "YOUR_TOKEN"
      }
    }
  }
}
```

**3. Test:**

- Reload window (Cmd/Ctrl + Shift + P → "Reload Window")
- Use MCP-aware AI features to access Sentry data

## Configuration Options

Run `pnpm --silent --dir packages/cli run cli mcp --help` for the full list.

### Command-Line Flags

```bash
# Authentication: use SENTRY_AUTH_TOKEN (below) or a CLI login
--access-token=TOKEN              # Deprecated alias for SENTRY_AUTH_TOKEN

# Host configuration
--host=sentry.example.com         # Self-hosted Sentry (hostname only)
--url=https://sentry.example.com  # Self-hosted Sentry (full URL)
--insecure-http                   # Allow http:// for --host

# Constraints (the CLI's --org/--project; --organization-slug and
# --project-slug still work but are deprecated)
--org=my-org                      # Limit every call to this organization
--project=my-project              # Limit calls to this project

# Skills management
--skills=inspect,docs,triage      # Limit to specific skills (default: all available)
--disable-skills=seer             # Remove skills from the default set

# AI features (optional)
--agent-provider=openai           # openai, azure-openai, or anthropic
--openai-base-url=URL             # Custom OpenAI endpoint

# Sentry reporting
--sentry-dsn=DSN                  # Custom Sentry DSN for telemetry
--sentry-dsn=                     # Disable telemetry

# Help
--help                            # Show all options
--version, -v                     # Show version (-v alone; elsewhere it is --verbose)
```

### Environment Variables

```bash
# Authentication (optional with a CLI login)
SENTRY_AUTH_TOKEN=your-token             # Used over any CLI login
SENTRY_ACCESS_TOKEN=your-token           # Deprecated, same as --access-token

# Host (self-hosted only; also scopes SENTRY_AUTH_TOKEN to it)
SENTRY_HOST=sentry.example.com

# Skills
MCP_SKILLS=inspect,docs,triage           # Limit to specific skills
MCP_DISABLE_SKILLS=seer

# AI features
OPENAI_API_KEY=your-key                  # For AI-powered search tools like search_errors/search_traces/search_issues

# Sentry reporting
SENTRY_DSN=your-dsn
```

**Priority:** Command-line flags override environment variables.

## Common Testing Workflows

### 1. Test After Code Changes

```bash
# Full rebuild and test cycle
pnpm -w run build && pnpm -w run test

# Quick smoke test
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | \
  pnpm --silent --dir packages/cli run cli mcp
```

### 2. Test Against Self-Hosted Sentry

```bash
SENTRY_AUTH_TOKEN=TOKEN SENTRY_HOST=sentry.local.dev \
  pnpm --silent --dir packages/cli run cli mcp
```

### 3. Test Skills

```bash
# Test with specific skills only
pnpm --silent --dir packages/cli run cli mcp --skills=inspect,docs

# Test read-only skills
pnpm --silent --dir packages/cli run cli mcp --skills=inspect,seer,docs
```

### 4. Test AI-Powered Tools

```bash
OPENAI_API_KEY=your-key pnpm --silent --dir packages/cli run cli mcp

# In MCP Inspector:
# - Call search_errors(query="errors in production")
# - Call search_issues(query="unresolved crashes")
```

## Troubleshooting

### "Not authenticated"

**Cause:** No CLI login and no `SENTRY_AUTH_TOKEN`.

**Solution:** Run `npx @sentry/mcp-server@latest auth login` (from source:
`pnpm --silent --dir packages/cli run cli auth login`), or set
`SENTRY_AUTH_TOKEN` in the client's `env`. MCP clients do not give the server a
TTY, so log in from a terminal first.

### "AI-powered search tools unavailable"

**Cause:** Missing `OPENAI_API_KEY`. All other tools work normally.

### "Cannot connect to Sentry API"

**Causes:**

1. Invalid access token
2. Wrong host configuration
3. Network issues

```bash
# Test token manually
curl -H "Authorization: Bearer YOUR_TOKEN" https://sentry.io/api/0/

# Check stderr for detailed errors
pnpm --silent --dir packages/cli run cli mcp 2>debug.log
```

### "MCP Inspector can't connect to stdio server"

Run the command manually first. If it works, use absolute paths in the
Inspector config, and keep `--silent` so pnpm prints nothing on stdout.

## Quality Checks

Before committing changes that affect stdio:

```bash
pnpm -w run build
pnpm -w run tsc
pnpm -w run lint
pnpm --dir packages/cli exec vitest run test/lib/mcp test/lib/mcp-start.test.ts
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | \
  pnpm --silent --dir packages/cli run cli mcp
```

## Comparing with Remote

```bash
# 1. Test stdio locally
pnpm -w run cli --transport stdio "who am I"

# 2. Test remote
pnpm -w run cli --mcp-host=https://mcp.sentry.dev "who am I"
```

**Key differences to expect:**

- **Authentication:** Stdio uses CLI credentials or a static token, remote uses OAuth
- **Constraints:** Remote supports URL-based org/project constraints
- **Tools:** Both should have same tool count and functionality

## References

- Command entry: `packages/cli/src/lib/mcp.ts`
- Server host: `packages/cli/src/lib/mcp/server.ts`
- stdio transport: `packages/mcp-core/src/transports/stdio.ts`
- Authentication: [stdio authentication](../operations/stdio-auth.md)
- MCP Inspector: https://modelcontextprotocol.io/docs/tools/inspector
