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
- Each server process uses one account. Log out, check status, or switch
  accounts with `npx -y sentry auth logout|status|switch`.

## Options

Run `npx -y @sentry/mcp-server --help` for the flags and environment
variables. For self-hosted Sentry, pass `--host` or `--url`, or set
`SENTRY_HOST` / `SENTRY_URL`.

## Development

The source lives in `packages/cli` so the server shares the CLI's auth.
`pnpm run bundle` builds `dist/sentry-mcp.cjs` from
`packages/cli/src/mcp-server.ts`, and `pnpm run test:bundle` smoke-tests the
result.
