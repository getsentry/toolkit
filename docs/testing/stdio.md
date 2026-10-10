# Testing the Stdio Implementation

Complete playbook for building, running, and testing the stdio MCP server.

## Overview

The stdio transport runs the MCP server as a subprocess that communicates via stdin/stdout pipes. This is the standard way IDEs and local tools integrate with MCP servers.

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
- Sentry access token with appropriate scopes

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

## Build Process

### 1. Initial Setup

```bash
# Clone and install dependencies
cd sentry-mcp
pnpm install

# Set up environment (optional for stdio)
make setup-env
```

### 2. Build the Package

```bash
# Build all packages (includes mcp-server)
pnpm -w run build

# Or build just mcp-server
cd packages/mcp-server
pnpm build
```

The build process:
1. Generates tool definitions (`pnpm run generate-definitions`)
2. Compiles TypeScript to JavaScript
3. Creates both ESM and CJS outputs
4. Generates type declarations
5. Makes the CLI executable

**Output location:** `packages/mcp-server/dist/`

### 3. Verify Build

```bash
# Check the built executable exists
ls -la packages/mcp-server/dist/index.js

# Test the CLI help
node packages/mcp-server/dist/index.js --help
```

## Running Stdio Locally

### Option 1: Using pnpm start (Development)

Best for active development with TypeScript sources:

```bash
cd packages/mcp-server
pnpm start --access-token=YOUR_TOKEN
```

This uses `tsx` to run TypeScript directly without building.

### Option 2: Using the Built Package (Production-like)

Test the actual build output:

```bash
# From repo root
node packages/mcp-server/dist/index.js --access-token=YOUR_TOKEN

# Or use the workspace command
pnpm -w run mcp-server --access-token=YOUR_TOKEN
```

### Option 3: Using npx (End-user Experience)

Test the published package experience:

```bash
# Latest from npm
npx @sentry/mcp-server@latest --access-token=YOUR_TOKEN

# Test local build (after packing)
cd packages/mcp-server
pnpm pack
npx ./sentry-mcp-server-*.tgz --access-token=YOUR_TOKEN
```

## Testing with MCP Inspector

The MCP Inspector is the best tool for interactive testing of the stdio transport.

### 1. Start the Inspector

```bash
# From repo root
pnpm inspector
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
    "--dir",
    "/absolute/path/to/sentry-mcp/packages/mcp-server",
    "start",
    "--access-token=YOUR_TOKEN"
  ]
}
```

**For built package:**
```json
{
  "command": "node",
  "args": [
    "/absolute/path/to/sentry-mcp/packages/mcp-server/dist/index.js",
    "--access-token=YOUR_TOKEN"
  ]
}
```

**For self-hosted Sentry:**
```json
{
  "command": "npx",
  "args": [
    "@sentry/mcp-server@latest",
    "--access-token=YOUR_TOKEN",
    "--host=sentry.example.com"
  ]
}
```

**For self-hosted Sentry on plain HTTP:**
```json
{
  "command": "npx",
  "args": [
    "@sentry/mcp-server@latest",
    "--access-token=YOUR_TOKEN",
    "--host=sentry.internal:9000",
    "--insecure-http"
  ]
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
      "args": [
        "@sentry/mcp-server@latest",
        "--access-token=YOUR_TOKEN"
      ]
    }
  }
}
```

**2. Use Environment Variables (Recommended):**

Create `.cursor/.env`:
```bash
SENTRY_ACCESS_TOKEN=your-token-here
```

Update config:
```json
{
  "mcpServers": {
    "sentry": {
      "command": "npx",
      "args": ["@sentry/mcp-server@latest"],
      "env": {
        "SENTRY_ACCESS_TOKEN": "${SENTRY_ACCESS_TOKEN}"
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
      "args": [
        "@sentry/mcp-server@latest",
        "--access-token=YOUR_TOKEN"
      ]
    }
  }
}
```

**3. Test:**
- Reload window (Cmd/Ctrl + Shift + P → "Reload Window")
- Use MCP-aware AI features to access Sentry data

## Configuration Options

### Command-Line Flags

```bash
# Basic usage
--access-token=TOKEN              # Sentry access token (required)

# Host configuration
--host=sentry.example.com         # Self-hosted Sentry (hostname only)

# Skills management
--skills=inspect,docs,triage      # Limit to specific skills (default: all available)

# AI features (optional)
--openai-base-url=URL             # Custom OpenAI endpoint

# Sentry reporting
--sentry-dsn=DSN                  # Custom Sentry DSN for telemetry
--sentry-dsn=                     # Disable telemetry


# Help
--help                            # Show all options
--version                         # Show version
```

### Environment Variables

```bash
# Authentication
SENTRY_ACCESS_TOKEN=your-token

# Host (self-hosted only)
SENTRY_HOST=sentry.example.com

# Skills
MCP_SKILLS=inspect,docs,triage           # Limit to specific skills

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
cd packages/mcp-server
pnpm start --access-token=TOKEN &
sleep 2
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | pnpm start --access-token=TOKEN
```

### 2. Test Against Self-Hosted Sentry

