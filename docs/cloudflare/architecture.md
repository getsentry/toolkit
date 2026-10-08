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
    headers: { Authorization: `Bearer ${authToken}` }
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
    headers: { Authorization: `Bearer ${accessToken}` }
  }
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
  system: "You are an AI assistant for testing Sentry MCP..."
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

## Security Considerations

1. **Authentication**: OAuth tokens stored encrypted in KV
2. **Authorization**: Per-organization access control
3. **Rate Limiting**: Cloudflare rate limiter integration
4. **CORS**: Restricted to same-origin requests
5. **CSP**: Content Security Policy headers

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
