# Stdio Authentication

How the stdio MCP server (`@sentry/mcp-server`) authenticates with Sentry.

Sign in once with `npx -y @sentry/mcp-server auth login`. The package runs
the Sentry CLI's own `auth` commands and stores the session in the CLI's
credential store, so the package and the CLI (which runs the same server as
`sentry mcp`) share one login.

## Credential Sources

The server uses the CLI's credential resolution, with one difference: an env
token wins over a stored login, as if `SENTRY_FORCE_ENV_TOKEN=1` were set. An
MCP client passes the token in its server config to pick the account, so a
stored login must not silently replace it.

1. **`SENTRY_AUTH_TOKEN`** (or the legacy `SENTRY_TOKEN`) — used when set, even
   when a stored login exists.
2. **Stored login** — the account from `auth login`, used when no env token is
   set.

A `[auth] token` from a repo-local `.sentryclirc` is not forced: it comes from
the repository, not the MCP client, so a stored login still wins over it, as
for every other CLI command.

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
    "SENTRY_AUTH_TOKEN": "sntryu_..."
  }
}
```

Org auth tokens (`sntrys_`) record the Sentry URL they were issued for; the
server refuses to send one to a different host (`HostScopeError`).

### Deprecated: `--access-token` and `SENTRY_ACCESS_TOKEN`

Older `@sentry/mcp-server` releases took a static token from `--access-token`
or `SENTRY_ACCESS_TOKEN`. Both still work, as an alias: the server runs as if
`SENTRY_AUTH_TOKEN=<token>` were set, so the token wins over a stored login
and takes the same env-token path. It also
replaces any `SENTRY_AUTH_TOKEN` / `SENTRY_TOKEN` already in the environment,
because the flag is the more explicit choice. `--access-token` wins over
`SENTRY_ACCESS_TOKEN`. Like a plain env token, the alias is scoped to the
Sentry instance configured at startup (`SENTRY_HOST`/`SENTRY_URL`, or
`--host`/`--url`), else SaaS; an org token's own URL claim wins. A
`.sentryclirc` URL or the persisted default URL never scopes it, so the server
refuses to send it there (`HostScopeError`), even when you have a stored login
on that server.

Either one prints a single deprecation warning to stderr (stdout carries the
MCP protocol), without the token:

```
Deprecation warning: --access-token is deprecated; set SENTRY_AUTH_TOKEN instead.
```

The flag value is redacted from the CLI's telemetry like `--token`.

### Interactive Login and Self-Hosted Servers

When no credential is available and stdin is a TTY, the server starts the
interactive login before serving. MCP clients launch the server over pipes,
so in that case it exits with an error that names the login command for the
program that is running, such as `npx -y @sentry/mcp-server auth login`
(`packages/cli/src/lib/app-identity.ts`).

For self-hosted Sentry, set `SENTRY_HOST`/`SENTRY_URL`, the same as for every
other CLI command. They pick the stored account for that server (see
[Accounts](#accounts)), scope `SENTRY_AUTH_TOKEN` to it, and point the
interactive login at it. A plain HTTP instance takes an `http://`
`SENTRY_URL`.

### Deprecated: `--host`, `--url`, and `--insecure-http`

Older releases picked the instance with `--host`/`--url`, and plain HTTP with
`--insecure-http`. They still work, hidden from help, as an alias: the server
runs as if `SENTRY_URL` were set to that target (`http://` with
`--insecure-http`), so the credential check, the env token's host scope, and
the interactive login all use it. Each prints a deprecation warning to
stderr.

A repo-local `.sentryclirc` URL is not a trust source. Unless `--host`/`--url`
is passed, a non-SaaS `[defaults] url` must match a server you are logged in
to, the same check every CLI command applies. With `SENTRY_AUTH_TOKEN` set, the
check uses that token, as serving does: the URL must match the server the token
is scoped to (its `sntrys_` claim, or `SENTRY_HOST`/`SENTRY_URL` from the
environment the server started with, never the file). Otherwise the server
refuses to start (`HostScopeError`) instead of sending any token to that host.
An org auth token (`sntrys_`) passed through the deprecated alias is the
exception: it names the server it was issued for, so it is served when that
server matches the target and refused when it does not.

