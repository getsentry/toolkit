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
- **R2**: The response cache's tier for allowlisted detail endpoints
  (`MCP_RESPONSE_CACHE_BUCKET`, see
  [Sentry API Response Cache](#sentry-api-response-cache))

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

| Value               | Behavior                                                                     |
| ------------------- | ---------------------------------------------------------------------------- |
| unset, `off`, other | No caching. The default in every deployed environment.                       |
| `memory`            | Caches every tier in the isolate's memory.                                   |
| `tiered`            | `memory`, plus R2 for allowlisted detail endpoints (memory only without R2). |

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

#### R2 tier

`tiered` shares a few detail responses across isolates through the
`MCP_RESPONSE_CACHE_BUCKET` R2 binding (`src/server/lib/r2-cache-store.ts`):

- **Allowlist.** Only organization event details
  (`/api/0/organizations/{org}/events/{project}:{event_id}/`) without
  `averageColumn`, and project trace-item details
  (`/api/0/projects/{org}/{project}/trace-items/{id}/`) without `debug`.
  Every other URL stays in memory.
- **Server opt-in.** An allowlisted response is written to R2 only when it
  carries `Cache-Control: private` with a positive `max-age` (and no
  `no-store` or `no-cache`). Until Sentry sends that header
  (getsentry/sentry#128828), R2 stores nothing.
- **Expiry.** Each object records an expiry, the lesser of `max-age` and 5
  minutes, and reads treat a later object as a miss. An R2 hit is copied
  into memory for the time it has left.
- **Keys.** Objects are keyed `<identity>/<HMAC cache key>`, with the
  identity hash above, and a read also checks the identity stored in the
  entry. Authorization values the policy keeps for `Vary` are stored as
  SHA-256 hashes, never as tokens.
- **Writes** run in `ctx.waitUntil()`. Mutation invalidation only touches
  memory, so a write under the same path, such as deleting the project, does
  not clear R2. The 5-minute expiry bounds how long a deleted item can still
  be served.
- **Garbage collection.** A 1-day bucket lifecycle rule deletes old objects.
  It only frees space; reads enforce the expiry.

The buckets are `sentry-mcp-response-cache` (production) and
`sentry-mcp-canary-response-cache` (canary). Deploys run with
`--experimental-auto-create=false`, so each bucket must exist before a
config that binds it deploys:

```bash
pnpm exec wrangler r2 bucket create sentry-mcp-response-cache
pnpm exec wrangler r2 bucket lifecycle add sentry-mcp-response-cache \
  expire-1d --expire-days 1 --force
pnpm exec wrangler r2 bucket create sentry-mcp-canary-response-cache
pnpm exec wrangler r2 bucket lifecycle add sentry-mcp-canary-response-cache \
  expire-1d --expire-days 1 --force
```

The binding is inert while `MCP_RESPONSE_CACHE` is not `tiered`.

Turning it on in production is a separate decision: revoked access or deleted
data can still be served from the cache until the entry expires (up to 5
minutes for stable entries, including from R2). Leave `MCP_RESPONSE_CACHE` unset in production
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
