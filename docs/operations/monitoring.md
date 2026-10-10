# Monitoring

Observability patterns using Sentry across the MCP server.

## Architecture

Different Sentry SDKs for different environments:
- **Core server**: `@sentry/core` (platform-agnostic)
- **Cloudflare Workers**: `@sentry/cloudflare`
- **Node.js stdio**: `@sentry/node`
- **React client**: `@sentry/react`

## Core Server Instrumentation

### Error Logging

See `logIssue` in `packages/mcp-server/src/telem/logging.ts` (documented in [Logging Reference](logging.md)) for the canonical way to create an Issue and structured log entry.

For event schema failures, see [Event Validation Diagnostics](../../TELEMETRY.md#event-validation-diagnostics)
for the `contextType` diagnostic and its privacy constraints.

### Tracing Pattern

```typescript
export async function createTracedToolHandler<T extends ToolName>(
  name: T,
  handler: ToolHandlerFunction<T>
): Promise<[T, ToolHandlerFunction<T>]> {
  return [
    name,
    async (context: ServerContext, params: ToolParams<T>) => {
      const attributes = {
        "gen_ai.tool.name": name,
        ...extractMcpParameters(params),
      };

      return await withActiveSpan(
        `tools/call ${name}`,
        attributes,
        async () => handler(context, params)
      );
    },
  ];
}
```

### Request Context

Call `setTargetTagsAndAttributes()` from `src/telem/scope.ts` after
resolving the organization, including from URLs. It sets the Sentry
resources that the tool call targets as scope attributes for streamed spans,
logs, and metrics, and as tags for errors. It requires `organizationSlug`.
All other `Target` fields are optional, such as `projectSlug`, `teamSlug`,
`issueId`, or `traceId`, so a tool can pass its `params` directly when they
use these names. A numeric `projectSlugOrId` becomes `project.id`, any other
value `project.slug`. To send a new kind of resource, add a field to
`Target` and its key to `targetKeys`.

For other searchable values that are not a target, such as `client.id` or
`doc.path`, put the keys in one object and pass it to both `setTags` and
`setAttributes` from `@sentry/core`. SDK v11 no longer copies scope tags
onto spans, so do not call `setTag` alone.

For values set at startup, put the same keys in both `initialScope.tags` and
`initialScope.attributes` of `Sentry.init`.

### Span Management

```typescript
async function withActiveSpan<T>(
  name: string,
  attributes: Record<string, any>,
  fn: () => Promise<T>
): Promise<T> {
  const activeSpan = getActiveSpan();
  const span = activeSpan?.startSpan(name) ?? startInactiveSpan({ name });
  
  span.setAttributes(attributes);
  
  try {
    return await fn();
  } catch (error) {
    span.setStatus({ code: 2, message: error.message });
    throw error;
  } finally {
    span.end();
  }
}
```

## Cloudflare Workers Setup

### Configuration

```typescript
// sentry.config.ts
export default function getSentryConfig(env: Env, context: ExecutionContext) {
  return {
    dsn: env.VITE_SENTRY_DSN,
    environment: env.VITE_SENTRY_ENVIRONMENT || "development",
    context,
    integrations: [
      Sentry.rewriteFramesIntegration({ root: "/" }),
    ],
    beforeSend(event) {
      // Redact sensitive data
      if (event.request?.headers?.authorization) {
        event.request.headers.authorization = "[REDACTED]";
      }
      return event;
    },
  };
}
```

### Worker Instrumentation

```typescript
export default Sentry.withSentry(
  (env) => getSentryConfig(env),
  {
    async fetch(request, env, ctx): Promise<Response> {
      // Attach OAuth provider to request
      request.OAUTH_PROVIDER = oAuthProvider.configure(/* ... */);
      return app.fetch(request, env, ctx);
    },
  }
);
```

## Node.js Stdio Setup

```typescript
// Init at startup
import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || "production",
  integrations: [
    Sentry.nodeProfilingIntegration(),
  ],
  tracesSampleRate: 0.1,
  profilesSampleRate: 0.1,
});

// Handle uncaught errors
process.on("uncaughtException", (error) => {
  Sentry.captureException(error);
  process.exit(1);
});
```

## OpenTelemetry Semantic Conventions

Sentry follows OpenTelemetry semantic conventions for consistent observability.

### MCP Attributes (Model Context Protocol)
Based on the current [OpenTelemetry MCP conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/mcp/), the standard MCP semantic attributes are:

- `mcp.method.name` - The name of the request or notification method (e.g., "notifications/cancelled", "initialize", "tools/call")
- `mcp.protocol.version` - The MCP protocol version (e.g., "2025-06-18")
- `mcp.resource.uri` - The value of the resource URI (e.g., "postgres://database/customers/schema", "file:///home/user/documents/report.pdf")
- `mcp.session.id` - Identifies MCP session (e.g., "191c4850af6c49e08843a3f6c80e5046")

Current MCP spans also use related OpenTelemetry attributes outside the `mcp.*` namespace:

- `gen_ai.prompt.name` - The prompt or prompt template name
- `gen_ai.tool.name` - The tool name
- `jsonrpc.request.id` - The JSON-RPC request ID
- `rpc.response.status_code` - The JSON-RPC response status or error code
- `network.transport` - Transport protocol (`pipe` for stdio, `tcp` or `quic` for HTTP)
- `gen_ai.tool.call.arguments.<key>` - Per-key effective tool arguments after constraints
- `gen_ai.tool.call.result` - Tool result payload when explicitly recorded for low-risk structured outputs
- `gen_ai.tool.call.result.count` - Sentry MCP extension for result counts, including zero-result tool calls

### Application-Owned Attributes
These are Sentry MCP application attributes that are not part of the MCP semantic convention:

- `app.resource.type` - Resolved Sentry resource type for `get_sentry_resource`
- `app.transport` - The product transport label (values: "http", "sse", "stdio")
- `app.client.family` - Low-cardinality MCP client bucket derived from User-Agent or registered client name
- `app.constraint.organization_slug` - Session organization constraint
- `app.constraint.project_slug` - Session project constraint
- `app.server.mode.experimental` - Whether experimental tools are enabled for this MCP request or stdio session
- `app.consent.skill.<skill>.granted` - Per-skill boolean attributes for skills granted to the MCP request. Skill ids are normalized with `-` replaced by `_`
- `app.upstream.host` - Upstream Sentry host configured for the server
- `app.url.full` - MCP URL configured for stdio

### User Agent Tracking

Following [OpenTelemetry semantic conventions for user agent](https://opentelemetry.io/docs/specs/semconv/attributes-registry/user-agent/):

- `user_agent.original` - The original User-Agent header value from the client

**Cloudflare Transport**: Captured from the initial SSE/WebSocket connection request headers and cached for the session

### Network Attributes
Based on [OpenTelemetry network conventions](https://github.com/open-telemetry/semantic-conventions/blob/main/docs/registry/attributes/network.md):

- `network.transport` - Transport protocol used ("pipe" for stdio, "tcp" for SSE)

### GenAI Attributes (Generative AI)
Based on [OpenTelemetry GenAI conventions](https://github.com/open-telemetry/semantic-conventions/blob/main/docs/registry/attributes/gen-ai.md):

- `gen_ai.provider.name` - The AI provider name (e.g., "anthropic")
- `gen_ai.request.model` - Name of the GenAI model
- `gen_ai.request.max_tokens` - Maximum tokens to generate
- `gen_ai.operation.name` - Type of operation (e.g., "chat")
- `gen_ai.usage.input_tokens` - Number of tokens in input
- `gen_ai.usage.output_tokens` - Number of tokens in response

### Span Naming Pattern
Follows the format: `{mcp.method.name} {target}` per OpenTelemetry MCP semantic conventions

- Tools: `tools/call {tool_name}` (e.g., `tools/call find_issues`)
- Prompts: `prompts/get {prompt_name}` (e.g., `prompts/get analyze-code`)
- Resources: `resources/read` by default. Do not include resource URIs in span names unless explicitly opted in because they can be high-cardinality.
- Connect/auth spans may use local names such as `mcp.connect/stdio` and `mcp.auth/oauth`; these are span names, not semantic attribute namespaces.

**Note**: Span names are flexible and can be adjusted based on your needs. However, attribute names MUST follow the OpenTelemetry semantic conventions exactly as specified above.

### Example Attributes
```typescript
// MCP Tool Execution
{
  "gen_ai.tool.name": "find_issues",
  "mcp.session.id": "191c4850af6c49e08843a3f6c80e5046"
}

// GenAI Agent
{
  "gen_ai.provider.name": "anthropic",
  "gen_ai.request.model": "claude-3-5-sonnet-20241022",
  "gen_ai.operation.name": "chat",
  "gen_ai.usage.input_tokens": 150,
  "gen_ai.usage.output_tokens": 2048
}

// Connection
{
  "network.transport": "pipe",  // "pipe" for stdio, "tcp" for SSE
  "mcp.session.id": "191c4850af6c49e08843a3f6c80e5046",
  "app.transport": "stdio",  // Custom attribute: "stdio" or "sse"
  "service.version": "1.2.3"  // Version of the MCP server/client
}

// MCP Client
{
  "mcp.session.id": "191c4850af6c49e08843a3f6c80e5046",
  "network.transport": "pipe",  // "pipe" for stdio, "tcp" for SSE
  "app.transport": "stdio",  // Custom attribute: "stdio" or "sse"
  "gen_ai.provider.name": "anthropic",
  "gen_ai.request.model": "claude-3-5-sonnet-20241022",
  "gen_ai.operation.name": "chat",
  "service.version": "1.2.3"  // Version of the MCP client
}
```

## Error Classification

### Skip Logging For:
- `UserInputError` - Expected user errors
- 4xx API responses (except 429)
- Validation errors

### Always Log:
- 5xx errors
- Network failures
- Unexpected exceptions
- Rate limit errors (429)

## Performance Monitoring

### Metrics Product For HTTP Responses

For Cloudflare HTTP traffic we send custom Metrics product counters through the
JavaScript SDK metrics API:

- `app.server.response` - Count of tracked HTTP responses

Shared low-cardinality attributes:

- `http.request.method` - HTTP method
- `http.route` - Normalized route template
- `http.response.status_code` - Final HTTP status code
- `app.response.status_class` - Status family such as `2xx` or `4xx`
- `app.route.group` - Coarse route family: `mcp`, `oauth`, `chat`, or `search`

Additional attributes on MCP response metrics:

- `app.client.family` - Bucketed MCP client User-Agent
- `app.server.mode.experimental` - `true` when the MCP URL includes `?experimental=1`

Additional attributes on direct OAuth client endpoints:

- `app.client.family` - Bucketed client User-Agent on `/oauth/token` and
  `/oauth/register`

Optional local rate-limit attributes:

- `app.response.reason` - `local_rate_limit`
- `app.rate_limit.scope` - `ip` or `user`

Optional OAuth error attributes:

- `app.access.method` - Access path: `mcp_grant` or `sentry_access`
- `app.access.error.code` - Bounded OAuth error code such as `invalid_access`,
  `invalid_grant`, or `other`
- `app.access.error.reason` - Low-cardinality description bucket such as
  `invalid_access` or `grant_not_found`
- `app.access.request.header_shape` - 401 Authorization header shape such as `missing`,
  `wrapper`, or `malformed`
- `app.access.grant.id_hash` - Non-secret grant fingerprint on grant lifecycle
  logs
- `app.access.grant.age_bucket` - Bounded MCP grant age at refresh/revocation
- `app.access.upstream.expires_in_bucket` - Bounded remaining time before the
  original upstream Sentry expiry at refresh/revocation

Interpretation:

- Use `sum(app.server.response)` grouped by `http.route` and
  `http.response.status_code` for response rates
- Use `sum(app.server.response)` filtered to the MCP route and grouped by
  `app.server.mode.experimental` for mode adoption
- Use `sum(app.server.response)` filtered by
  `app.response.reason=local_rate_limit` to measure when we rate-limited the
  customer
- Use `sum(app.server.response)` filtered by `app.access.error.code=invalid_access`
  and grouped by `app.client.family`, `app.access.error.reason`, and
  `app.access.request.header_shape` for OAuth failure attribution
- Upstream/provider 429s increment `app.server.response` with status `429`, but
  do not include `app.response.reason`

### Traces Configuration
```typescript
{
  tracesSampleRate: 0.1,      // 10% in production
  profilesSampleRate: 0.1,    // 10% of traces
}
```

## Environment Variables

### Required for Monitoring
```bash
# Cloudflare (build-time)
VITE_SENTRY_DSN=https://...@sentry.io/...
VITE_SENTRY_ENVIRONMENT=production

# Node.js (runtime)
SENTRY_DSN=https://...@sentry.io/...
NODE_ENV=production
```

## Best Practices

1. **Context is King**: Always include relevant context
2. **Redact Secrets**: Never log tokens or sensitive data
3. **Sample Wisely**: Use appropriate sampling rates
4. **Tag Everything**: Use consistent tags for filtering
5. **Skip Expected Errors**: Don't pollute with user errors

## References

- Core logging: `packages/mcp-server/src/logging.ts`
- Worker config: `packages/mcp-cloudflare/src/server/sentry.config.ts`
- Tracing helpers: `packages/mcp-server/src/tracing.ts`
- Sentry docs: https://docs.sentry.io/
