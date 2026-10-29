# @sentry/mcp-server

A stdio MCP server for sentry.io. It is a small proxy that forwards your MCP
client's stdio messages to the hosted Sentry MCP at `https://mcp.sentry.dev`,
so you get Sentry's tools without downloading the Sentry CLI.

```json
{
  "mcpServers": {
    "sentry": {
      "command": "npx",
      "args": ["-y", "@sentry/mcp-server@latest"],
      "env": { "SENTRY_ACCESS_TOKEN": "sntryu_..." }
    }
  }
}
```

Create a [User Auth Token](https://sentry.io/settings/account/api/auth-tokens/)
with `org:read`, `project:read`, `project:write`, `team:read`, `team:write`, and
`event:write`, and pass it as `SENTRY_ACCESS_TOKEN` or `--access-token`. The
proxy sends it to the hosted MCP as `Authorization: Sentry-Bearer <token>` and
does not store it.

## Options

| Flag or variable                                | Effect                                |
| ----------------------------------------------- | ------------------------------------- |
| `--organization-slug <slug>`                    | Limit every call to one organization  |
| `--project-slug <slug>`                         | Also limit to one project             |
| `--skills <list>`, `MCP_SKILLS`                 | Grant only these skills               |
| `--disable-skills <list>`, `MCP_DISABLE_SKILLS` | Remove skills from the default set    |
| `--all-skills`                                  | Grant all active skills (the default) |
| `--experimental`                                | Enable experimental tools             |

## Self-hosted Sentry and local use

The hosted MCP only talks to sentry.io. For self-hosted Sentry, your own LLM
provider, or your `sentry auth login` session, use `sentry mcp` from the
[Sentry CLI](https://cli.sentry.dev), which runs the tools locally and accepts
the same flags:

```json
{
  "command": "npx",
  "args": ["-y", "sentry@latest", "mcp", "--host=sentry.example.com"]
}
```

The proxy exits with an error pointing there when `--host`, `--url`,
`SENTRY_HOST`, or `SENTRY_URL` names a host other than sentry.io (or one of its
regional subdomains), or when `--insecure-http`, `--agent-provider`,
`--openai-*`, or `--anthropic-*` is set.
