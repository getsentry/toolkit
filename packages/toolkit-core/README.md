# Toolkit core

Pure protocol and hostname helpers shared by the CLI and MCP. Both product
builds bundle this private workspace package into their artifacts.

The shared code validates and formats upstream bearer tokens, assembles Sentry
API URLs, constructs OAuth device-flow form bodies, classifies RFC 8628 polling
responses, advances retry intervals, decides when a Sentry API request may
be retried and how long to wait (`api-retry`), recognizes Sentry hostnames and
credential-safe SaaS HTTPS origins, encodes API path identifiers, parses Events
field expressions the way the Sentry frontend does, parses search queries with
the Sentry frontend grammar, resolves Events endpoint sorts so the sort column
is always selected, and deduplicates in-flight region lookups. Each product
retains its own credential storage, regional cache identity and persistence,
host allowlists, routing, polling
deadline, HTTP transport, response validation, and user-facing errors.

## Pagination

`pagination` walks Sentry list endpoints up to a row limit. `paginate` splits
the limit evenly over the fewest requests (at most 100 rows each), reuses the
page size a page-number cursor encodes, and returns a cursor that resumes at
the first row the caller has not received, even when the walk stopped inside
a page. Those cursors are still valid Sentry cursors: the rows already
returned are written into the `is_prev` field in a form Sentry reads as 0, so
the API and older CLIs accept them. `fetchAllPages` reads every page or
reports why it could not (an invalid page, a repeated cursor, or the page
cap), for callers whose result a mutation depends on.

The module does no I/O. The caller fetches each page, validates rows, sets
the page cap, receives warnings, and turns failures into its own errors. The
CLI's `paginate` and `fetchAllPages` in
`packages/cli/src/lib/api/infrastructure.ts` are thin wrappers over it.

## Response cache

`response-cache` holds the cache policy for Sentry API GET responses.
`classifyUrl` puts a URL in a fallback TTL tier for responses without HTTP
caching headers: `volatile` (60 seconds) for issues, project event details,
full traces, and log and span queries; `no-cache` for autofix and root-cause
polling; and `stable` (5 minutes) for everything else. No tier keeps a
response longer than 5 minutes. `buildCacheKey` derives a key from the
requesting identity, the method, and the full URL with sorted query params,
as a WebCrypto HMAC-SHA256 that matches the CLI's earlier `node:crypto` keys.
`computeInvalidationPrefixes` lists the URL prefixes a successful mutation
makes stale.

`storeResponse` and `lookupResponse` make the HTTP caching decisions through
`http-cache-semantics`. Server `Cache-Control` directives win over the tiers,
including `max-age=0`; the tier applies only when the server sent none. Only
2xx JSON responses are stored, and `no-store` is honored. A stale entry with an
`ETag` comes back from `lookupResponse` as `stale`, with the `If-None-Match`
header to send; a matching 304 passed to its `revalidate` renews the entry and
returns the cached body. Entries are kept for their freshness lifetime, plus
`REVALIDATION_WINDOW_MS` (24 hours) when they have an `ETag`. Both take the
`CacheStore` and body codec to use, and throw for unreadable entries so the
host can drop them.

The host supplies an identity that is a stable hash of the login (never a raw
token), derives the key, decides when caching is enabled, records telemetry,
and deletes only the requesting identity's entries under each invalidation
prefix. The CLI's disk cache in `packages/cli/src/lib/response-cache.ts` uses
it.

Entries live in a `CacheStore`: `get`, `set` with a TTL, and
`deleteMatching(identity, urlPrefix)`. An entry holds a body already encoded
by `response-cache/codec`, plus its URL, identity, tier, status, headers, and
serialized cache policy. `createMemoryStore` is a store with a byte budget
(default 24 MiB), evicting the least recently used entries first. It skips
bodies over a per-entry cap on compressed size (default 1 MiB) or a ceiling on
original size (default 32 MiB), and charges a flat 1 KiB per entry for
metadata, so many small entries cannot outgrow the budget.

`response-cache/codec` compresses cached bodies with `node:zlib`: zstd level 3
where the runtime has it (Node 22.15+, Workers with `nodejs_compat`), brotli
quality 4 otherwise, and no compression below 256 bytes. Each entry records
its encoding and original size; `decode` returns `undefined` for an entry this
runtime cannot read, such as zstd on older Node, so the caller treats it as a
miss. It is a separate entry point so the policy above stays free of Node
APIs.

## Resource identity

The `resource-identity` types describe the identifiers shared by organization,
project, team, and issue responses. CLI overlays retain SDK-derived string IDs;
MCP schemas accept numeric IDs too and check their parsed outputs against these
types. Each product keeps its own response validation.

## Search syntax

Search queries are parsed with
[`@sentry/search-syntax`](https://www.npmjs.com/package/@sentry/search-syntax),
the Sentry frontend's own grammar and structural parser, published from
[`static/packages/search-syntax`](https://github.com/getsentry/sentry/tree/master/static/packages/search-syntax)
in getsentry/sentry. Grammar changes and their tests (including the
`fixtures/search-syntax` cases shared with `event_search.py`) live there.

`search-query` uses that parser to rewrite queries the API would reject:
explicit `AND` is dropped, and `OR` on one key becomes an in-list. With
`issueSearch: true` it also turns `is:` OR groups into `status:[…]` or
`substatus:[…]` and unwraps parentheses, which the issues endpoint doesn't
support. It returns the rewrite notes and throws `SearchQueryError` for
anything it can't rewrite; each product decides how to report them.