```bash
# Development server
pnpm start \
  --access-token=TOKEN \
  --host=sentry.local.dev

# Built package
node dist/index.js \
  --access-token=TOKEN \
  --host=sentry.local.dev
```

### 3. Test Skills

```bash
# Test with all skills (default)
pnpm start --access-token=TOKEN

# Test with specific skills only
pnpm start --access-token=TOKEN --skills=inspect,docs

# Test read-only skills
pnpm start --access-token=TOKEN --skills=inspect,seer,docs
```

### 4. Test AI-Powered Tools

```bash
# With OpenAI API key
OPENAI_API_KEY=your-key pnpm start --access-token=TOKEN

# Test the dataset search tools and search_issues work
# In MCP Inspector:
# - Call search_errors(query="errors in production")
# - Call search_issues(query="unresolved crashes")
```


### "Command not found: npx @sentry/mcp-server"

**Cause:** Package not published or not in npm registry.

**Solution:**
```bash
# Use local build instead
cd packages/mcp-server
pnpm build
node dist/index.js --access-token=TOKEN
```

### "Missing required parameter: access-token"

**Cause:** No authentication provided.

**Solution:**
```bash
# Option 1: CLI flag
pnpm start --access-token=YOUR_TOKEN

# Option 2: Environment variable
export SENTRY_ACCESS_TOKEN=YOUR_TOKEN
pnpm start
```

### "AI-powered search tools unavailable"

**Cause:** Missing `OPENAI_API_KEY`.

**Solution:**
```bash
# Set the API key
export OPENAI_API_KEY=your-openai-key
pnpm start --access-token=TOKEN

# Or disable warning by acknowledging it
# (All other tools will work normally)
```

### "Cannot connect to Sentry API"

**Causes:**
1. Invalid access token
2. Wrong host configuration
3. Network issues

**Solution:**
```bash
# Test token manually
curl -H "Authorization: Bearer YOUR_TOKEN" \
  https://sentry.io/api/0/

# For self-hosted, verify host
curl -H "Authorization: Bearer YOUR_TOKEN" \
  https://your-sentry-host.com/api/0/

# Check logs for detailed error
pnpm start --access-token=TOKEN 2>&1 | tee debug.log
```

### "MCP Inspector can't connect to stdio server"

**Causes:**
1. Incorrect command path
2. Missing dependencies
3. Process exits immediately

**Solution:**
```bash
# Test command manually first
pnpm start --access-token=TOKEN

# If it works, use absolute paths in Inspector
which node  # Get absolute path to node
pwd         # Get absolute path to project

# Use absolute paths in Inspector config
{
  "command": "/usr/local/bin/node",
  "args": ["/absolute/path/to/sentry-mcp/packages/mcp-server/dist/index.js"]
}
```

### "Permission denied" errors

**Cause:** Built executable not marked as executable.

**Solution:**
```bash
chmod +x packages/mcp-server/dist/index.js
```

### "Module not found" errors after build

**Cause:** Missing dependencies in built output.

**Solution:**
```bash
# Clean and rebuild
cd packages/mcp-server
rm -rf dist
pnpm build

# Verify dependencies are bundled
ls -lh dist/
```

## Quality Checks

Before committing changes that affect stdio:

```bash
# 1. Build successfully
pnpm -w run build

# 2. Type check
pnpm -w run tsc

# 3. Lint
pnpm -w run lint

# 4. Unit tests pass
cd packages/mcp-server
pnpm test

# 5. Smoke test stdio works
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | \
  node dist/index.js --access-token=TOKEN
```

## Comparing with Remote

To verify stdio behaves the same as remote:

**Test with both transports:**
```bash
# 1. Test stdio locally
pnpm start --access-token=TOKEN
# Use MCP Inspector to test tools

# 2. Test remote
pnpm -w run cli --mcp-host=https://mcp.sentry.dev "who am I"

# 3. Compare results
# Both should return same data, same tool list
```

**Key differences to expect:**
- **Authentication:** Stdio uses access tokens, remote uses OAuth
- **Constraints:** Remote supports URL-based org/project constraints
- **Tools:** Both should have same tool count and functionality
- **Performance:** Stdio has no network overhead (faster)

## Advanced Testing

### Testing Custom Builds

```bash
# Pack the local build
cd packages/mcp-server
pnpm pack

# Install globally for testing
npm install -g ./sentry-mcp-server-*.tgz

# Test as end-user would
sentry-mcp --access-token=TOKEN
```

### Testing with Different Node Versions

```bash
# Using nvm
nvm install 20
nvm use 20
pnpm start --access-token=TOKEN

nvm install 22
nvm use 22
pnpm start --access-token=TOKEN
```

### Performance Testing

```bash
# Time tool execution
time node dist/index.js --access-token=TOKEN <<EOF
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"execute_sentry_tool","arguments":{"name":"whoami","arguments":{}}}}
EOF

# Memory usage
/usr/bin/time -v node dist/index.js --access-token=TOKEN
```

## References

- stdio transport: `packages/mcp-server/src/transports/stdio.ts`
- CLI entry point: `packages/mcp-server/src/index.ts`
- Package README: `packages/mcp-server/README.md`
- MCP Inspector: https://modelcontextprotocol.io/docs/tools/inspector
