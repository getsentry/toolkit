# Spec Delta

## Purpose

Defines the MCP's tool surface as the CLI's commands: how agents discover
them, how one is run, what each connection may do, and how completion helps
agents build valid calls.

## ADDED Requirements

### Requirement: Commands are the product surface

Every Sentry capability the MCP offers SHALL be a CLI command. The MCP SHALL
NOT define Sentry operations of its own.

#### Scenario: A new capability

- **WHEN** a Sentry capability is added for agents
- **THEN** it is added as a CLI command
- **THEN** it appears in `search_sentry` with no MCP code change

### Requirement: Discovery through CLI introspection

`search_sentry` SHALL return commands, their input schemas, and their
permission classes from the CLI's introspection metadata. The stdio server
SHALL read the route tree at runtime; the hosted server SHALL read the
generated catalog, and SHALL list only commands its build can run.

#### Scenario: Search finds a command

- **WHEN** an agent searches for "resolve an issue"
- **THEN** the result includes `issue resolve` with its permission class
- **WHEN** the agent asks for the schema of `issue resolve`
- **THEN** the result is the command's parameters as JSON Schema

### Requirement: Execution runs only exposed commands

`execute_sentry_command` SHALL run only commands marked exposed, with
parameters that validate against the command's schema, through the CLI SDK.
It SHALL NOT run arbitrary code.

#### Scenario: Hidden command

- **WHEN** an agent calls `execute_sentry_command` with `monitor run`
- **THEN** the call fails without running anything

#### Scenario: Invalid parameter value

- **WHEN** an agent passes an organization slug that does not exist
- **THEN** the call fails with completion candidates for that parameter

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

`search_sentry`'s `complete` mode SHALL return completion candidates for a
parameter, from the same completers as shell completion, with a data source
suited to the host.

#### Scenario: Dataset field completion

- **WHEN** an agent asks to complete `--field` of `explore` with `--dataset spans` and the prefix `span.d`
- **THEN** the result includes span attribute keys that start with `span.d`

### Requirement: Eval-gated catalog removal

The catalog tools SHALL NOT be removed until the MCP eval suite shows the
command surface matching the catalog on task success.

#### Scenario: Default flip

- **WHEN** the command surface matches the catalog on the eval suite
- **THEN** it becomes the default and the catalog stays behind a flag for one release
