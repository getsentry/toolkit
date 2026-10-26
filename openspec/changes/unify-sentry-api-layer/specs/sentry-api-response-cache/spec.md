# Spec Delta

## Purpose

Lets the CLI and MCP reuse Sentry API GET responses without one user or
server ever seeing another's data, and without holding more memory or
storage than the host allows.

## ADDED Requirements

### Requirement: Identity-scoped entries

Every cache entry SHALL be keyed by the requesting identity, the request
method, and the full request URL including host and normalized query. The
identity SHALL stay stable across access-token rotation of the same login.

#### Scenario: Different users, same URL

- **WHEN** two identities request the same URL
- **THEN** neither receives the other's cached response

#### Scenario: Different servers, same path

- **WHEN** one identity requests the same path on two Sentry hosts
- **THEN** the responses are cached separately

#### Scenario: Token refresh

- **WHEN** an OAuth access token is refreshed for the same login
- **THEN** entries cached under the previous access token remain usable

### Requirement: Server cache headers take precedence

When a response carries HTTP caching headers, the cache SHALL follow them
(RFC 9111). Only responses without such headers SHALL use the TTL tiers.

#### Scenario: Server sends no-store

- **WHEN** a response carries `Cache-Control: no-store`
- **THEN** the response is not cached

#### Scenario: Server sends a validator

- **WHEN** a stale entry has an `ETag` and the server answers the revalidation with 304
- **THEN** the cached body is served and its freshness is renewed

### Requirement: Fallback TTL tiers

Responses without caching headers SHALL use a TTL by URL class:

- immutable: 24 hours (event, trace, and trace-item lookups by ID)
- volatile: 60 seconds (issue endpoints, log and span queries)
- no-cache: never cached (autofix and root-cause polling)
- stable: 5 minutes (everything else)

#### Scenario: Event lookup

- **WHEN** an event is fetched by ID without caching headers
- **THEN** the response is reused for up to 24 hours

#### Scenario: Polling endpoint

- **WHEN** autofix state is fetched
- **THEN** the response is never served from cache

### Requirement: Mutations invalidate related entries

A successful non-GET request SHALL invalidate the requesting identity's
cached entries whose URLs fall under the mutated resource's prefixes. Other
identities' entries SHALL be unaffected.

#### Scenario: Resolve then list

- **WHEN** an identity updates an issue and then lists issues within the volatile TTL
- **THEN** the list is fetched from the API, not from cache

### Requirement: Fresh reads bypass the cache

A caller SHALL be able to request a fresh read. A fresh read SHALL fetch
from the API and replace the cached entry. The CLI exposes this as `--fresh`
/ `-f`, and MCP read tools as a `fresh` input.

#### Scenario: MCP fresh read

- **WHEN** an MCP read tool is called with `fresh: true`
- **THEN** every API request made by that call bypasses cached entries

### Requirement: Bounded storage

Each storage backend SHALL enforce a byte budget and a per-entry size cap.
Entries over the cap SHALL not be stored. When the budget is exceeded, the
least recently used entries SHALL be evicted first.

#### Scenario: Oversized response

- **WHEN** a response is larger than the per-entry cap
- **THEN** it is returned to the caller and not stored

#### Scenario: Shared Worker isolate

- **WHEN** many identities fill the in-memory cache of one Cloudflare Worker isolate
- **THEN** total cache memory stays within the configured budget and the isolate does not run out of memory

### Requirement: Compressed entries

Stored entries SHALL be compressed with zstd when the runtime supports it,
and otherwise stored with a supported fallback. Reading an entry SHALL
return a body identical to the original response body.

#### Scenario: Runtime without zstd

- **WHEN** the CLI runs on a Node.js version without zstd support
- **THEN** caching still works using the fallback encoding

### Requirement: Hosted tiers

The hosted MCP SHALL cache every tier in memory, and SHALL also persist
immutable-tier entries to durable object storage shared across isolates.
Volatile and stable entries SHALL never be persisted outside the isolate.

#### Scenario: Immutable hit in another isolate

- **WHEN** an identity fetches an event in one isolate and later fetches it in another
- **THEN** the second fetch is served from durable storage without calling the API

#### Scenario: Volatile entry

- **WHEN** an issue list is cached on the hosted MCP
- **THEN** it exists only in that isolate's memory
