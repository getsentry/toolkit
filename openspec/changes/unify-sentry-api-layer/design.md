# Design

## Context

See proposal.md for motivation. Current state that shapes the approach:

- **Dependency direction.** `packages/cli` depends on `@sentry/mcp-server`
  (`workspace:*`), and its build compiles `mcp-core` and `mcp-server` first.
  `cli/src/lib/mcp.ts` already passes credentials into `runMcpServer()`
  through `resolveAccessToken` and `onUpstreamUnauthorized`. Shared code
  must therefore live below both products, in `toolkit-core`.
  The stdio server is moving into the CLI as `sentry mcp`, after which the
  CLI depends on `mcp-core` directly and `@sentry/mcp-server` becomes a
  dependency-free bundle of that same server, built from CLI source.
- **CLI request stack.**
  - `sentry-client.ts` handles auth, refresh on 401, timeouts, GET retries,
    redirect validation, and custom headers.
  - `response-cache.ts` caches responses as JSON files under
    `~/.sentry/cache/responses/`, using `http-cache-semantics`, an HMAC
    identity key, TTL tiers, and a 500-entry cap. Its 24-hour "immutable"
    tier matches any `/events/<id>/`, `/trace/<32 hex>/`, or
    `/trace-items/<id>/` URL, and is checked before the `/issues/` volatile
    pattern, so `/issues/<id>/events/latest/` is cached for 24 hours too.
  - `api/infrastructure.ts` has `paginate()` and `fetchAllPages()`, with
    mid-page skip counts encoded in the cursor's `is_prev` field.
- **MCP request stack.** `mcp-core/src/api-client/client.ts` has about 105
  methods and hits 91 distinct endpoint paths. It owns its own
  `request`/`requestOnce`, does GET-only gateway retries, validates with Zod,
  and has no response cache. Against `@sentry/api@0.404.0`, about 67 of
  those paths have generated operations; the rest are missing, mainly
  legacy alert rules, uptime, monitor stats, issue activities/notes/user
  reports, the search agent, and event committers.
- **Workers runtime.**
  - 128 MB memory per isolate, and one isolate serves many users at once.
  - No persistent filesystem.
  - `nodejs_compat` is enabled: `AsyncLocalStorage`, `node:crypto`, and
    `node:zlib` are available.
  - `node:zlib` zstd works under the current compatibility date
    (`2025-03-21`) in local workerd, verified with `wrangler dev` 4.151.3.
    Cloudflare's docs list only gzip, deflate, and brotli, so this must be
    confirmed on a deployed preview.
  - `CompressionStream` has no zstd.
- **`@sentry/api` already has** `fetchPage_*`, `paginateAll_*`, and
  `paginateUpTo_*` helpers, plus `./zod`, `./valibot`, and `./browser`
  entry points. Its `paginateUpTo` drops `nextCursor` when trimming a page
  would make continuing unsafe. The CLI's skip-count cursor closes exactly
  that gap.

## Goals / Non-Goals

**Goals:**

- One implementation of pagination, cache policy, and transport, used by
  the CLI, `sentry mcp`, and the hosted MCP.
- One Sentry API client, with endpoint wrappers, errors, and validation, in
  place of the MCP's `SentryApiService` and the CLI's API modules. It lives
  in `toolkit-core` first and in `@sentry/api` after step 2.
- Shared modules run unchanged in Node, Workers, and browsers, using only
  web-standard APIs, so the Sentry frontend can use the published client.
- No CLI behavior change while its internals move, apart from the cache
  tier correction, which lands first as its own PR.

**Non-Goals:**

