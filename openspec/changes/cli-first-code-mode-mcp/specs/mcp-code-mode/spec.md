# Spec Delta

## Purpose

Defines the MCP's tool surface as Code Mode over the CLI: how agents
discover commands and API operations, how their code calls them, what each
connection may do, and how completion helps them build valid calls.

## ADDED Requirements

### Requirement: Commands are the product surface

Every Sentry capability the MCP offers SHALL be a CLI command or a published
API operation. The MCP SHALL NOT define Sentry operations of its own.

#### Scenario: A new capability

- **WHEN** a Sentry capability is added for agents
- **THEN** it is added as a CLI command
- **THEN** it appears in `search_sentry` with no MCP code change

### Requirement: Discovery through CLI introspection

`search_sentry` SHALL return commands from the CLI's introspection metadata
and operations from the `@sentry/api` operation catalog. The stdio server
SHALL read the route tree at runtime; the hosted server SHALL read the
generated catalog, and SHALL list only commands marked `portable`.

#### Scenario: Search finds a command and an operation

- **WHEN** an agent searches for "copy dashboard"
- **THEN** the result includes the dashboard commands and the dashboard API operations, each with its permission class

#### Scenario: Hosted hides non-portable commands

- **WHEN** a command's operation is not portable
- **THEN** hosted `search_sentry` does not list it
- **THEN** `sentry mcp` lists it

### Requirement: Code runs without credentials

`execute_sentry_code` SHALL run agent code in a sandbox with no network
access and no credentials. Each `sentry.*` call SHALL be executed by the
host, which SHALL check the call against the connection's permissions and
constraints before running it.

#### Scenario: Sandbox network access

- **WHEN** agent code calls `fetch` directly
- **THEN** the call fails

#### Scenario: Constrained session

- **WHEN** a session is constrained to an organization and code calls a command for another organization
- **THEN** the host refuses the call

### Requirement: Permission classes

Every command SHALL have a permission class (read, write, or destructive)
that agrees with the API operations it calls. A read-only connection SHALL
run only read commands and read API operations. Every outgoing API request
SHALL also be checked against the published operation list and the grant.

#### Scenario: Read-only connection runs a write command

- **WHEN** a read-only connection calls `sentry.issue.resolve()`
- **THEN** the host refuses the call without sending an API request

### Requirement: Completion for agents

`sentry.complete(argv)` SHALL return completion candidates for the argument
under the cursor, from the same completers as shell completion, with a data
source suited to the host.

#### Scenario: Dataset field completion

- **WHEN** code calls `sentry.complete(["explore", "--dataset", "spans", "--field", "span.d"])`
- **THEN** the result includes span attribute keys that start with `span.d`

### Requirement: Eval-gated catalog removal

The catalog tools SHALL NOT be removed until the MCP eval suite shows Code
Mode matching the catalog on task success.

#### Scenario: Default flip

- **WHEN** Code Mode matches the catalog on the eval suite
- **THEN** Code Mode becomes the default and the catalog stays behind a flag for one release
