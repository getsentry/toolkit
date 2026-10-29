# Stdio Authentication

How the local stdio MCP server (`sentry mcp`) authenticates with Sentry.

`sentry mcp` has no auth flow of its own. It reuses the Sentry CLI's
credentials, so `sentry auth login`, `sentry auth logout`, and
`sentry auth status` manage the MCP server's credentials too.

## Credential Sources

In order of precedence:

1. **Static token** — `--access-token` flag, then `SENTRY_ACCESS_TOKEN`. The
   token is used as given for the life of the server and is never
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

## Migration From `@sentry/mcp-server`

The standalone package's device code flow, bundled client ID, and token cache
(`~/.sentry/mcp.json`, `SENTRY_MCP_AUTH_CACHE`) are gone. `sentry mcp` does not
read the old cache. Users who relied on it run `sentry auth login` once, or keep
passing `--access-token` / `SENTRY_ACCESS_TOKEN`.

`@sentry/mcp-server` now bundles this same server and shares the CLI's
credential store. `sentry-mcp auth login` runs the CLI's device flow; use
`npx -y sentry auth logout|status` for the rest.

## Key Files

| File                                        | Purpose                                                        |
| ------------------------------------------- | -------------------------------------------------------------- |
| `packages/cli/src/lib/mcp.ts`               | Credential resolution, static-token host check, refresh-on-401 |
| `packages/cli/src/lib/mcp/server.ts`        | Flag/env parsing, telemetry, and stdio startup                 |
| `packages/cli/src/lib/db/auth.ts`           | CLI token storage and `refreshToken()`                         |
| `packages/cli/src/lib/token-host.ts`        | Host-scoping checks                                            |
| `packages/mcp-core/src/transports/stdio.ts` | stdio transport and per-request auth context                   |
