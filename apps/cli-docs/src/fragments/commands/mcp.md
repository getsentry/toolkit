
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

For a self-hosted instance, first authenticate the CLI against that host. You can also pick the instance for this MCP server with `SENTRY_HOST` or `SENTRY_URL` (an `http://` URL for plain HTTP), the same as for other commands:

```json
{
  "mcpServers": {
    "sentry": {
      "command": "sentry",
      "args": ["mcp"],
      "env": {
        "SENTRY_HOST": "sentry.example.com"
      }
    }
  }
}
```

`--host`, `--url`, and `--insecure-http` still work but are deprecated.

## Limit the server to an organization or project

Pass `<org>/` to limit every call to one organization, or `<org>/<project>` to one project:

```json
{
  "mcpServers": {
    "sentry": {
      "command": "sentry",
      "args": ["mcp", "acme/web"]
    }
  }
}
```

`--org` and `--project` do the same; a target and a flag that name different values are an error. A bare `acme` is refused, because other commands read it as a project search: pass `acme/` for the organization. The target takes no URL; pick the Sentry instance with `SENTRY_HOST` or `SENTRY_URL`.