- Client-side caching in the Sentry frontend. Browser HTTP caching driven
  by server headers covers that (getsentry/sentry#128818).
- Calling `createSentrySDK()` from the hosted MCP. It is Node-only. The
  hosted MCP reaches the CLI's operations through the portable `sentry/mcp`
  entry instead (see "MCP tools are a portable face of the CLI's
  commands"), in a later phase after step 2 (task group 11).
- Moving the hosted MCP off Cloudflare Workers, or making the CLI serve
  more than one user.
- Replacing every hand-written response schema with a generated one, or
  moving either product to the other's validation library.

## Decisions

### Narrow the CLI's cache tiers before moving them

The getsentry/sentry#128818 spike (findings in
[this comment](https://github.com/getsentry/sentry/issues/128818#issuecomment-6426889162),
checked against sentry `06a3bc41dda`) found that none of the "immutable"
endpoints are safe to mark `immutable`:

- **Project and issue event details** embed `nextEventID`,
  `previousEventID`, user reports, and release data, all of which change
  later. Reprocessing and issue merges can change the response for the same
  event ID. `latest`, `oldest`, and `recommended` resolve to different events
  over time.
- **Full traces** gain spans as they arrive.
- **Organization event details** (excluding `?averageColumn`, which reads
  live aggregates) and **project trace-item details** (excluding
  superuser/staff requests and `?debug`) are stable enough for
  `Cache-Control: private, max-age=300`. The prototype in
  getsentry/sentry#128828 sends exactly that, off by default, with
  `Vary: Origin, Cookie, Authorization`.
- Every endpoint can still change visibility: deletion and access
  revocation are not reflected until the entry expires. That bounds the TTL,
  not just the tier.

So the CLI drops `immutable` (getsentry/toolkit#1681):

| Tier     | TTL  | Matches                                                                                                                                 |
| -------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------- |
| no-cache | 0    | autofix and root-cause polling                                                                                                          |
| volatile | 60 s | `/issues/` (including issue events), `/projects/{org}/{project}/events/{id}/`, `/organizations/{org}/trace/{id}/`, log and span queries |
| stable   | 5 m  | everything else, including organization event details and trace-item details                                                            |

- No separate tier for the safe detail endpoints. In the CLI it would have
  the same TTL as `stable`, so it was folded in during review. Which
  responses the hosted MCP may persist to R2 is a decision for that store,
  made with its own allowlist (see the R2 backend below), not a TTL tier.
- When server headers are present they still win. The CLI keeps honoring
  `max-age`, so if the server later extends it, the CLI follows without a
  release.
- Classification stays URL-regex based for now. A TODO in
  `response-cache.ts` tracks moving it to generated `@sentry/api` operation
  metadata (getsentry/sentry-api-schema#81, #102).
- This landed as its own CLI PR before the move into `toolkit-core`, so the
  move itself stays a no-behavior-change refactor.

The cost is more API calls for repeated event and trace reads. A 24-hour
window was a correctness bug, not a tunable: an agent re-reading an issue's
latest event an hour later got the wrong event.

### Shared code lives in `toolkit-core`, behind injected dependencies

New `toolkit-core` modules:

- `pagination`: `paginate`, `fetchAllPages`, cursor encode/decode, and page
  sizing. Pure logic. Errors come back as typed results, and the host maps
  them to its own error classes.
- `response-cache`: the cache policy. Covers tier classification, key
  derivation, invalidation prefixes (from `cli/src/lib/cache-keys.ts`), and
  freshness through `http-cache-semantics`. Storage sits behind a
  `CacheStore` interface.
- `api-retry`: the retry policy. Pure logic with no Node APIs, so Workers
  can use it. It lands first, ahead of the transport, so the MCP can fix
  its 429 handling now.
- `api-transport`: a fetch wrapper that takes a `CredentialProvider` (get the
  token, refresh on 401), an optional `CacheStore`, a logger, a span hook,
  and retry/timeout options. Retries go through `api-retry`. Redirect
  validation and region routing move with it.

Product code keeps credential storage, error classes, user-facing
messages, and telemetry setup.

_Alternative: a new package._ Rejected for now. `toolkit-core` is already
the bundled-private shared package, and a split can come later when moving
code into `@sentry/api`.

### Retries replay only requests that cannot repeat a write, and honor rate-limit headers

Neither product handles 429s well today. The CLI retries every method on
408, 429, and 5xx, POSTs included, and ignores rate-limit headers. The MCP
retries only GETs on 502, 503, and 504, so a 429 fails at once. In 7 days
the hosted MCP saw about 32,600 429s from the Sentry API, nearly all on GETs
("Limit is 40 requests in 1 seconds").

Sentry's 429 body is only `{"detail": ...}`. The timing is in headers:
`X-Sentry-Rate-Limit-Reset` is the Unix second the next window starts, with
`-Remaining`, `-Limit`, `-ConcurrentRemaining`, and `-ConcurrentLimit`
alongside (`src/sentry/middleware/ratelimit.py`). Sentry sends no
`Retry-After`, but a proxy in front of it can.

`api-retry` decides whether and how long to wait:

- The retried statuses are 429, 500, 502, 503, and 504. The other 5xx codes,
  such as 501 and 505, are deterministic, so they are not retried.
- A 429 is retried for any method. `RatelimitMiddleware.process_request`
  rejects it before the view runs, so replaying it cannot repeat a write.
- A 5xx, a timeout, or a network error may come after the endpoint ran. Those
  are retried only for GET, HEAD, and OPTIONS, unless a request opts in with
  `idempotent: true`. A replayed write can duplicate a comment or an alert.
- `Retry-After` wins when present. Otherwise a 429 waits until
  `X-Sentry-Rate-Limit-Reset`. The delay is kept within the range the response
  `Date` allows, so a skewed local clock moves it by at most a second.
- A concurrency-limit 429 (`ConcurrentRemaining: 0`) and a response with no
  usable header fall back to jittered exponential backoff.
- Each product sets a per-wait and a total-wait cap. When the header asks for
  longer, the request fails at once with a rate-limit error that says when
  to retry, rather than holding a Worker request open.
- Sleeps take an `AbortSignal`.

The 401 refresh is not a retry in this sense. It replays any method once,
because the request never reached the endpoint.

### `CacheStore` is three byte-based operations

```ts
interface CacheStore {
  get(key: string): Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry, ttlMs: number): Promise<void>;
  deleteMatching(identity: string, urlPrefix: string): Promise<void>;
}
```

`CacheEntry` stores the compressed body bytes plus metadata: URL, identity,
tier, encoding, serialized cache policy, and size. Every backend enforces a
byte budget and a per-entry cap, not an entry count.

Backends:

- **Filesystem (CLI).** Keeps today's on-disk layout and adds compression.
  It moves from a 500-entry cap to a byte budget, with the default set so
  current users see a similar footprint.
- **Memory (hosted MCP, tests).**
  - LRU limited by bytes, counted over compressed bytes.
  - Default budget 24 MB per isolate and a 1 MB per-entry cap on compressed
    size, configurable by env.
  - Module-scoped, so it lives as long as the isolate. `deleteMatching`
    scans the in-memory index.
- **R2 (hosted MCP, allowlisted detail endpoints only).**
  - Persists an entry only when its URL matches the store's explicit
    allowlist _and_ the response carries `Cache-Control: private` with a
    positive `max-age`. The allowlist holds exact path shapes:
    `/organizations/{org}/events/{project}:{event_id}/` without
    `averageColumn`, and `/projects/{org}/{project}/trace-items/{id}/`
    without `debug`. The server header is the opt-in: until
    getsentry/sentry#128828 ships and is enabled, R2 stores nothing.
  - Today the CLI and MCP read events through project and issue endpoints,
    which are not on the allowlist. So in practice R2 covers trace items
    until a caller moves to the organization event endpoint, which is worth
    doing per call site only where the response has every field the caller
    uses.
  - Object key is `<identity>/<sha256(normalized URL)>`, with the expiry,
    the lesser of the server `max-age` and 5 minutes, in custom metadata and
    checked on read.
  - A bucket lifecycle rule deletes objects after 1 day, the shortest rule
    R2 supports. It is garbage collection only; reads enforce the expiry.
  - Writes happen in `ctx.waitUntil()`, so they never delay a response.
  - Allowlisted entries are never targeted by mutation invalidation, so R2
    never needs `deleteMatching`. The short expiry bounds how long a revoked or
    deleted item can still be served.

_Alternatives:_

- **Workers KV.** Rejected because it is eventually consistent, which
  breaks invalidation after mutations.
- **D1.** A good fit for prefix deletes, but it has a single primary region,
  is single-threaded, and limits rows to 2 MB. Deferred until hit-rate data
  says stable-tier sharing across isolates is worth it.
- **Durable Objects per user.** Deferred for the same reason.

### Composite store for hosted

`TieredStore(memory, r2)`:

- `get` checks memory first, then R2 for allowlisted URLs, and copies R2
  hits into memory with the remaining expiry.
- `set` writes to memory, and also to R2 when the entry is R2-eligible (see
  above).
- `deleteMatching` only touches memory, since only volatile and stable
  entries are ever invalidated.

### Identity

The identity string is an HMAC input. It is never a raw token, and it stays
stable across token refresh.

- **CLI:** keeps `getIdentityFingerprint()`, which hashes the refresh token
  for OAuth logins.
- **Hosted:** hashes the user ID and grant ID taken from the MCP wrapper
  bearer token (`userId:grantId:secret`, parsed in
  `mcp-cloudflare/src/server/lib/mcp-handler.ts`).
- **Standalone MCP with a static token:** hashes the token.

Key derivation uses WebCrypto (`crypto.subtle`) HMAC-SHA256 instead of
`node:crypto`, so the module also runs in browsers. This makes key
derivation async. The cache API is already async, so no call sites change
shape.

### Compression: plain zstd now, trained dictionary as a follow-up

Benchmarked on Node 22 with real API responses from Sentry's own
organization. The samples were kept in the sandbox and not committed:

- 255 responses from one project (events, issue details, issue lists,
  traces, logs, spans, projects, teams), split 70/30 into training and test
  sets.
- 90 responses from five other projects (Android, Node, Next.js, Rust,
  Python) as a cross-project check.

Ratios are total raw bytes divided by total compressed bytes, with each
response compressed on its own, the way the cache stores entries:

| Codec                              | Same project, ≤1 MB | Other projects | >256 KB (traces) | Compress, ms/MB | Decompress, ms/MB |
| ---------------------------------- | ------------------- | -------------- | ---------------- | --------------- | ----------------- |
| zstd-3                             | 8.7x                | 6.3x           | 37x              | 1.6             | 1.2               |
| zstd-9                             | —                   | —              | 45x              | 5.6             | 0.9               |
| zstd-3 + trained 110 KB dictionary | 17.0x               | 7.6x           | 37x              | 2.0             | 0.8               |
| brotli-4                           | 9.3x                | 6.6x           | 42x              | 3.0             | 0.6               |
| brotli-6                           | —                   | —              | 45x              | 5.7             | 0.8               |
| brotli-11                          | —                   | —              | 49x              | 775             | 2.3               |
| gzip-6                             | —                   | —              | 30x              | 3.9             | 0.8               |

Findings:

- **Brotli is not the better target.**
  - At the same CPU, zstd-9 and brotli-6 tie.
  - brotli-4 beats zstd-3 by 5–12% but costs about 2x the compression CPU.
  - Brotli's best ratio, quality 11, costs about 500x the CPU of zstd-3.
  - `node:zlib` brotli has no custom dictionary support.
- **A trained dictionary is the big lever for small and medium responses,
  which are most entries by count.** On the same project it doubled the
  overall ratio (8.7x → 17.0x), and below 16 KB it went from 3.4x to 9.8x.
  On other projects the gain shrank to about 20% (6.3x → 7.6x). The
  dictionary had learned project-specific values (paths, function names,
  slugs), not just JSON keys. It did nothing for large traces.
- **Dictionaries built from public data did not help.** One trained on the
  repo's mock fixtures, and one trained on response skeletons with all values
  blanked, stayed at about 3.4–3.8x for small responses. The gain comes from
  real values.
- **Workers ignores `dictionary`.** Local workerd (`wrangler dev` 4.151.3)
  accepts the `dictionary` option on `zstdCompressSync` but silently ignores
  it: output is byte-for-byte the same size as without a dictionary. Node 22
  honors it (5.3 KB issue: 1,819 → 632 bytes).
- **The per-entry cap must apply to compressed size.** Traces in this
  sample had a median of 1.5 MB raw (max 14 MB), but compress 37–45x. A cap on
  raw size would make most traces impossible to cache.

Decisions:

- **zstd level 3 everywhere, no dictionary.** One codec setting for the
  CLI disk, the hosted memory tier, and R2.
  - It runs on the response path and is charged as Worker CPU time.
  - zstd-9 only helps large traces (37x → 45x) at 3.5x the compression
    CPU. With R2 entries now living at most 5 minutes, an entry is read
    only a few times, so the extra CPU does not pay back.
  - A single level keeps entries portable between tiers: an R2 hit is
    copied into memory without recompressing.
- **Fallback: brotli quality 4 via `node:zlib`, then uncompressed.** The CLI
  supports Node.js 20+, which lacks zstd, so the codec is detected at
  runtime, the way `api/infrastructure.ts` already detects `zstdCompress`.
- **Small bodies:** stored uncompressed below 256 bytes.
- **Per-entry cap on compressed size**, plus a raw-size ceiling (default
  32 MB) that bounds memory spikes during decompression.
- **Encoding recorded per entry.** `encoding` and `dictId` are recorded per
  entry, so mixed entries stay readable after upgrades and dictionary
  rotations.
- **Dictionary support is a follow-up (task group 10), gated on three
  checks:**
  1. **Training data safety.** A dictionary embeds verbatim strings from its
     training data, so one trained on customer or internal data must never
     ship in a public package (`sentry`, `@sentry/mcp-server`). Options:
     - train on a public demo organization
     - train per deployment, for example the hosted MCP from its own cache
       contents within an organization
  2. **Workers support.** Use a WASM zstd build for dictionary compression,
     or wait for workerd to honor the option. A startup self-test compresses
     a known sample and checks that the dictionary took effect, so a silently
     ignored option is caught.
  3. **A broader benchmark** across many organizations and projects before
     committing to dictionary size and rotation.

Compression saves memory and storage, not CPU. A cache hit costs
decompression instead of JSON from the network, and on Workers the network
wait is not billed CPU. Its job is to fit more entries into the budget.

### Two steps: consolidate in `toolkit-core`, then move into `@sentry/api`

Everything `SentryApiService`-like ends up in `@sentry/api`, so the CLI,
both MCP servers, and the Sentry frontend share one client. Doing that
directly would mean designing the shared API inside sentry-api-schema while
the code that defines it still lives in toolkit, with a publish round trip
for every fix. So:

1. **Step 1, in `toolkit-core` (task group 8).** Build the shared client in
   `toolkit-core/src/api-client/`, with the file layout it will have inside
   `@sentry/api`. Switch the MCP and the CLI onto it and delete the code it
   replaces, in stacked PRs by layer rather than by domain (see below).
2. **Step 2, into `@sentry/api` (task group 9).** Copy the modules into
   getsentry/sentry-api-schema unchanged, publish a new `@sentry/api`,
   switch toolkit's imports, and delete the toolkit-core copies.

Step 1 ships nothing a user can see, apart from changes called out in its
PR. It makes step 2 a copy, not a redesign.

### The shared client

`toolkit-core/src/api-client/` holds:

- **Core:** building URLs for a region, setting headers, reading responses,
  and mapping error responses to errors. Requests go through the shared
  transport, so there is one retry layer.
- **Errors:** `ApiError` with the status and the server's detail, and the
  rate-limit error with `retryAfterMs` from `Retry-After` or
  `X-Sentry-Rate-Limit-Reset`. Hosts map them to their own presentation:
  CLI exit codes and messages, MCP tool results.
- **Validation:** library-agnostic, through the
  [Standard Schema](https://standardschema.dev) interface
  (`@standard-schema/spec`), which Zod and valibot both implement. Shared
  code depends only on that interface's types, vendored or type-only, and
  never on Zod or valibot at runtime. Each wrapper validates with a schema
  the host passes in, so the host's schema decides the result type: the
  MCP keeps Zod (`@sentry/api/zod` where it covers the endpoint), which
  suits long-running servers and is the more widespread library, and the
  CLI keeps valibot (`@sentry/api/valibot`), which suits short-lived
  processes where startup and bundle size matter. Validation failures
  surface as one shared error type with the issues from the Standard
  Schema result.
- **Pagination, cache policy, retry policy, and transport:** the existing
  `pagination`, `response-cache` policy, `api-retry`, and `api-transport`
  modules, which move with it in step 2.
- **Endpoints by domain:** organizations, projects, teams, issues, events,
  explore, traces, logs, releases, replays, monitors, alerts, and so on, on
  top of `@sentry/api` operations where they exist and the shared transport
  otherwise. Where both products call the same endpoint, they call the same
  wrapper.

Hosts keep:

- **CLI:** credential storage and refresh, the SQLite and filesystem cache
  store, region lookup storage, telemetry spans, and mapping errors to exit
  codes.
- **MCP:** the session's access token, its Zod-to-tool output formatting, and
  the request-scoped `fresh` flag.
- **Browser:** session credentials, and no cache store, since browser HTTP
  caching driven by server headers covers it.

### Portable shared code, enforced

The shared client imports only `@sentry/api` and the toolkit-core modules
that move with it. It uses only web-standard APIs (`fetch`, `Request`,
`Response`, `Headers`, `URL`, `AbortSignal`, `crypto.subtle`,
`TextEncoder`), so it runs in Node, Workers, and browsers. It never imports
`node:*` or uses `Buffer`, `fs`, `process`, or `AsyncLocalStorage`.

Credentials, cache storage, the fresh-read scope, logging, and telemetry are
interfaces. Each host passes its own implementation.

Two checks keep it that way:

- A lint rule on the shared modules bans `node:*` imports and Node globals.
- A typecheck of the shared modules against the DOM library, with no Node
  types, catches the rest, such as `NodeJS.Timeout` types.

The cache codec uses `node:zlib`, which Node and Workers have and browsers do
not. It is storage, so it stays a host-side module outside the guarded set
and does not move in step 2.

### MCP tools are a portable face of the CLI's commands

The hosted MCP stays on Cloudflare Workers, and the CLI stays a local,
single-user tool. Neither changes. So the CLI owns the operations and the
MCP tool definitions, and the part the hosted MCP needs is portable:

```
sentry (cli)
  commands/     Node: resolve inputs from the cwd, config, and DSN; render for the terminal
  operations/   portable: one function per command; calls the shared client, returns typed data
  mcp/          portable: MCP tool definitions over operations, with the agent renderer
sentry mcp      stdio composition root: mcp/ plus the CLI's host capabilities
mcp-cloudflare  bundles sentry's portable `sentry/mcp` entry; supplies OAuth, KV, and its cache
```

Each command splits into three layers:

- **Resolve** is host-specific. The CLI fills organization, project, and
  defaults from the cwd, its config, DSN detection, and SQLite. An MCP tool
  fills them from tool parameters and session constraints.
- **Operate** is portable. It takes resolved inputs and an `ApiTarget` from
  the shared client, and returns the data the command yields today as
  `CommandOutput<T>`.
- **Render** has three modes: the command's `output.human` for the
  terminal, JSON for `--json` and the SDK, and an agent renderer for MCP.
  Commands already yield `CommandOutput<T>` and declare `output: { human }`
  (`cli/src/lib/command.ts`), so the MCP renderer is a third output mode,
  not a rewrite.

Commands are async generators, and some yield more than once. An MCP tool
buffers the yields and returns one result, as `createSentrySDK()` already
does when it collects multiple yields into an array
(`cli/src/lib/sdk-invoke.ts`). Commands with unbounded streams, the
follow and tail flags `sdk-invoke.ts` already detects, are not exposed as
MCP tools, or only in a bounded form.

`operations/` and `mcp/` get the same portability guard as the shared
client: no `node:*` imports or Node globals, and a typecheck against the
DOM library. The CLI package exposes them as a separate entry point,
`sentry/mcp`, so `mcp-cloudflare` bundles them without command handlers,
SQLite, or Ink. `createSentrySDK()` stays Node-only, and the hosted MCP does
not call it.

Package dependencies:

```
sentry → mcp-core → toolkit-core (→ @sentry/api)
mcp-cloudflare → sentry/mcp (portable entry only), mcp-core
```

`mcp-core` keeps the MCP plumbing: tool registration, the stdio transport,
scopes and constraints, and shared formatting helpers. It holds no Sentry
operations and never imports `sentry`. As tools move to `sentry/mcp`, their
`mcp-core` copies are deleted, and the MCP evals (`mcp-server-evals`) guard
the agent output.

Capabilities only the CLI host has stay optional interfaces:

- the SQLite response cache store
- the region cache
- DSN detection from local files
- file uploads

`sentry mcp` injects the CLI's implementations. `mcp-cloudflare` injects
its own, such as the memory cache store, or omits them, and tools that
need a missing capability say so or stay unavailable.

Two checks enforce the direction. The PR that moves the stdio server into
`sentry mcp` (#1731)
adds a lint rule that bans importing `sentry` from `mcp-core` and
`mcp-cloudflare`, type-only imports included, and a manifest check that
fails on a workspace dependency cycle. When tools move, the rule is relaxed
to let `mcp-cloudflare` import `sentry/mcp` and nothing else from `sentry`.

### `@sentry/mcp-server` is a slim bundle of `sentry mcp`

`@sentry/mcp-server` is kept, not retired. The CLI has grown large, and a
client that only needs Sentry's tools over stdio should not have to
download it. The package ships the same server as `sentry mcp`, bundled
from CLI source into one file with no runtime dependencies (#1731):

- One implementation serves both, so the package keeps the same flags,
  tools, CLI session, and self-hosted support as `sentry mcp`.
- The bundle leaves out what does not serve the MCP server: CLI commands,
  the markdown renderer, agent skills, completions, terminal images, the
  Ink UI, debug-file processing, and the SQLite WASM fallback. Without the
  fallback, the package requires Node.js 22.15 or later. The bundle script
  fails if any of these reach the output or the file grows past its size
  budget.
- `sentry-mcp auth login` runs the CLI's device flow with plain-text
  output. Other account management stays in `sentry auth`, which reads the
  same session.
- When the tools move into the CLI's `sentry/mcp` entry, the bundle picks
  them up from the same source with no package change.
- `sentry mcp` stays the canonical server and owns the MCP registry entry
  (`server.json`).

A stdio proxy to the hosted MCP was considered and rejected (#1743): it
cannot reach self-hosted Sentry, and it would be a second implementation
to keep in step.

### `fresh` is a shared read-tool input

Read-only tools gain an optional `fresh: boolean`, defined once in the
shared tool schema helpers. The MCP tool handler sets a request-scoped
bypass with `AsyncLocalStorage`, and the shared transport reads it only
through its `fresh()` callback. The flag is host state: shared code never
touches `AsyncLocalStorage`, which browsers lack. The tool count does not
change. Token cost is checked with `pnpm run measure-tokens`, and the
description stays short.

### Endpoints move in stacked PRs by layer, not by domain

The earlier plan moved MCP methods onto `@sentry/api` one domain per PR.
Issues and events landed that way (#1713). The rest moves in a stack of
step 1 PRs split by layer instead:

1. The foundation: errors, `apiPath`, validation, and response reading
   (#1732).
2. Pagination, cache policy, retry, and transport moved under
   `api-client/`.
3. Endpoint wrappers by domain, with the MCP switched onto them.
4. The CLI host seam, with the CLI switched.
5. One wrapper for each endpoint both products call.

Each PR switches every caller of the layer it moves, so neither product is
left half on the old layer for that layer. Endpoints that `@sentry/api` lacks
call the shared transport directly, and hosts keep their own schemas for
them. Endpoint
behavior is checked against `~/src/sentry`, as `AGENTS.md` requires.

### Version alignment first

Add `@sentry/api` to the pnpm catalog at `0.400.0`, which is already in
`minimumReleaseAgeExclude`, and point both packages at `catalog:`. Later
bumps move both products together.

## Risks / Trade-offs

- **Cross-user leakage on the shared Worker.** Every key includes an
  identity HMAC. There is a test that two identities never share entries
  for the same URL, and R2 keys are prefixed by identity.
- **Stale data in agent answers.** Volatile entries last 60 s, and no entry
  lasts longer than 5 minutes without a server header. There is
  invalidation after mutations, and `fresh` for explicit bypass. The tool
  description tells agents when to use it.
- **Revoked access or deleted data served from cache.** A user who loses
  access to a project, or whose event is deleted, can still get a cached
  copy until it expires: up to 5 minutes for stable entries, including
  from R2 on the hosted MCP. Enabling R2 in production needs a privacy and
  security sign-off on that window, alongside the server-side headers in
  getsentry/sentry#128828.
- **Worker OOM.** The memory store has a byte budget and a per-entry cap.
  Compressed size is what counts. A load test fills the store with many
  identities and checks its peak memory.
- **zstd unavailable in production Workers.** Confirm on a preview deploy
  before relying on it. The brotli fallback keeps caching working either
  way.
- **Transport move regresses the CLI.** The CLI's existing tests run against
  the shared modules unchanged. The move happens one module at a time, and
  each step has no behavior change.
- **Generated `@sentry/api` types disagree with responses.** Keep Zod
  validation at the MCP boundary. Pin and bump `@sentry/api` through the
  catalog.
- **A long stack of PRs.** Each PR waits on the one below it and needs a
  rebase when that one merges. Splitting by layer keeps each PR coherent,
  both products' test suites run against every PR, and each PR body lists
  its intentional behavior changes.
- **Two validation libraries.** The MCP's Zod schemas and the CLI's valibot
  schemas for the same endpoint can drift apart. Standard Schema keeps the
  shared client out of that choice, so neither product pays for the other's
  library, and the CLI keeps valibot off Zod's startup cost. Where
  `@sentry/api` generates both (`./zod` and `./valibot`), hosts use the
  generated schemas, which come from one OpenAPI source.
- **Node-only APIs creep into shared code.** The lint rule and the
  browser-target typecheck fail CI.
- **CLI-issued tokens lack MCP scopes.** The MCP and CLI use different OAuth
  client IDs and scope lists today. When the deferred `sentry mcp` phase is
  picked up, compare them before relying on the CLI session for MCP tools. If they
  differ, widen the CLI's requested scopes.

## Migration Plan

1. Land the catalog alignment (#1672), the CLI cache tier correction, and
   `api-retry` with the MCP 429 fix, each as its own PR.
2. Land the pure `toolkit-core` modules (pagination, cache policy, codecs),
   with the CLI switched over and no behavior change.
3. Land `api-transport` and the CLI switch-over.
4. Land the MCP on the shared transport (#1722), then the hosted memory
   store behind a flag (`MCP_RESPONSE_CACHE=memory`).
5. Enable the hosted memory cache. Add the R2 binding and its allowlist
   behind `MCP_RESPONSE_CACHE=tiered`, and enable it only after the server
   headers ship and the security sign-off.
6. Step 1: land the stacked PRs by layer: the foundation with the
   portability guard, the transport-layer move, the endpoint wrappers with
   the MCP switch, the CLI switch, and the merged shared wrappers.
7. Step 2: copy the client into getsentry/sentry-api-schema, publish
   `@sentry/api`, switch toolkit to it, and delete the toolkit-core copies.
8. Later phase: split CLI commands into resolve, operate, and render; move
   the MCP tools into the CLI's portable `sentry/mcp` entry; and have
   `sentry mcp` inject the CLI's host capabilities (session, cache store,
   region cache, DSN detection, file uploads) while `mcp-cloudflare`
   bundles the same entry. The registry entry moves to `sentry mcp` in
   #1731, and `@sentry/mcp-server` becomes a slim bundle of `sentry mcp`
   (see "`@sentry/mcp-server` is a slim bundle of `sentry mcp`").

**Rollback:** the hosted cache is gated by an env flag, and setting it to
`off` restores today's uncached behavior. Each CLI step is a refactor that
can be reverted on its own.

## Open Questions

- The exact byte budgets (CLI disk, Worker memory) and the per-entry cap.
  To be tuned with hit-rate and memory metrics after launch.
- Whether R2 pays off with a 5-minute window. Cross-isolate hits only help
  when the same identity re-reads the same event or span within minutes,
  which agents often do, but metrics will decide whether the R2 tier stays.
- Whether the server should send `private, max-age` on more endpoints
  later, such as stable organization and project metadata. The CLI follows
  server headers automatically; R2 eligibility stays an explicit allowlist.
