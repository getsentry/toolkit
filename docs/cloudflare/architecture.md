# Cloudflare Chat Agent Architecture

Technical architecture for the web-based chat interface hosted on Cloudflare Workers.

## Overview

The Cloudflare chat agent provides a web interface for interacting with Sentry through an AI assistant. It's built as a full-stack application using:

- **Frontend**: React with Tailwind CSS
- **Backend**: Cloudflare Workers with Hono framework
- **AI**: OpenAI GPT-4 via Vercel AI SDK
- **MCP Integration**: HTTP transport to core MCP server

## Package Structure

```
packages/mcp-cloudflare/
├── src/
│   ├── client/           # React frontend
│   │   ├── components/   # UI components
│   │   ├── contexts/     # React contexts
│   │   ├── hooks/        # Custom React hooks
│   │   └── utils/        # Client utilities
│   └── server/           # Cloudflare Workers backend
│       ├── lib/          # Server libraries
│       ├── routes/       # API routes
│       ├── types/        # TypeScript types
│       └── utils/        # Server utilities
├── public/               # Static assets
└── wrangler.toml         # Cloudflare configuration
```

## Key Components

### 1. OAuth Authentication

Handles Sentry OAuth flow for user authentication:

```typescript
// server/routes/auth.ts
export default new Hono()
  .get("/login", handleOAuthLogin)
  .get("/callback", handleOAuthCallback)
  .post("/logout", handleLogout);
```

**Features:**

- OAuth 2.0 flow with Sentry
- Token storage in Cloudflare KV
- Automatic token refresh
- Per-organization access control

### 2. Chat Interface

React-based chat UI with real-time streaming:

```typescript
// client/components/chat/chat.tsx
export function Chat() {
  const { messages, handleSubmit } = useChat({
    api: "/api/chat",
    headers: { Authorization: `Bearer ${authToken}` },
  });
}
```

**Features:**

- Message streaming with Vercel AI SDK
- Tool call visualization
- Slash commands (/help, /prompts, /clear)
- Prompt parameter dialogs
- Markdown rendering with syntax highlighting

### 3. MCP Integration

Connects to the core MCP server via HTTP transport:

```typescript
// server/routes/chat.ts
const mcpClient = await experimental_createMCPClient({
  name: "sentry",
  transport: {
    type: "sse",
    url: sseUrl,
    headers: { Authorization: `Bearer ${accessToken}` },
  },
});
```

**Features:**

- Server-sent events (SSE) for MCP communication
- Automatic tool discovery
- Prompt metadata endpoint
- Error handling with fallbacks

### 4. AI Assistant

GPT-4 integration with Sentry-specific system prompt:

```typescript
const result = streamText({
  model: openai("gpt-4o"),
  messages: processedMessages,
  tools: mcpTools,
  system: "You are an AI assistant for testing Sentry MCP...",
});
```

**Features:**

- Streaming responses
- Tool execution
- Prompt template processing
- Context-aware assistance

## Data Flow

1. **User Authentication**:

   ```
   User → OAuth Login → Sentry → OAuth Callback → KV Storage
   ```

2. **Chat Message Flow**:

   ```
   User Input → Chat API → Process Prompts → AI Model → Stream Response
                         ↓
                    MCP Server ← Tool Calls
   ```

3. **MCP Communication**:
   ```
   Chat Server → SSE Transport → MCP Server → Sentry API
   ```

## Deployment Architecture

### Cloudflare Resources

- **Workers**: Serverless compute for API routes
- **Pages**: Static asset hosting for React app
- **KV Namespace**: OAuth token storage
- **AI Binding**: Access to Cloudflare AI models (AutoRAG for docs search)
- **R2**: File storage (future)

### Environment Variables

Required for deployment:

```toml
[vars]
COOKIE_SECRET = "..."      # For session encryption
OPENAI_API_KEY = "..."     # For GPT-4 access
SENTRY_CLIENT_ID = "..."   # OAuth app ID
SENTRY_CLIENT_SECRET = "..." # OAuth app secret
```

### API Routes

- `/api/auth/*` - Authentication endpoints
- `/api/chat` - Main chat endpoint
- `/api/metadata` - MCP metadata endpoint
- `/sse` - Server-sent events for MCP

### Sentry API Response Cache

The MCP handler can cache Sentry API GET responses through the shared
response cache in `@sentry/toolkit-core/api-client/response-cache`. It is
behind `MCP_RESPONSE_CACHE`:

| Value               | Behavior                                                                   |
| ------------------- | -------------------------------------------------------------------------- |
| unset, `off`, other | No caching. The default in every deployed environment.                     |
| `memory`            | Caches every tier in the isolate's memory.                                 |
| `tiered`            | Memory only for now; the R2 tier for allowlisted detail endpoints follows. |

How it works (`src/server/lib/response-cache.ts`):

- **Identity.** Each entry is keyed by the SHA-256 of the MCP grant's user ID
  and grant ID, both from the wrapper bearer token (`userId:grantId:secret`).
  A grant never reads another grant's entries, even for the same user and
  URL, and the key stays the same when the wrapper token refreshes. Requests
  without a grant ID, including Sentry-Bearer direct tokens, are not cached.
- **Storage.** One memory store per isolate, shared by every request it
  serves: a 24 MiB byte budget counted over compressed bodies, a 1 MiB
  per-entry cap, and least recently used eviction.
- **Freshness.** Server cache headers win; otherwise the URL's tier applies
  (60 s volatile, 5 minutes stable, never for autofix polling). A successful
  write invalidates the same grant's entries under the written resource.
- **Writes** run in `ctx.waitUntil()`, so they never delay a response.
- **Bodies** are compressed with zstd level 3 when `node:zlib` has it, and
  brotli quality 4 otherwise. Local workerd (miniflare `5.20261019.1-beta`)
  has zstd; a deployed Worker is not confirmed yet. The
  `app.response_cache.write` metric records the encoding each write used.

Turning it on in production is a separate decision: revoked access or deleted
data can still be served from the cache until the entry expires (up to 5
minutes for stable entries). Leave `MCP_RESPONSE_CACHE` unset in production
until that window has privacy and security sign-off. Setting it back to `off`
restores uncached behavior. Metrics are listed in
[Monitoring](../operations/monitoring.md#response-cache-metrics).

## Security Considerations

1. **Authentication**: OAuth tokens stored encrypted in KV
2. **Authorization**: Per-organization access control
3. **Rate Limiting**: Cloudflare rate limiter integration
4. **Request Limits**: `/mcp` POST bodies are capped at 1 MiB (`MAX_MCP_REQUEST_BODY_BYTES`), and tool-call arguments at 10,000 array elements plus object keys (`MAX_TOOL_INPUT_ELEMENTS`). Both limits live in `@sentry/toolkit-core/mcp-limits`, shared with Docs MCP
5. **CORS**: Restricted to same-origin requests
6. **CSP**: Content Security Policy headers

## Performance Optimizations

1. **Edge Computing**: Runs at Cloudflare edge locations
2. **Caching**: Metadata endpoint with cache headers
3. **Streaming**: Server-sent events for real-time updates
4. **Bundle Splitting**: Optimized React build

## Monitoring

- Sentry integration for error tracking
- Cloudflare Analytics for usage metrics
- Custom telemetry for MCP operations

## Related Documentation

- See "OAuth Architecture" in [OAuth Architecture](oauth-architecture.md)
- See "Chat Interface" in this document
- See "Deployment" in [Cloudflare Release](../releases/cloudflare.md)
- See "Architecture" in [Architecture Overview](../architecture/overview.md)
