# Subpath-Based Constraints (End-User Guide)

## What constraints do

Constraints let you scope your Sentry MCP session to a specific organization and optionally a project. When scoped, all tools automatically use that org/project by default and only access data you are permitted to see.

## How to connect

- No scope: connect to `/mcp` (or `/sse` for SSE transport)
- Organization scope: `/mcp/{organizationSlug}`
- Organization + project scope: `/mcp/{organizationSlug}/{projectSlug}`

The same pattern applies to the SSE endpoint: `/sse`, `/sse/{org}`, `/sse/{org}/{project}`.

Examples:

```
/mcp/sentry
/mcp/sentry/my-project
/sse/sentry
/sse/sentry/my-project
```

## What you'll experience

- Tools automatically use the constrained organization/project
- Constrained parameters are removed from the tool schemas entirely and injected server-side, so a scoped session cannot override them or reach another organization
- Resource identifiers you pass (event, attachment, replay, profile, and client key IDs) are format-validated and URL-encoded, so they cannot rewrite the scoped path either
- If you don't provide a scope, tools work across your accessible organizations when supported
- Some tools are filtered when not useful: `find_organizations` is hidden when scoped to an org, and `find_projects` is hidden when scoped to a project

## Access verification

When you connect with a scoped path, we validate that:

- The slugs are well-formed
- The organization exists and you have access
- If a project is included, the project exists and you have access

If there’s a problem, you’ll receive a clear HTTP error when connecting:

- 400: Invalid slug format
- 401: Missing authentication
- 403: You don’t have access to the specified org/project
- 404: Organization or project not found

For OAuth connections, project verification requests `collapse=organization`
to avoid fetching organization metadata that is not needed for project
capabilities. Successful verification is cached for 15 minutes. If project
verification takes longer than five seconds, the request continues with unknown
project capabilities. This result is cached for 60 seconds to reduce repeated
delays; after it expires, the next request retries verification. Timeout results
use separate cache keys, and verified results take precedence, so a concurrent
timeout cannot overwrite verified capabilities or shorten their cache lifetime.
Cache propagation and concurrent requests can still cause repeated verification
or temporarily return unknown capabilities. Each tool still requires permission
to access the requested data.

## Region awareness

For Sentry Cloud, your organization may be hosted in a regional cluster. When you scope by organization, we automatically determine the region (if available) and use it for API calls. You don’t need to take any action—this happens behind the scenes. For self-hosted Sentry, the region concept doesn’t apply.

## Best practices

- Prefer scoping by organization (and project when known) to reduce ambiguity and improve safety
- Use scoped sessions when collaborating across multiple orgs to avoid cross-org access by mistake
- If a tool reports access errors, reconnect with a different scope or verify your permissions in Sentry

## Frequently asked questions

- Can I switch scope mid-session?
  - Yes. Open a new connection using a different subpath (e.g., `/mcp/{org}/{project}`) and use that session.

- Do I need to specify scope for documentation or metadata endpoints?
  - No. Public metadata endpoints don’t require scope and support CORS.

- How do tools know my scope?
  - The MCP session embeds the constraints, and tools read them as defaults for `organizationSlug` and `projectSlug`.

## Reference

Supported URL patterns:

```
/mcp/{organizationSlug}/{projectSlug}
/mcp/{organizationSlug}
/mcp

/sse/{organizationSlug}/{projectSlug}
/sse/{organizationSlug}
/sse
```

For implementation details and security notes, see:

- `docs/specs/subpath-constraints.md`
- `docs/architecture/overview.md`
