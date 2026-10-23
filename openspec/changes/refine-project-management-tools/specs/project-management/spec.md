## ADDED Requirements

### Requirement: Project management tools are skill-gated and catalog-only

The system SHALL expose project-management tools only through the searchable catalog when the `project-management` skill and required Sentry scopes are granted.

#### Scenario: Project-management skill granted

- **WHEN** a session has the `project-management` skill and the required scopes for a project-management tool
- **THEN** the tool is discoverable through `search_sentry_tools` and executable through `execute_sentry_tool`

#### Scenario: Project-management skill absent

- **WHEN** a session does not have the `project-management` skill
- **THEN** project-management tools are not discoverable or executable

#### Scenario: Direct tool surface

- **WHEN** the MCP server registers top-level tools
- **THEN** project-management tools are not added to the direct `tools/list` surface

### Requirement: Project creation returns a usable DSN

The `create_project` tool SHALL create a Sentry project and return a usable `SENTRY_DSN` in the same tool response.

#### Scenario: Default DSN exists after project creation

- **WHEN** Sentry creates a default client key for the new project
- **THEN** `create_project` returns that existing DSN instead of creating another client key

#### Scenario: Default DSN is missing after project creation

- **WHEN** no client key exists after the project is created
- **THEN** `create_project` creates a `Default` client key and returns its DSN

#### Scenario: Project creation response

- **WHEN** `create_project` succeeds
- **THEN** the response includes the project ID, project slug, project name, and `SENTRY_DSN`

### Requirement: Project creation accepts core setup fields

The `create_project` tool SHALL accept core project setup fields and optional repository linking.

#### Scenario: Caller provides core project fields

- **WHEN** a caller provides `organizationSlug`, `teamSlug`, `name`, and optional `slug` or `platform`
- **THEN** the tool sends the supported project creation fields to Sentry

#### Scenario: Caller wants repository linking

- **WHEN** a caller provides a `repository`
- **THEN** the tool resolves the repository before creating the project
- **AND** creates a root code mapping for the created project and repository after project creation

#### Scenario: Requested repository does not resolve

- **WHEN** a caller provides a `repository` that cannot be found or resolves ambiguously
- **THEN** the tool returns a user input error before creating the project

### Requirement: Project creation respects active constraints

The system SHALL prevent project creation from escaping the active MCP constraints.

#### Scenario: Organization-scoped session

- **WHEN** a session is constrained to an organization
- **THEN** `create_project` uses that organization constraint and does not accept another organization

#### Scenario: Project-scoped session

- **WHEN** a session is constrained to a specific project
- **THEN** `create_project` is not available or rejects execution

### Requirement: Project metadata updates are separate from team access changes

The `update_project` tool SHALL only update project metadata fields.

#### Scenario: Caller updates metadata

- **WHEN** a caller provides at least one of `name`, `slug`, or `platform`
- **THEN** `update_project` updates only those project metadata fields

#### Scenario: Caller attempts team assignment through update_project

- **WHEN** a caller provides team assignment arguments to `update_project`
- **THEN** the tool schema rejects those arguments

#### Scenario: Caller renames project in project-scoped session

- **WHEN** a project-scoped session invokes `update_project` with a `slug` value
- **THEN** the tool returns a user input error explaining that slug changes require an organization-scoped or unconstrained session

#### Scenario: Caller provides no metadata changes

- **WHEN** a caller invokes `update_project` without `name`, `slug`, or `platform`
- **THEN** the tool returns a user input error explaining that at least one metadata field is required

### Requirement: Team access grants use an explicit tool

The `add_team_to_project` tool SHALL grant a team access to an existing project.

#### Scenario: Team is not assigned to project

- **WHEN** a caller invokes `add_team_to_project` for a team that is not assigned to the project
- **THEN** the tool adds the team and returns the updated project team list

#### Scenario: Team is already assigned to project

- **WHEN** a caller invokes `add_team_to_project` for a team that already has access
- **THEN** the tool returns a successful no-op response with the current project team list

### Requirement: Team access removals are guarded

The `remove_team_from_project` tool SHALL revoke a team's project access only after validating the current project team assignments.

#### Scenario: Team is assigned and not the last team

- **WHEN** a caller invokes `remove_team_from_project` for an assigned team and at least one other team remains
- **THEN** the tool removes the team and returns the remaining project team list

#### Scenario: Team is not assigned to project

- **WHEN** a caller invokes `remove_team_from_project` for a team that is not assigned to the project
- **THEN** the tool returns a user input error and does not call the delete endpoint

#### Scenario: Team is the only assigned team

- **WHEN** a caller invokes `remove_team_from_project` for the project's only assigned team
- **THEN** the tool returns a user input error and does not call the delete endpoint

### Requirement: Project team access tools respect active constraints

The project team access tools SHALL operate only within the active organization and project constraints.

#### Scenario: Organization constraint

- **WHEN** a session is constrained to an organization
- **THEN** team access tools use that organization constraint and do not accept another organization

#### Scenario: Project constraint

- **WHEN** a session is constrained to a project
- **THEN** team access tools use that project constraint and do not accept another project

### Requirement: Project-management responses are user-facing markdown

Project-management tools SHALL return concise markdown responses with follow-up identifiers and no raw API payloads.

#### Scenario: Project operation succeeds

- **WHEN** a project-management tool completes successfully
- **THEN** the response includes the relevant organization slug, project slug, IDs needed for follow-up calls, and short response notes

#### Scenario: Access-changing operation succeeds

- **WHEN** a team access tool completes successfully
- **THEN** the response clearly states whether access was granted or revoked and lists the current project teams
