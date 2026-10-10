# Architecture

System design and package interactions for the Sentry MCP server.

## Overview

Sentry MCP is a Model Context Protocol server that exposes Sentry's functionality to AI assistants. It provides tools that enable LLMs to interact with Sentry's error tracking, performance monitoring, and other features.

## Package Structure

The project is a pnpm monorepo with clear separation of concerns:

```
packages/
├── mcp-core/            # Core MCP implementation (private package)
├── mcp-server/           # stdio transport (published as @sentry/mcp-server)
├── mcp-cloudflare/      # Cloudflare Workers deployment
├── mcp-server-evals/    # Evaluation test suite
├── mcp-server-mocks/    # Shared mock data
└── mcp-test-client/     # Interactive CLI client
```

### packages/mcp-core

The core MCP implementation. This is a **private package** shared between transports.

**Structure:**

```
src/
├── api-client/         # Sentry API client
├── internal/           # Utilities (not exposed)
├── tools/              # Tool implementations
├── toolDefinitions.ts  # Tool schemas and metadata
├── server.ts           # buildServer() function
├── errors.ts           # Custom error types
└── types.ts            # TypeScript definitions
```

**Key responsibilities:**

- Implements MCP protocol using the official SDK
- Provides tools for Sentry operations (issues, projects, etc.)
- Handles authentication and API communication
- Formats responses for LLM consumption

`buildServer()` fixes the tool catalog for each server instance. Both SDK versions
advertise `tools.listChanged: false`: stdio does not mutate its registered catalog,
and hosted requests build independent servers without a notification channel for
catalog changes. Modern `subscriptions/listen` acknowledgments therefore omit
`toolsListChanged`, following the [MCP subscription contract](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions).

**Note:** This package is **not published to npm**. It's a workspace-only package.

### packages/mcp-server

Published stdio transport package (as `@sentry/mcp-server`).

**Structure:**

```
src/
├── cli/                # CLI argument parsing
├── transports/         # stdio transport
└── index.ts            # Main entry point
```

**Key responsibilities:**

- CLI entry point for the MCP server
- stdio transport implementation
- Bundles all mcp-core code at build time
- Published to npm for end users

**Build:** Uses tsdown to bundle mcp-core code, resulting in a self-contained package.

### packages/mcp-cloudflare

A separate web chat application that uses the MCP server.

**Note**: This is NOT part of the MCP server itself - it's a demonstration of how to build a chat interface that consumes MCP.

See "Overview" in [Cloudflare Overview](../cloudflare/overview.md) for details.

### packages/mcp-server-evals

Evaluation tests that verify real Sentry operations.

**Uses:**

- Vercel AI SDK for LLM integration
- Real Sentry API calls with mocked responses
- Factuality scoring for output validation

### packages/mcp-server-mocks

Centralized mock data and MSW handlers.

**Provides:**

- Fixture data for all Sentry entities
- MSW request handlers
- Shared test utilities

### packages/mcp-test-client

Interactive CLI for testing the MCP server with an AI agent.

**Key features:**

- Vercel AI SDK integration with Anthropic
- Interactive and single-prompt modes
- OAuth authentication for remote servers
- Stdio transport for local testing
- Clean terminal output with tool call visualization

## Key Architectural Decisions

### 1. Protocol Implementation

Uses the official MCP SDK (`@modelcontextprotocol/sdk`) to ensure compatibility:

```typescript
const server = new Server({
  name: "sentry-mcp",
  version: "1.0.0"
});

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: TOOL_DEFINITIONS
}));
```

### 2. Transport Layers

The MCP server supports multiple transport mechanisms:

**Stdio Transport** (Primary):

- Direct process communication
- Used by IDEs (Cursor, VS Code) and local tools
- Configured via command-line args
- This is the standard MCP transport

**HTTP Transport** (For web apps):

- Allows web applications to connect to MCP via HTTP streaming
- Used by the example Cloudflare chat app
- Main endpoint: `/mcp`
- Not part of core MCP spec

**SSE Transport** (Deprecated - will be removed):

- Legacy Server-Sent Events transport
- Endpoint: `/sse`
- Does not support organization/project constraints
- New integrations should use HTTP transport via `/mcp` endpoint

### 3. Authentication Strategy

The MCP server uses Sentry access tokens for authentication:

```bash
# Via command line
pnpm start:stdio --access-token=<token> --host=<host>

# Via environment variable
SENTRY_ACCESS_TOKEN=<token> pnpm start:stdio
```

For web applications using MCP (like the Cloudflare example), they handle their own authentication and pass tokens to the MCP server.

### 4. API Client Design

Centralized client with method-specific implementations:

```typescript
class SentryApiService {
  constructor(private config: { host: string; accessToken: string })
  
  // Resource-specific methods
  issues = {
    list: (params) => this.fetch("/issues/", params),
    get: (params) => this.fetch(`/issues/${id}/`)
  }
}
```

### 5. Tool Design Pattern

Each tool follows a consistent structure:

1. **Definition** (toolDefinitions.ts):
   - Schema with Zod
   - LLM-friendly description
   - Parameter documentation

2. **Handler** (tools.ts):
   - Parameter validation
   - API calls via client
   - Response formatting
   - Error handling

3. **Testing**:
   - Unit tests with snapshots
   - Mock API responses
   - Evaluation tests

**Tool Count Constraints:**

- AI agents have a 45 tool limit (Cursor, etc.)
- Sentry MCP must stay under 25 tools (target: ~20)
- Consolidate functionality where possible
- Consider parameter variants over new tools
- Long-tail operations can live in the tool catalog and be reached through
  `search_sentry_tools` and `execute_sentry_tool` instead of being exposed directly in
  `tools/list`

**Tool Catalog and Direct Exposure:**

Tool modules define the operation itself. Ordinary tools are catalog-eligible by
default and can be reached through `search_sentry_tools` and `execute_sentry_tool`.
Ordinary operation modules live as flat files under
`packages/mcp-core/src/tools/catalog/` and are registered in
`packages/mcp-core/src/tools/catalog/index.ts`.
`packages/mcp-core/src/tools/support/` contains helper modules for tools that
need more implementation structure.
`packages/mcp-core/src/tools/catalog-runtime/` contains the shared filtering,
search, schema, and execution helpers. Wrapper/gateway tools such as
`search_sentry_tools`, `execute_sentry_tool` live in
`packages/mcp-core/src/tools/special/`.

`packages/mcp-core/src/tools/surfaces.ts` only centralizes the subsets of
catalog tools that should also be exposed directly through MCP `tools/list`.
The direct surface stays small because long-tail operations can be discovered
with `search_sentry_tools` and invoked with `execute_sentry_tool`.
The same availability filters (skills, constraints, experimental mode, and
required capabilities) apply before either direct registration or catalog
execution.

### 6. Error Handling Philosophy

Two-tier error system:

- **UserInputError**: Invalid parameters, clear user feedback
- **System errors**: Logged to Sentry, generic message to user

### 7. Build System

pnpm workspace orchestration:

- Dependency-aware builds
- Package-scoped task execution
- Shared TypeScript configs
- Centralized linting/formatting

## Data Flow

```
1. LLM makes tool call
   ↓
2. MCP server receives request
   ↓
3. Handler validates parameters
   ↓
4. API client makes Sentry call
   ↓
5. Response formatted for LLM
   ↓
6. MCP sends response back
```

## MCP Concept Mappings

### Tools

Execute actions and retrieve data:

- `find_issues` - Search for issues
- `get_project_details` - Fetch project info
- `create_issue_comment` - Add comments
- `search_docs` - Search Sentry documentation
- `get_doc` - Fetch full documentation pages

## Performance Considerations

- Stateless server design
- No caching between requests
- Streaming responses where applicable
- Parallel API calls when possible

## Two-Tier Agent Architecture

Some tools (the dataset search tools like `search_errors`/`search_traces`, and `search_issues`) implement a two-tier agent pattern:

### Tier 1: Calling Agent (Claude/Cursor)
- Decides when to use search tools
- Provides natural language queries
- Handles errors and retries
- Interprets results for the user

### Tier 2: Embedded Agent (GPT-5)
- Lives inside the MCP tool
- Translates natural language to Sentry query syntax
- Has its own tools for field discovery
- Returns structured query objects

### Data Flow Example

```
1. User: "Show me errors from yesterday"
   ↓
2. Claude: Calls search_errors(query="errors from yesterday")
   ↓
3. MCP Tool Handler: Receives request
   ↓
4. Embedded Agent (GPT-5):
   - Determines dataset: "errors"
   - Calls datasetAttributes tool
   - Translates to: {query: "", fields: [...], timeRange: {statsPeriod: "24h"}}
   ↓
5. MCP Tool: Executes Sentry API call
   ↓
6. Results formatted and returned to Claude
   ↓
7. Claude: Presents results to user
```

### Design Rationale

This pattern is used when:
- Query languages are complex (Sentry's search syntax)
- Available fields vary by context (project-specific attributes)
- Semantic understanding is required ("yesterday" → timeRange)

### Error Handling

- Embedded agent errors are returned as UserInputError
- Calling agent sees the error and can retry
- No internal retry loops - single responsibility
