# @sentry/mcp-server

The Sentry MCP server for stdio clients, as a single file with no runtime
dependencies. Works with sentry.io and self-hosted Sentry.

```json
{
  "command": "npx",
  "args": ["-y", "@sentry/mcp-server@latest"]
}
```

Requires Node.js 22.15 or later.

## Authentication

- `npx -y @sentry/mcp-server auth login` signs in once. The login is shared
  with the [`sentry` CLI](https://cli.sentry.dev), so an existing
  `sentry auth login` works too.
- `--access-token` / `SENTRY_ACCESS_TOKEN` passes a static token instead.
- Each server process uses one account. The package runs the CLI's own
  `auth` commands, so `npx -y @sentry/mcp-server auth status|list|switch|logout`
  manages the same login.

## Options

Starting the server is the default command, so `npx -y @sentry/mcp-server`
and `npx -y @sentry/mcp-server mcp` are the same. Run
`npx -y @sentry/mcp-server mcp --help` for the flags and environment
variables. For self-hosted Sentry, pass `--host` or `--url`, or set
`SENTRY_HOST` / `SENTRY_URL`.

## Development

The source lives in `packages/cli`: `packages/cli/src/mcp-server.ts` runs the
CLI's runner with an application of three commands, `mcp`, `auth`, and
`help` (`packages/cli/src/mcp-server-app.ts`). `pnpm run bundle` builds
`dist/sentry-mcp.cjs` from it, and `pnpm run test:bundle` smoke-tests the
result.
