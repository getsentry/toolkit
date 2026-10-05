# Stdio Authentication

How the stdio transport authenticates with Sentry, including the device code flow, token caching, and the relationship between the bundled client ID and the Cloudflare OAuth app.

## Authentication Methods

The stdio transport supports two authentication methods, in order of precedence:

1. **Explicit token** — `--access-token` flag or `SENTRY_ACCESS_TOKEN` env var. Works for all Sentry hosts. This is the only method available for self-hosted instances.
   For self-hosted deployments that only expose plain HTTP, pair `--access-token` with `--host` and `--insecure-http`.

2. **Device code flow** — OAuth Device Authorization Grant (RFC 8628). Only available for sentry.io (including regional subdomains like `us.sentry.io`). Requires an interactive terminal (TTY). Falls back to cached tokens in non-interactive contexts.

## Device Code Flow

When no token is provided and the host is sentry.io, the CLI initiates the device code flow:

```
CLI                          Sentry (sentry.io)
 │                                │
 │  POST /oauth/device/code/      │
 │  (client_id, scope)            │
 │──────────────────────────────>│
 │                                │
 │  device_code, user_code,       │
 │  verification_uri_complete     │
 │<──────────────────────────────│
 │                                │
 │  Display code to user          │
 │  Open browser to verify URL    │
 │                                │
 │  POST /oauth/token/            │  (poll every N seconds)
 │  (device_code, client_id)      │
 │──────────────────────────────>│
 │                                │
 │  authorization_pending         │  (user hasn't authorized yet)
 │<──────────────────────────────│
 │                                │
 │  ... poll again ...            │
 │                                │
 │  access_token, refresh_token   │  (user authorized)
 │<──────────────────────────────│
 │                                │
 │  Cache token to disk           │
 │  Start MCP server              │
```

### OAuth Endpoints

All OAuth requests target `sentry.io` directly (via `OAUTH_HOST` constant), regardless of regional subdomain configuration. The device code and token endpoints live on the main domain only.

### Scopes

The device code flow requests the same scopes as the Cloudflare OAuth app:

```
org:read project:write team:write event:write alerts:write
```

These are defined once in `packages/mcp-core/src/scopes.ts` and shared by both transports.

## Client ID

A bundled `DEFAULT_SENTRY_CLIENT_ID` ships in `packages/mcp-server/src/auth/constants.ts`. This is a public OAuth application registered on sentry.io specifically for the stdio device code flow. It has no client secret — device code flow doesn't use one.

The Cloudflare deployment uses a separate OAuth application (configured via `SENTRY_CLIENT_ID` + `SENTRY_CLIENT_SECRET` env vars) because it uses the authorization code grant which requires a secret.

Both transports use the `SENTRY_CLIENT_ID` env var name for overriding, but they're separate deployments with separate values:

| Transport | Default client ID | Grant type | Client secret |
|-----------|------------------|------------|---------------|
| stdio | Bundled in `auth/constants.ts` | Device code (RFC 8628) | None (public client) |
| Cloudflare | `SENTRY_CLIENT_ID` env var | Authorization code | `SENTRY_CLIENT_SECRET` env var |

## Token Cache

Tokens are cached at `~/.sentry/mcp.json` to avoid re-authentication on every server start.

### File Format

```json
{
  "sentry.io:client-id-here": {
    "access_token": "...",
    "refresh_token": "...",
    "expires_at": "2026-04-25T...",
    "sentry_host": "sentry.io",
    "client_id": "...",
    "user_email": "user@example.com",
    "scope": "org:read project:write team:write event:write alerts:write"
  }
}
```

Cache entries are keyed by `{host}:{clientId}` so different hosts or client IDs don't collide.

### Security

- File permissions: `0o600` (owner read/write only)
- Directory permissions: `0o700`
- Writes are atomic (temp file + rename)
- Tokens are treated as expired 5 minutes before actual expiry

### Override

Set `SENTRY_MCP_AUTH_CACHE` to override the cache file path (primarily for testing).

## Non-Interactive Contexts

When stderr is not a TTY (CI, piped stdio, MCP inspector), the device code flow is not started — it would hang waiting for a human. Instead:

1. If a cached token exists, it's used silently.
2. If no cached token exists, the process exits with an error directing the user to run `sentry-mcp auth login` interactively first.

## Auth CLI Commands

The CLI exposes auth management as subcommands:

```bash
sentry-mcp auth login          # Force device code flow (always re-authenticates)
sentry-mcp auth logout         # Clear cached token
sentry-mcp auth status         # Show current auth state
```

These commands support `--host` and `--url` flags with the same precedence as the main server: `--url` beats `--host`, CLI beats env vars.

## Key Files

| File | Purpose |
|------|---------|
| `packages/mcp-server/src/auth/constants.ts` | Bundled client ID, OAuth endpoints, scopes |
| `packages/mcp-server/src/auth/device-code-flow.ts` | RFC 8628 implementation (request, poll, browser open) |
| `packages/mcp-server/src/auth/token-cache.ts` | Persistent token storage at `~/.sentry/mcp.json` |
| `packages/mcp-server/src/auth/resolve-token.ts` | Orchestration: cache check → TTY check → device code flow |
| `packages/mcp-server/src/auth/types.ts` | Zod schemas for API responses, `CachedToken` type |
| `packages/mcp-server/src/cli/commands/auth.ts` | `auth login/logout/status` subcommands |
| `packages/mcp-core/src/scopes.ts` | Shared OAuth scope definitions |

## Token Refresh

Not implemented. Sentry access tokens last 30 days. When a cached token expires, it's cleared and a new device code flow is triggered. This matches the Cloudflare transport's approach (see `packages/mcp-cloudflare/src/server/oauth/helpers.ts`).
