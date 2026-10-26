# Spec Delta

## Purpose

Defines how a host process gives the MCP server its Sentry credentials and
API transport, so one login and one request stack serve both the CLI and
the local MCP server.

## ADDED Requirements

### Requirement: Host-supplied transport

The MCP server SHALL accept a Sentry API transport from its host. When one
is supplied, every Sentry API request made by MCP tools SHALL go through it.

#### Scenario: Transport supplied

- **WHEN** a host starts the MCP server with a transport
- **THEN** tool calls send their Sentry API requests through that transport

#### Scenario: No transport supplied

- **WHEN** the MCP server starts without a host transport
- **THEN** it uses the shared default transport with the configured access token

### Requirement: sentry mcp reuses the CLI session

`sentry mcp` SHALL start the MCP server with the CLI's stored login, token
refresh, and response cache. It SHALL not start a separate login flow.

#### Scenario: Logged-in CLI

- **WHEN** a user who has run `sentry auth login` starts `sentry mcp`
- **THEN** MCP tools authenticate with that login without prompting again

#### Scenario: Cache shared with CLI commands

- **WHEN** a CLI command and an MCP tool, for the same identity, request the same immutable resource
- **THEN** the second request is served from the shared on-disk cache

#### Scenario: Token rejected mid-session

- **WHEN** the API rejects the token during a `sentry mcp` session
- **THEN** the CLI refreshes the credential and later tool calls succeed without restarting the server

### Requirement: CLI login covers MCP tool scopes

The OAuth scopes granted by `sentry auth login` SHALL include every scope
that MCP tools require.

#### Scenario: Write tool after CLI login

- **WHEN** a user who logged in with `sentry auth login` calls an MCP tool that needs write scopes
- **THEN** the call is not rejected for missing scopes

### Requirement: Standalone login is deprecated

The standalone `@sentry/mcp-server` device-code login SHALL keep working and
SHALL tell users that `sentry mcp` is the supported local entry point.

#### Scenario: Standalone auth

- **WHEN** a user runs the standalone `@sentry/mcp-server` auth command
- **THEN** login succeeds and the output points the user to `sentry mcp`
