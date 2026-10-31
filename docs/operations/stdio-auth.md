# Stdio Authentication

How the stdio MCP server (`@sentry/mcp-server`) authenticates with Sentry.

Sign in once with `npx -y @sentry/mcp-server auth login`. The package runs
the Sentry CLI's own `auth` commands and stores the session in the CLI's
credential store, so the package and the CLI (which runs the same server as
`sentry mcp`) share one login.

## Credential Sources

The server uses the CLI's credential resolution, so the rules match every
other `sentry` command:

1. **Stored login** — the account from `auth login`. It wins by default
   because it can be refreshed.
2. **`SENTRY_AUTH_TOKEN`** (or the legacy `SENTRY_TOKEN`) — used when there is
   no stored login. Set `SENTRY_FORCE_ENV_TOKEN=1` to use it even when a stored
   login exists.

Both go through the CLI's `refreshToken()`, which enforces the same host
scoping as every CLI command. When a tool call gets a 401 from Sentry, the
server forces a refresh and later calls use the new token, so a long-running
server survives token rotation without a restart. An env token is never
refreshed; the forced refresh re-reads it.

To run the server with a token instead of a login, configure the MCP client
with environment variables:

```json
{
  "command": "npx",
  "args": ["-y", "@sentry/mcp-server@latest"],
  "env": {
    "SENTRY_AUTH_TOKEN": "sntryu_...",
    "SENTRY_FORCE_ENV_TOKEN": "1"
  }
}
```

Org auth tokens (`sntrys_`) record the Sentry URL they were issued for; the
server refuses to send one to a different host (`HostScopeError`).

### Deprecated: `--access-token` and `SENTRY_ACCESS_TOKEN`

Older `@sentry/mcp-server` releases took a static token from `--access-token`
or `SENTRY_ACCESS_TOKEN`. Both still work, as an alias: the server runs as if
`SENTRY_AUTH_TOKEN=<token>` and `SENTRY_FORCE_ENV_TOKEN=1` were set, so the
token wins over a stored login and takes the same env-token path. It also
replaces any `SENTRY_AUTH_TOKEN` / `SENTRY_TOKEN` already in the environment,
because the flag is the more explicit choice. `--access-token` wins over
`SENTRY_ACCESS_TOKEN`. Unlike a plain env token, the alias is sent to the
`--host`/`--url` target, as the old static token was (an org token's own URL
claim still has to match it).

Either one prints a single deprecation warning to stderr (stdout carries the
MCP protocol), without the token:

```
Deprecation warning: --access-token is deprecated; set SENTRY_AUTH_TOKEN (and SENTRY_FORCE_ENV_TOKEN=1 to override a stored login) instead.
```

The flag value is redacted from the CLI's telemetry like `--token`.

### Interactive Login and Self-Hosted Servers

When no credential is available and stdin is a TTY, the server starts the
interactive login before serving. MCP clients launch the server over pipes,
so in that case it exits with an error that names the login command for the
program that is running, such as `npx -y @sentry/mcp-server auth login`
(`packages/cli/src/lib/app-identity.ts`).

For self-hosted Sentry, set `SENTRY_HOST`/`SENTRY_URL`. Those also pick the
stored account for that server (see [Accounts](#accounts)) and scope
`SENTRY_AUTH_TOKEN` to it; `--host`/`--url` alone set the target but do not
scope an env token, so the server refuses to start (`HostScopeError`). A plain
HTTP instance takes an `http://` `SENTRY_URL`, or `--host` with
`--insecure-http`.

A repo-local `.sentryclirc` URL is not a trust source. Unless `--host`/`--url`
is passed, a non-SaaS `[defaults] url` must match a server you are logged in
to, the same check every CLI command applies. Otherwise the server refuses to
start (`HostScopeError`) instead of sending any token to that host. An org
auth token (`sntrys_`) passed through the deprecated alias is the exception:
it names the server it was issued for, so it is served when that server
matches the target and refused when it does not.

## Accounts

The credential store can hold several accounts, but each server process uses
one: the account resolved at startup. With `SENTRY_HOST`/`SENTRY_URL` set, that
is a stored account on that server; otherwise it is the active account
(`npx -y @sentry/mcp-server auth switch`). Refreshes after a 401 stay on that account, and tool
calls never pick a different one, even when another process switches or adds
accounts. If that account is removed or another user logs in over it, the
refresh fails and tool calls keep failing until the server restarts. To use
two accounts at once, configure two
MCP servers, for example one per host via `SENTRY_HOST`, or one with
`SENTRY_AUTH_TOKEN` and `SENTRY_FORCE_ENV_TOKEN=1`.

## Upgrading From Older `@sentry/mcp-server` Versions

Older releases had their own device code flow, bundled client ID, and token
cache (`~/.sentry/mcp.json`, `SENTRY_MCP_AUTH_CACHE`). Current releases do not
read that cache. Run `npx -y @sentry/mcp-server auth login` once, or set
`SENTRY_AUTH_TOKEN` (with `SENTRY_FORCE_ENV_TOKEN=1` to override a stored
login). `--access-token` / `SENTRY_ACCESS_TOKEN` keep working but are
deprecated (see above). `auth status`, `auth list`,
`auth switch`, and `auth logout` work in the package as in the CLI.

## Key Files

| File                                        | Purpose                                                       |
| ------------------------------------------- | ------------------------------------------------------------- |
| `packages/cli/src/lib/mcp.ts`               | Credential resolution, `--access-token` alias, refresh-on-401 |
| `packages/cli/src/commands/mcp.ts`          | `mcp` command flags and help                                  |
| `packages/cli/src/lib/mcp/server.ts`        | Agent providers, telemetry, and stdio startup                 |
| `packages/cli/src/lib/db/auth.ts`           | CLI token storage and `refreshToken()`                        |
| `packages/cli/src/lib/token-host.ts`        | Host-scoping checks                                           |
| `packages/mcp-core/src/transports/stdio.ts` | stdio transport and per-request auth context                  |
