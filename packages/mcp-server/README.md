# @sentry/mcp-server (deprecated)

The Sentry stdio MCP server now ships in the Sentry CLI. Configure your MCP
client to run:

```json
{
  "command": "npx",
  "args": ["-y", "sentry", "mcp"]
}
```

`sentry mcp` accepts the same flags and environment variables, including
`--access-token` / `SENTRY_ACCESS_TOKEN`. Without a token it uses your
`sentry auth login` session.

This package is a thin shim that prints a deprecation notice and runs
`sentry mcp` with the same arguments. `sentry-mcp auth login|logout|status`
runs `sentry auth login|logout|status`.

To delete after the final `@sentry/mcp-server` publish.
