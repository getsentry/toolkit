# Spec Delta

## Purpose

Defines the MCP's tool surface as the CLI's commands: one tool per exposed
command, how a call runs, what each connection may do, and how completion
helps agents build valid calls.

## ADDED Requirements

### Requirement: Commands are the product surface

Every Sentry capability the MCP offers SHALL be a CLI command. The MCP SHALL
NOT define Sentry operations of its own.

#### Scenario: A new capability

- **WHEN** a Sentry capability is added for agents
- **THEN** it is added as a CLI command
- **THEN** it is listed as an MCP tool with no MCP code change

### Requirement: One tool per exposed command

The MCP SHALL list one tool per exposed command, named from the command's
path, with the command's brief and examples as its description and the
command's parameters as its input schema, from the CLI's introspection
metadata. It SHALL NOT add search or execute meta-tools; harnesses search
the tool list themselves. The hosted server SHALL read the generated
catalog, and SHALL list only commands its build can run.

#### Scenario: Tool list matches the catalog

- **WHEN** a connection lists tools
- **THEN** the list has one tool per exposed command, such as `sentry_issue_list` for `sentry issue list`
- **THEN** each tool's input schema is the command's `{ positional, flags }` JSON Schema
- **THEN** the list has no `search_sentry`, `execute_sentry_read`, or `execute_sentry_write`

### Requirement: Execution runs only exposed commands

Command tools SHALL run only commands marked exposed, with parameters that
validate against the command's schema, through the CLI SDK. They SHALL NOT
run arbitrary code.

#### Scenario: Hidden command

- **WHEN** a connection lists tools
- **THEN** there is no tool for `monitor run`, a hidden command

#### Scenario: Invalid parameter value

- **WHEN** an agent passes an organization slug that does not exist
- **THEN** the call fails with the allowed values or completion candidates for that parameter

### Requirement: Annotations from the permission class

Each command tool SHALL carry hints from its command's permission class:
read commands `readOnlyHint`, write and destructive commands
`destructiveHint`. `sentry api`, whose class comes from each call's method,
SHALL be marked destructive, and read-only on a read-only connection. A
read-only connection SHALL NOT list write tools.

#### Scenario: A host allowlists reads

- **WHEN** a host allowlists the read-only tools
- **THEN** read commands such as `sentry_issue_list` run without approval
- **THEN** `sentry_issue_resolve` still asks for approval

#### Scenario: Read-only connection lists tools

- **WHEN** a read-only connection lists tools
- **THEN** the list has the read command tools and `sentry_api`, and no write tools

### Requirement: Permission classes

Every command SHALL have a permission class (read, write, or destructive)
that agrees with the API operations it calls. A read-only connection SHALL
run only read commands, and `sentry api` calls only with read methods.
Session constraints SHALL pin organization and project parameters.

#### Scenario: Read-only connection runs a write command

- **WHEN** a read-only connection calls `issue resolve`
- **THEN** the call is refused without sending an API request

#### Scenario: Constrained session

- **WHEN** a session is constrained to an organization and a call names another organization
- **THEN** the call is refused

### Requirement: Isolation on the hosted server

When the hosted server runs the CLI SDK, no user's credentials,
constraints, or cached data SHALL be visible to another user's request.

#### Scenario: Concurrent identities

- **WHEN** two identities run commands concurrently in one isolate
- **THEN** each call uses only its own credentials, constraints, and cache entries

### Requirement: Completion for agents

Completion SHALL reach agents through parameter schema `examples` and
validation errors, with no completion tool. A call with an invalid value
SHALL fail with completion candidates for that parameter, from the same
completers as shell completion, with a data source suited to the host.

#### Scenario: Dataset field completion

- **WHEN** an agent calls `sentry_explore` with `--dataset spans` and a `--field` that does not exist, such as `span.dur`
- **THEN** the error includes span attribute keys close to `span.dur`

### Requirement: Eval-gated catalog removal

The catalog tools SHALL NOT be removed until the MCP eval suite shows the
command surface matching the catalog on task success.

#### Scenario: Default flip

- **WHEN** the command surface matches the catalog on the eval suite
- **THEN** it becomes the default and the catalog stays behind a flag for one release
