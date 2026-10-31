# Stdio Authentication

How the stdio MCP server (`@sentry/mcp-server`) authenticates with Sentry.

Sign in once with `npx -y @sentry/mcp-server auth login`. The package runs
the Sentry CLI's own `auth` commands and stores the session in the CLI's
credential store, so the package and the CLI (which runs the same server as
`sentry mcp`) share one login.

## Credential Sources

In order of precedence:

1. **Static token** — `--access-token` flag, then `SENTRY_ACCESS_TOKEN`. The
   token is used as given for the life of the server and is never
   refreshed. Org auth tokens (`sntrys_`) record the Sentry URL they were
   issued for; the server refuses to send one to a different host
   (`HostScopeError`). `SENTRY_ACCESS_TOKEN` only affects the MCP server; other
   CLI commands ignore it.
2. **Shared login** — the stored account from `auth login`, or
   `SENTRY_AUTH_TOKEN` / `SENTRY_TOKEN` (see the CLI's
   `SENTRY_FORCE_ENV_TOKEN` rules). These go through the CLI's
   `refreshToken()`, which enforces the same host scoping as every CLI command.
   When a tool call gets a 401 from Sentry, the server forces a refresh and
   later calls use the new token, so a long-running server survives token
   rotation without a restart.

When no credential is available and stdin is a TTY, the server starts the
interactive login before serving. MCP clients launch the server over pipes,
so in that case it exits with an error that names the login command for the
program that is running: `sentry auth login`, `sentry-mcp auth login`, or
`npx -y @sentry/mcp-server auth login` under npx
(`packages/cli/src/lib/app-identity.ts`).

For self-hosted Sentry, set the host with `--host`/`--url` or
`SENTRY_HOST`/`SENTRY_URL`. Only the environment variables also pick the stored
account for that server (see [Accounts](#accounts)). Pair `--host` with `--insecure-http` for instances
that only expose plain HTTP.

A repo-local `.sentryclirc` URL is not a trust source. Unless `--host`/`--url`
is passed, a non-SaaS `[defaults] url` must match a server you are logged in
to, the same check every CLI command applies. Otherwise the server refuses to
start (`HostScopeError`) instead of sending any token, including a static one,
to that host. An org auth token (`sntrys_`) is the exception: it names the
server it was issued for, so it is served when that server matches the target
and refused when it does not.

## Accounts

The credential store can hold several accounts, but each server process uses
one: the account resolved at startup. With `SENTRY_HOST`/`SENTRY_URL` set, that
is a stored account on that server; otherwise it is the active account
(`sentry auth switch`). Refreshes after a 401 stay on that account, and tool
calls never pick a different one, even when another process switches or adds
accounts. If that account is removed or another user logs in over it, the
refresh fails and tool calls keep failing until the server restarts. To use
two accounts at once, configure two
MCP servers, for example one per host via `SENTRY_HOST`, or one with a static
`SENTRY_ACCESS_TOKEN`.

## Upgrading From Older `@sentry/mcp-server` Versions

Older releases had their own device code flow, bundled client ID, and token
cache (`~/.sentry/mcp.json`, `SENTRY_MCP_AUTH_CACHE`). Current releases do not
read that cache. Run `npx -y @sentry/mcp-server auth login` once, or keep
passing `--access-token` / `SENTRY_ACCESS_TOKEN`. `auth status`, `auth list`,
`auth switch`, and `auth logout` work in the package as in the CLI.

## Key Files

| File                                        | Purpose                                                        |
| ------------------------------------------- | -------------------------------------------------------------- |
| `packages/cli/src/lib/mcp.ts`               | Credential resolution, static-token host check, refresh-on-401 |
| `packages/cli/src/commands/mcp.ts`          | `mcp` command flags and help                                   |
| `packages/cli/src/lib/mcp/server.ts`        | Agent providers, telemetry, and stdio startup                  |
| `packages/cli/src/lib/db/auth.ts`           | CLI token storage and `refreshToken()`                         |
| `packages/cli/src/lib/token-host.ts`        | Host-scoping checks                                            |
| `packages/mcp-core/src/transports/stdio.ts` | stdio transport and per-request auth context                   |
