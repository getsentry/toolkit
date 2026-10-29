# @sentry/mcp-server

The Sentry stdio MCP server as a single file with no runtime dependencies. It
is the Sentry CLI's `sentry mcp` server, bundled without the rest of the CLI,
so it works with sentry.io and self-hosted Sentry.

```json
{
  "command": "npx",
  "args": ["-y", "@sentry/mcp-server"]
}
```

Requires Node.js 22.15 or later.

## Authentication

- `npx -y @sentry/mcp-server auth login` signs in with the Sentry CLI's device
  flow. The session is shared with the `sentry` CLI, so `sentry auth login`
  works too.
- `--access-token` / `SENTRY_ACCESS_TOKEN` passes a static token instead.
- For account management (`logout`, `status`, switching accounts), use
  `npx -y sentry auth ...`.

## Options

The flags and environment variables are the same as `sentry mcp`; run
`npx -y @sentry/mcp-server --help` for the list. For self-hosted Sentry, pass
`--host` or `--url`, or set `SENTRY_HOST` / `SENTRY_URL`.

## Development

The source lives in `packages/cli`. `pnpm run bundle` builds
`dist/sentry-mcp.cjs` from `packages/cli/src/mcp-server.ts`, and
`pnpm run test:bundle` smoke-tests the result.
