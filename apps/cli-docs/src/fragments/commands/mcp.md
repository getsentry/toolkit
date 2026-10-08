
`sentry mcp` starts the local stdio Sentry MCP server using the active Sentry CLI session. Authenticate once with `sentry auth login`; no separate MCP login or token cache is required.

## Configure an MCP client

Point your MCP client at the installed Sentry CLI:

```json
{
  "mcpServers": {
    "sentry": {
      "command": "sentry",
      "args": ["mcp"]
    }
  }
}
```

For a self-hosted instance, first authenticate the CLI against that host. You can also override the target for this MCP server invocation:

```json
{
  "mcpServers": {
    "sentry": {
      "command": "sentry",
      "args": ["mcp", "--host=sentry.example.com"]
    }
  }
}
```
