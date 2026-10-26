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

- detail: 5 minutes (organization event details and project trace-item
  details, by exact path)
- volatile: 60 seconds (issue endpoints, project event details, full
  traces, log and span queries)
- no-cache: never cached (autofix and root-cause polling)
- stable: 5 minutes (everything else)

#### Scenario: Organization event lookup

- **WHEN** `/organizations/{org}/events/{project}:{event_id}/` is fetched without caching headers
- **THEN** the response is reused for up to 5 minutes

#### Scenario: Live aggregate on an event

- **WHEN** an organization event detail is fetched with an `averageColumn` query
- **THEN** it is classified as stable, not detail

#### Scenario: Trace-item debug lookup

- **WHEN** a project trace-item detail is fetched with a `debug` query
- **THEN** it is classified as stable, not detail

#### Scenario: Issue event lookup

- **WHEN** an issue's latest, oldest, recommended, or specific event is fetched without caching headers
- **THEN** the response is reused for at most 60 seconds

#### Scenario: Full trace lookup

- **WHEN** a full trace is fetched by trace ID without caching headers
- **THEN** the response is reused for at most 60 seconds, since spans can still arrive

#### Scenario: Polling endpoint

- **WHEN** autofix state is fetched
- **THEN** the response is never served from cache

### Requirement: No immutable fallback

No URL class SHALL treat a response as immutable. Without server caching
headers, no response SHALL be reused for longer than 5 minutes.

#### Scenario: Event re-read after an hour

- **WHEN** any event or trace URL was cached without server headers more than 5 minutes ago
- **THEN** the next read fetches from the API

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

Each storage backend SHALL enforce a byte budget over stored bytes. It SHALL
enforce a per-entry cap on stored (compressed) size and a ceiling on raw
size. Entries over either limit SHALL not be stored. When the budget is
exceeded, the least recently used entries SHALL be evicted first.

#### Scenario: Oversized response

- **WHEN** a response's compressed size is larger than the per-entry cap
- **THEN** it is returned to the caller and not stored

#### Scenario: Large but compressible response

- **WHEN** a 5 MB trace compresses below the per-entry cap and its raw size is under the ceiling
- **THEN** it is stored

#### Scenario: Shared Worker isolate

- **WHEN** many identities fill the in-memory cache of one Cloudflare Worker isolate
- **THEN** total cache memory stays within the configured budget and the isolate does not run out of memory

### Requirement: Compressed entries

Stored entries SHALL be compressed with zstd at level 3 when the runtime
supports it, and otherwise stored with a supported fallback. Each entry SHALL record its
encoding. Reading an entry SHALL return a body identical to the original
response body.

#### Scenario: Runtime without zstd

- **WHEN** the CLI runs on a Node.js version without zstd support
- **THEN** caching still works using the fallback encoding

### Requirement: Hosted tiers

The hosted MCP SHALL cache every tier in memory. It SHALL persist an entry
to durable object storage shared across isolates only when the entry is in
the detail tier and the response carries a server `Cache-Control` with
`private` and a positive `max-age`. A persisted entry SHALL expire at the
lesser of the server `max-age` and 5 minutes. Volatile and stable entries
SHALL never be persisted outside the isolate.

#### Scenario: Detail hit in another isolate

- **WHEN** an identity fetches an organization event detail that carries `Cache-Control: private, max-age=300` in one isolate, and fetches it again in another isolate within 5 minutes
- **THEN** the second fetch is served from durable storage without calling the API

#### Scenario: Detail response without server headers

- **WHEN** a detail-tier response carries no server caching headers
- **THEN** it is cached in that isolate's memory only

#### Scenario: Volatile entry

- **WHEN** an issue list is cached on the hosted MCP
- **THEN** it exists only in that isolate's memory