## Accounts

The credential store can hold several accounts. The server starts with one:
with `SENTRY_HOST`/`SENTRY_URL` set, a stored account on that server;
otherwise the active account (`npx -y @sentry/mcp-server auth switch`). Calls
that target no organization use that startup account, and another process
switching accounts does not change it.

With a stored login, each tool call uses the stored account that knows the
organization it targets (its `organizationSlug`, or the organization in a
Sentry URL argument), the same way CLI commands pick an account. No
`auth switch` or restart is needed. The server first lists the startup
account's organizations when no fresh list is cached, so it is kept only for
organizations it can reach. When no stored account is known to reach the
organization, the server lists the organizations of accounts without a
fresh cached list once, then routes; an organization no account reaches uses
the startup account. Only accounts on the server's target server are
candidates. One call never mixes accounts, and a 401 refreshes only the
account that made the call. `find_organizations` lists organizations from
every account, each once, and `whoami` lists every account's user.

Each account is pinned to the user it had when a call first used it. If an
account is removed or another user logs in over it, calls routed to it fail
until the server restarts.

Routing is off when the credential is a static token (`SENTRY_AUTH_TOKEN`,
`--access-token`, `SENTRY_ACCESS_TOKEN`): that token is the only account.
`--organization-slug` (or an `<org>/` target) picks the account that knows the
organization once, at startup, and every call uses it. To use accounts on
different servers at once (say, sentry.io and a self-hosted server), configure
one MCP server per host via `SENTRY_HOST`.

With a scope (`<org>/`, `<org>/<project>`, `--org`, `--project`), the server
checks it with that credential before it connects: one request for the
organization, then, for a project, one for the project on the organization's
region (`links.regionUrl`). When Sentry answers 404, the server prints
which part of the scope was not found on stderr and exits with the resolution
exit code (23), instead of failing every call with a generic 404. Any other
answer (401, 403, 5xx), a network failure, or no answer within 3 seconds starts
the server as before.

## Upgrading From Older `@sentry/mcp-server` Versions

Older releases had their own device code flow, bundled client ID, and token
cache (`~/.sentry/mcp.json`, `SENTRY_MCP_AUTH_CACHE`). Current releases do not
read that cache. Run `npx -y @sentry/mcp-server auth login` once, or set
`SENTRY_AUTH_TOKEN`. `--access-token` / `SENTRY_ACCESS_TOKEN` keep working but are
deprecated (see above). `auth status`, `auth list`,
`auth switch`, and `auth logout` work in the package as in the CLI.

## Key Files

| File                                                                | Purpose                                                       |
| ------------------------------------------------------------------- | ------------------------------------------------------------- |
| `packages/cli/src/lib/mcp.ts`                                       | Credential resolution, `--access-token` alias, refresh-on-401 |
| `packages/cli/src/commands/mcp.ts`                                  | `mcp` command flags and help                                  |
| `packages/cli/src/lib/mcp/server.ts`                                | Agent providers, telemetry, and stdio startup                 |
| `packages/cli/src/lib/mcp/account-router.ts`                        | Per-call routing between stored accounts                      |
| `packages/cli/src/lib/mcp/scope-check.ts`                           | Startup check that the `<org>/[<project>]` scope exists       |
| `packages/mcp-core/src/internal/tool-helpers/credential-routing.ts` | Applies `ServerContext.credentialRouter` to tool calls        |
| `packages/cli/src/lib/db/auth.ts`                                   | CLI token storage and `refreshToken()`                        |
| `packages/cli/src/lib/token-host.ts`                                | Host-scoping checks                                           |
| `packages/mcp-core/src/transports/stdio.ts`                         | stdio transport and per-request auth context                  |
