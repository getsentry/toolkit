# Cloudflare Release

Cloudflare Workers deployment configuration and release process.

## Architecture Overview

The deployment consists of:
- **Worker**: Stateless HTTP server with OAuth flow and MCP handler
- **KV Storage**: OAuth token storage
- **Static Assets**: React UI for setup instructions

## Wrangler Configuration

### wrangler.jsonc

```jsonc
{
  "name": "sentry-mcp-oauth",
  "main": "./src/server/index.ts",
  "compatibility_date": "2025-03-21",
  "compatibility_flags": [
    "nodejs_compat",
    "nodejs_compat_populate_process_env"
  ],
  "keep_vars": true,

  // Bindings
  "kv_namespaces": [{
    "binding": "OAUTH_KV",
    "id": "your-kv-namespace-id"
  }],

  // SPA configuration
  "site": {
    "bucket": "./dist/client"
  }
}
```

### Environment Variables

Required in production:
```bash
SENTRY_CLIENT_ID=your_oauth_app_id
SENTRY_CLIENT_SECRET=your_oauth_app_secret
COOKIE_SECRET=32_char_random_string
```

Optional overrides for self-hosted deployments:
```bash
# Leave unset to target the SaaS host
SENTRY_HOST=sentry.example.com     # Hostname only (self-hosted only)
```

Configure these overrides only when your Cloudflare deployment connects to a
self-hosted Sentry instance; no additional host variables are required for the
SaaS service.

Development (.dev.vars):
```bash
SENTRY_CLIENT_ID=dev_client_id
SENTRY_CLIENT_SECRET=dev_secret
COOKIE_SECRET=dev-cookie-secret
```

## MCP Handler Setup

The MCP handler uses a stateless architecture with closure-captured context:

```typescript
import { experimental_createMcpHandler as createMcpHandler } from "agents/mcp";
import { buildServer } from "@sentry/mcp-server/server";

const mcpHandler: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Extract auth props from ExecutionContext (set by OAuth provider)
    const oauthCtx = ctx as OAuthExecutionContext;

    // Build complete ServerContext from OAuth props + constraints
    const serverContext: ServerContext = {
      userId: oauthCtx.props.userId,
      clientId: oauthCtx.props.clientId,
      accessToken: oauthCtx.props.accessToken,
      grantedSkills,  // Primary authorization method
      constraints: verification.constraints,
      sentryHost,
      mcpUrl: oauthCtx.props.mcpUrl,
    };

    // Build server with context - context is captured in tool handler closures
    const server = buildServer({ context: serverContext });

    // Run MCP handler - context already available via closures
    return createMcpHandler(server, { route: "/mcp" })(request, env, ctx);
  },
};
```

## OAuth Provider Setup

Configure the OAuth provider with required scopes and MCP token refresh
settings:

```typescript
const oAuthProvider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: sentryMcpHandler,
  defaultHandler: app,
  authorizeEndpoint: "/oauth/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  tokenExchangeCallback: (options) =>
    tokenExchangeCallback(options, env, request, clientFamily),
  scopesSupported: Object.keys(SCOPES),
  refreshTokenTTL: 30 * 24 * 60 * 60,
});
```

`tokenExchangeCallback` does not refresh upstream Sentry OAuth tokens. It
re-issues MCP access tokens while the cached Sentry access token is still
usable, and otherwise requires the client to re-authenticate.

## Deployment Commands

### Local Development

```bash
# Install dependencies
pnpm install

# Start dev server
pnpm dev

# Access at http://localhost:8787
```

### Production Deployment

#### Automated via GitHub Actions

Production deployments run only from the trusted `Deploy to Cloudflare` workflow
after the `Test` workflow succeeds for the current `main` commit:

1. Merge a PR into `main`; GitHub Actions tests that exact commit.
2. The workflow builds once, captures the live production version, and uploads
   the generated Worker bundle and `dist/client` SPA assets without shifting
   traffic. The source `public` directory does not contain the built homepage.
3. It stages that version at 0% while the prior version serves 100%, then tests
   it with a version override through the production route. The version probe
   confirms that the candidate handled the overridden request.
4. It promotes the tested version to 100% and checks both ownership and live
   smoke tests. If a step fails, it restores the captured prior version only
   while the latest Cloudflare deployment is still owned by that run. External
   changes or ambiguous traffic stop recovery.

The `production` GitHub environment allows only `main`. Store
`CLOUDFLARE_API_TOKEN` there with Workers deployment permissions. Configure
`CLOUDFLARE_ACCOUNT_ID` for the account that owns both Workers. Keep credentials
out of command arguments and logs. After a verified deployment, remove any
repository-level copy of `CLOUDFLARE_API_TOKEN`.

See `github-actions.md` for detailed setup instructions.

Manual recovery is available through `Recover Cloudflare Deployment` on
`main`, with the original deployment run ID and attempt. It checks the source
run and contiguous live Cloudflare history before restoring the explicit prior
version. Production traffic changes must use a protected workflow. Do not use bare
`wrangler rollback`: it selects from mutable deployment history and can undo
someone else's deployment. If recovery declines because production changed,
inspect the active version and use a new reviewed workflow run to fix forward.

#### Version Uploads (Gradual Rollouts)

For feature branches, GitHub Actions automatically uploads new versions without deploying:

1. Push to any branch (except main)
2. Tests run automatically
3. If tests pass, version is uploaded to Cloudflare
4. Use Cloudflare dashboard to gradually roll out the version

Manual version upload:
```bash
pnpm cf:versions:upload
```

### Creating Resources

First-time setup:
```bash
# Create KV namespace for OAuth token storage
npx wrangler kv:namespace create OAUTH_KV

# Update wrangler.jsonc with the namespace ID
```

## Multi-Region Considerations

Cloudflare Workers run globally, but consider:
- KV is eventually consistent globally
- Workers are stateless and edge-deployed
- Use regional hints for performance

## Security Configuration

### CORS Settings

```typescript
const ALLOWED_ORIGINS = [
  "https://sentry.io",
  "https://*.sentry.io"
];

// Apply to responses
response.headers.set("Access-Control-Allow-Origin", origin);
response.headers.set("Access-Control-Allow-Credentials", "true");
```

### Cookie Configuration

```typescript
// Secure cookie settings
"HttpOnly; Secure; SameSite=Lax; Max-Age=2592000"
```

## Monitoring

### Sentry Integration

```typescript
// sentry.config.ts
export default {
  dsn: env.VITE_SENTRY_DSN,
  environment: env.VITE_SENTRY_ENVIRONMENT || "development",
  integrations: [
    Sentry.rewriteFramesIntegration({
      root: "/",
    }),
  ],
  transportOptions: {
    sendClientReports: false,
  },
};
```

### Worker Analytics

Monitor via Cloudflare dashboard:
- Request rates
- Error rates
- CPU time and memory usage
- KV operations

## Troubleshooting

### Common Issues

1. **OAuth redirect mismatch**
   - Ensure callback URL matches Sentry app config
   - Check protocol (http vs https)

2. **Context not available in tool handlers**
   - Verify buildServer() is called with context before createMcpHandler()
   - Check ExecutionContext.props contains OAuth data
   - Ensure context is passed correctly during server build

3. **Environment variables missing**
   - Use `wrangler secret put` for production
   - Check `.dev.vars` for local development

## References

- Worker code: `packages/mcp-cloudflare/src/server/`
- Client UI: `packages/mcp-cloudflare/src/client/`
- Wrangler config: `packages/mcp-cloudflare/wrangler.jsonc`
- Cloudflare docs: https://developers.cloudflare.com/workers/
