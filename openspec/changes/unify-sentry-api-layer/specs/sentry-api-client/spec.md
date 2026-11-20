# Spec Delta

## Purpose

Defines the shared Sentry API client: one implementation of endpoint
wrappers, errors, response validation, pagination, cache policy, retries,
and transport, used by the CLI and MCP from `@sentry/toolkit-core` first and
from `@sentry/api` once it moves there. It runs unchanged in Node,
Cloudflare Workers, and browsers.

## ADDED Requirements

### Requirement: One API client for every host

The CLI, the stdio MCP server, and the hosted MCP SHALL call the Sentry API
through the shared client. Neither product SHALL keep its own endpoint
wrappers, API error classes, retry loop, or pagination for an endpoint the
shared client covers.

#### Scenario: Same endpoint from both products

- **WHEN** the CLI and an MCP tool fetch the same resource
- **THEN** both call the same shared endpoint wrapper
- **THEN** both get the same error classes, and each gets the result type of the schema it passed

### Requirement: Library-agnostic validation

The shared client SHALL validate responses through the Standard Schema
interface with a schema the host supplies. It SHALL NOT depend on Zod,
valibot, or another validation library at runtime.

#### Scenario: MCP with Zod

- **WHEN** the MCP calls a shared wrapper with a Zod schema
- **THEN** the response is validated with it and the result has the schema's output type

#### Scenario: CLI with valibot

- **WHEN** the CLI calls the same wrapper with a valibot schema
- **THEN** the response is validated with it and Zod is not loaded

#### Scenario: Invalid response

- **WHEN** a response fails the host's schema
- **THEN** the shared client throws its validation error with the schema's issues

#### Scenario: Endpoint without a generated operation

- **WHEN** `@sentry/api` has no generated operation for an endpoint
- **THEN** the shared wrapper calls it through the shared transport and validates the response with the host's schema

### Requirement: Portable shared code

The shared client SHALL import only `@sentry/api` and other shared modules
that move with it, and SHALL use only web-standard APIs. It SHALL NOT import
`node:*` modules or use `Buffer`, `fs`, `process`, or `AsyncLocalStorage`. A
check in CI SHALL fail when shared code breaks this rule.

#### Scenario: Browser typecheck

- **WHEN** the shared modules are typechecked against the DOM library with no Node types
- **THEN** the typecheck passes

#### Scenario: Node-only API added

- **WHEN** a change imports a `node:*` module or uses a Node global in a shared module
- **THEN** lint fails on that change

### Requirement: Hosts inject their environment

The shared client SHALL take credentials, cache storage, a fresh-read scope,
logging, and telemetry as injected interfaces. Each host SHALL provide its
own implementation.

#### Scenario: CLI host

- **WHEN** the CLI creates the client
- **THEN** it passes its stored credentials with refresh, its on-disk cache store, and its telemetry spans

#### Scenario: MCP host

- **WHEN** the MCP creates the client for a tool call
- **THEN** it passes the session's access token, and its request-scoped fresh flag through `fresh()`

#### Scenario: Browser host

- **WHEN** a browser app creates the client with session credentials and no cache store
- **THEN** requests go through `fetch` with the browser's own HTTP caching

### Requirement: Errors keep their API meaning

Shared API errors SHALL carry the HTTP status, the server's detail, and, for
a 429, `retryAfterMs` from `Retry-After` or `X-Sentry-Rate-Limit-Reset`.
Hosts SHALL map them to their own presentation, such as CLI exit codes or
MCP tool messages, without losing those fields.

#### Scenario: Rate limited

- **WHEN** a request is still rate limited after the transport stops retrying
- **THEN** the shared client throws a rate-limit error with `retryAfterMs`
- **THEN** the CLI and MCP each report when to retry

### Requirement: Moves into @sentry/api unchanged

The shared client's file layout SHALL match its planned layout inside
`@sentry/api`, so step 2 copies the modules into
getsentry/sentry-api-schema without restructuring them. After a published
`@sentry/api` contains them, toolkit SHALL import them from `@sentry/api`
and delete its copies.

#### Scenario: Switch to the published package

- **WHEN** a `@sentry/api` release contains the shared client
- **THEN** the CLI and MCP import it from `@sentry/api`
- **THEN** the toolkit-core copies are deleted in the same change
