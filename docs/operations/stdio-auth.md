# Stdio Authentication

How the two stdio MCP entry points authenticate with Sentry: the local server
(`sentry mcp`) and the `@sentry/mcp-server` proxy to the hosted MCP.

## `sentry mcp`

`sentry mcp` has no auth flow of its own. It reuses the Sentry CLI's
credentials, so `sentry auth login`, `sentry auth logout`, and
`sentry auth status` manage the MCP server's credentials too.

### Credential Sources

In order of precedence:

1. **Static token** — `--access-token` flag, then `SENTRY_ACCESS_TOKEN`. Kept
   for MCP client configurations written for the original `@sentry/mcp-server`
   local server. The token is used as given for the life of the server and is never
   refreshed. Org auth tokens (`sntrys_`) record the Sentry URL they were
   issued for; `sentry mcp` refuses to send one to a different host
   (`HostScopeError`). `SENTRY_ACCESS_TOKEN` only affects `sentry mcp`; other
   CLI commands ignore it.
2. **CLI credentials** — the stored `sentry auth login` session, or
   `SENTRY_AUTH_TOKEN` / `SENTRY_TOKEN` (see the CLI's
   `SENTRY_FORCE_ENV_TOKEN` rules). These go through the CLI's
   `refreshToken()`, which enforces the same host scoping as every CLI command.
   When a tool call gets a 401 from Sentry, the server forces a refresh and
   later calls use the new token, so a long-running server survives token
   rotation without a restart.

When no credential is available and stdin is a TTY, `sentry mcp` starts the
CLI's interactive login before serving. MCP clients launch the server over
pipes, so in that case it exits with an error that tells the user to run
`sentry auth login`.

For self-hosted Sentry, set the host with `--host`/`--url` (or the CLI's
`SENTRY_HOST`/`SENTRY_URL`). Pair `--host` with `--insecure-http` for instances
that only expose plain HTTP.

## `@sentry/mcp-server` Proxy

The `sentry-mcp` bin has no auth flow and stores nothing. It needs a static
token from `--access-token` or `SENTRY_ACCESS_TOKEN` and sends it to the
hosted MCP as `Authorization: Sentry-Bearer <token>` on every request. The
hosted MCP routes that scheme before OAuth and passes the token to Sentry as
is: no validation, refresh, or storage. A rejected token comes back as the
JSON-RPC error of the failed request, and the proxy logs it to stderr.

Without a token the proxy exits 1 and tells the user to create one or run
`npx -y sentry mcp`, which can use `sentry auth login`. `sentry-mcp auth ...`
exits 1 with the same pointer.

The hosted MCP serves sentry.io only (regional and organization subdomains go
through sentry.io). A `--host`, `--url`, `SENTRY_HOST`, or `SENTRY_URL` for
any other host, or `--insecure-http`, exits 1 with an error that points to
`npx -y sentry mcp`.

### Migration From the Old Local Server

The old package's device code flow, bundled client ID, and token cache
(`~/.sentry/mcp.json`, `SENTRY_MCP_AUTH_CACHE`) are gone. Neither entry point
reads the old cache. Users who relied on it run `sentry auth login` once and
switch to `sentry mcp`, or pass `--access-token` / `SENTRY_ACCESS_TOKEN`.

## Key Files

| File                                        | Purpose                                                        |
| ------------------------------------------- | -------------------------------------------------------------- |
| `packages/cli/src/lib/mcp.ts`               | Credential resolution, static-token host check, refresh-on-401 |
| `packages/cli/src/lib/mcp/server.ts`        | Flag/env parsing, telemetry, and stdio startup                 |
| `packages/cli/src/lib/db/auth.ts`           | CLI token storage and `refreshToken()`                         |
| `packages/cli/src/lib/token-host.ts`        | Host-scoping checks                                            |
| `packages/mcp-core/src/transports/stdio.ts` | stdio transport and per-request auth context                   |
| `packages/mcp-server/lib/config.js`         | Proxy flags, token, and host checks                            |
| `packages/mcp-server/lib/proxy.js`          | Proxy stdio to Streamable HTTP forwarding                      |
