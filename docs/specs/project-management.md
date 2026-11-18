# Project Management Tools

Project-management tools create and update Sentry projects, teams, project DSNs,
and project team access through the searchable MCP catalog.

## Overview

Project management is intentionally powerful and infrequent. These tools are
available only when the `project-management` skill is granted, and they remain
catalog-only: discover them with `search_sentry_tools` and execute them with
`execute_sentry_tool`.

Implementation references:

- Tool catalog: `packages/mcp-core/src/tools/catalog/`
- Availability rules: `packages/mcp-core/src/tools/catalog-runtime/availability.ts`
- API client: `packages/mcp-core/src/api-client/client.ts`

## Tool Surface

Project-management tools are not direct top-level MCP tools. They must not be
added to `TOP_LEVEL_TOOL_NAMES` in `packages/mcp-core/src/tools/surfaces.ts`.

Core project tools:

```typescript
create_project({
  organizationSlug: "my-org",
  teamSlug: "my-team",
  name: "My Project",
  slug: "my-project", // optional
  platform: "javascript", // optional
  repository: "acme/app", // optional, must already be connected
});

update_project({
  organizationSlug: "my-org",
  projectSlug: "my-project",
  name: "New Name", // at least one metadata field is required
  slug: "new-slug",
  platform: "python",
});

add_team_to_project({
  organizationSlug: "my-org",
  projectSlug: "my-project",
  teamSlug: "backend",
});

remove_team_from_project({
  organizationSlug: "my-org",
  projectSlug: "my-project",
  teamSlug: "backend",
});
```

## Creation Contract

`create_project` accepts core setup fields:

- `organizationSlug`
- `teamSlug`
- `name`
- optional `slug`
- optional `platform`
- optional `repository`

It does not expose ownership rules, alert rule setup, `defaultRules`, or broader
project settings.

Successful responses must include:

- Project ID
- Project slug
- Project name
- `SENTRY_DSN`

The DSN contract is strict because SDK setup normally follows project creation.
After creating the project, the tool lists project client keys and returns an
existing usable DSN, preferring an active `Default` key. It creates a `Default`
client key only when no usable key exists.

When `repository` is provided, `create_project` resolves the repository before
creating the project. Unknown or ambiguous repositories fail before the project
is created. After creation, the tool links the repository by creating a root
code mapping (`/` to `/`) through Sentry's organization code-mappings endpoint.
If linking fails after project creation, the response still includes the project
slug and DSN and notes that the repository must be linked manually.

## Metadata Updates

`update_project` is metadata-only. It updates only:

- `name`
- `slug`
- `platform`

At least one metadata field is required. Team access changes must use
`add_team_to_project` or `remove_team_from_project`.

Project-scoped sessions reject slug updates. A successful slug rename would
leave the active MCP session constrained to the old project slug until the
client reconnects.

## Team Access

`add_team_to_project` grants an existing team access to an existing project. It
lists current project teams first. If the team already has access, it returns a
successful no-op response with the current team list.

`remove_team_from_project` revokes team access and is marked destructive. It
lists current project teams before deleting and rejects:

- Teams that are not currently assigned to the project
- Removing the last assigned team

This MCP guard is stricter than the upstream delete endpoint so agents do not
accidentally leave a project without a team.

## Constraints

Organization and project constraints are enforced by catalog availability and
parameter injection:

- Organization-scoped sessions filter `organizationSlug` from schemas and inject
  the constrained organization.
- Project-scoped sessions filter `projectSlug` from update/team-access schemas
  and inject the constrained project.
- Project-scoped sessions hide `create_project` because sibling project creation
  is outside the active project constraint.

Conflicting explicit `organizationSlug` or `projectSlug` arguments from a caller
are filtered before handler execution.

## Migration

Previous behavior mixed unrelated operations into project tools:

- `update_project` could grant team access through `teamSlug`.

Use these replacements:

- Repository linking: use `create_project(..., repository: "owner/repo")` during
  creation.
- Team grant: `add_team_to_project`
- Team revoke: `remove_team_from_project`

## Testing

Required coverage lives with the tools and catalog runtime:

- `packages/mcp-core/src/tools/catalog/create-project.test.ts`
- `packages/mcp-core/src/tools/catalog/update-project.test.ts`
- `packages/mcp-core/src/tools/catalog/add-team-to-project.test.ts`
- `packages/mcp-core/src/tools/catalog/remove-team-from-project.test.ts`
- `packages/mcp-core/src/tools/catalog-runtime/availability.test.ts`
- `packages/mcp-core/src/tools/tools.test.ts`

Run `pnpm run --filter @sentry/mcp-core generate-definitions` after changing
tool descriptions, schemas, or catalog registration.
