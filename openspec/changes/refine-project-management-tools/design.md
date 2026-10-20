## Context

The MCP catalog already includes `create_project`, `update_project`, `create_team`, and DSN management tools under the `project-management` skill. The current project tools need sharper boundaries:

- `create_project` creates a project, creates an additional DSN, and optionally links a repository.
- `update_project` changes project metadata and can also grant a team access to the project.
- Project-scoped MCP sessions can still discover `create_project`, even though creating sibling projects is outside the active project constraint.

Sentry's upstream project creation endpoint creates the project under a team and emits normal project creation side effects, including default key creation through Sentry's project post-save hook. Agents still need the DSN in the tool response because creating a Sentry project is usually followed immediately by SDK setup.

Endpoint validation:

- `~/src/sentry/src/sentry/core/endpoints/project_teams.py` lists project teams through `ProjectTeamsEndpoint.get`, backed by `OffsetPaginator` and cursor `Link` headers, so MCP must page through cursors before applying team-access safety checks.
- `~/src/sentry/src/sentry/integrations/api/endpoints/organization_code_mappings_bulk.py` persists repository/project associations through `OrganizationCodeMappingsBulkEndpoint.post` at `/organizations/{org}/code-mappings/bulk/`; it resolves the project by slug, resolves the repository by name/provider, infers the default branch when possible, and creates or updates `RepositoryProjectPathConfig` rows.

## Goals / Non-Goals

**Goals:**

- Make project creation a safe, focused setup workflow that always returns a usable `SENTRY_DSN`.
- Keep project metadata updates separate from project team access changes.
- Add explicit tools for granting and revoking project team access.
- Preserve catalog-only exposure behind the `project-management` skill.
- Document project-management behavior in a durable repo spec.
- Add focused test coverage for success paths, guardrails, constraints, and generated definitions.

**Non-Goals:**

- Repository linking as a metadata update or team access concern.
- Project deletion, transfer, ownership rule management, alert rule management, or broader project settings.
- Direct top-level MCP exposure for project-management tools.
- Changing Sentry's upstream API semantics.

## Decisions

### Keep `create_project` focused on project setup

`create_project` will call Sentry's team project creation endpoint with core fields: organization, team, name, optional slug, and optional platform. It will not expose the upstream `default_rules` flag in the first iteration; Sentry's default behavior remains active.

Repository linking stays first-class in `create_project` because project setup often includes connecting the new project to its source repository. When requested, the tool resolves the repository before creating the project so missing or ambiguous repositories fail without creating a project. Linking creates a root code mapping through Sentry's organization code-mappings endpoint after project creation because it requires the created project slug; link failures are reported in the response with the DSN so the user can retry manually.

Alternative considered: move repository linking to a separate tool only. This was rejected because repository linking is part of the primary project setup workflow and is useful to keep alongside creation while team access remains separate.

### Guarantee a DSN without creating duplicates in the normal path

After project creation, the tool will call `listClientKeys` for the created project. If a key exists, it will return an existing DSN, preferring a key named `Default` when present. If no key exists, it will create a `Default` key and return that DSN.

Alternative considered: always call `createClientKey` after project creation. This guarantees a DSN, but it creates duplicate keys in normal Sentry deployments where the default key already exists.

### Make `update_project` metadata-only

`update_project` will only update `name`, `slug`, and `platform`. Team access changes will move to separate tools. This keeps the tool's destructive annotation and user-facing description aligned with what it actually mutates.

Alternative considered: keep team assignment as an optional field. This was rejected because changing teams changes access and rule ownership behavior, which is materially different from correcting a project name or platform.

### Reject project-scoped slug changes

When a session is constrained to a project, `update_project` will reject `slug` updates. A successful rename would leave the active session constrained to the old slug until reconnect, which makes follow-up tool calls ambiguous or likely to fail.

Alternative considered: allow the update and report the new slug. This was rejected for the first iteration because the active MCP constraint is session state, not a mutable output from the tool call.

### Add explicit team access tools

`add_team_to_project` and `remove_team_from_project` will be separate catalog tools. Adding a team widens access; removing a team revokes access and can clear alert/rule team ownership upstream. The separate names make those effects visible to agents and users.

Alternative considered: one `update_project_team_access` tool with an action enum. Separate tools are clearer for tool search, safety annotations, examples, and audit-focused responses.

### Preflight team removal

`remove_team_from_project` will fetch current project teams before deleting. It will reject removal when the target team is not assigned and when it is the only assigned team.

Alternative considered: rely entirely on the backend DELETE. This was rejected because the backend path deletes the project-team row and clears ownership references without a last-team guard at that layer.

### Keep tools catalog-only

The project-management tools will remain discoverable through `search_sentry_tools` and executable through `execute_sentry_tool`, filtered by skills, scopes, and constraints. They will not be added to `TOP_LEVEL_TOOL_NAMES`.

Alternative considered: expose `create_project` directly. This was rejected because project management is powerful, less frequent than inspection/search, and the direct surface has a strict tool budget.

## Risks / Trade-offs

- Duplicate DSN fallback could still create a key if key listing races with Sentry's default key hook. Mitigation: list first, create only when the list is empty, and keep the fallback explicit in tests.
- Repository linking can fail after project creation because code mapping creation needs the created project. Mitigation: preflight repository resolution before project creation and report post-create link failures without hiding the project slug or DSN.
- Last-team removal guard may reject a backend operation that Sentry technically allows. Mitigation: prefer safe MCP behavior; users can use Sentry directly for exceptional cases until a deliberate override is designed.
- Slug updates can make project-scoped sessions confusing after the mutation. Mitigation: reject and test slug changes in project-scoped sessions.
- Adding team access tools increases catalog size. Mitigation: keep them catalog-only and behind the existing `project-management` skill.

## Migration Plan

1. Update API client support for project creation slug, repository linking, and project team access reads/deletes.
2. Tighten `create_project` and `update_project` schemas and descriptions.
3. Add `add_team_to_project` and `remove_team_from_project`.
4. Add tests covering old behavior removal and new contracts.
5. Add `docs/specs/project-management.md` and link it from `docs/specs/README.md`.
6. Regenerate tool definitions.

Rollback is straightforward: revert the catalog and API client changes. Existing users of `update_project(..., teamSlug=...)` will need to switch to `add_team_to_project`; this should be called out in the spec and release notes if applicable.

## Open Questions

None.
