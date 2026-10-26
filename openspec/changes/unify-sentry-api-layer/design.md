# Design

## Context

See proposal.md for motivation. Current state that shapes the approach:

- **Dependency direction.** `packages/cli` depends on `@sentry/mcp-server`
  (`workspace:*`), and its build compiles `mcp-core` and `mcp-server` first.
  `cli/src/lib/mcp.ts` already passes credentials into `runMcpServer()`
  through `resolveAccessToken` and `onUpstreamUnauthorized`. Shared code
  must therefore live below both products, in `toolkit-core`.
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
- Shared modules run unchanged in Node and Workers, and avoid
  Node-only APIs where a web standard exists, so they can later move into
  `@sentry/api` and run in the browser.
- No CLI behavior change while its internals move, apart from the cache
  tier correction, which lands first as its own PR.

**Non-Goals:**

- Client-side caching in the Sentry frontend. Browser HTTP caching driven
  by server headers covers that (getsentry/sentry#128818).
- Using `createSentrySDK()` from the MCP.
- Moving code into `@sentry/api` in this change.
- Replacing MCP Zod response validation with generated schemas everywhere.
  That happens per domain where `@sentry/api/zod` covers the endpoint.

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

So the shared policy replaces `immutable` with `detail`:

| Tier     | TTL  | Matches                                                                                                                                    |
| -------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| no-cache | 0    | autofix and root-cause polling                                                                                                             |
| detail   | 5 m  | `/organizations/{org}/events/{project}:{event_id}/` without `averageColumn`; `/projects/{org}/{project}/trace-items/{id}/` without `debug` |
| volatile | 60 s | `/issues/` (including issue events), `/projects/{org}/{project}/events/{id}/`, `/organizations/{org}/trace/{id}/`, log and span queries    |
| stable   | 5 m  | everything else                                                                                                                            |

- Patterns are exact path shapes, anchored on the API prefix, not
  substring matches on `/events/`. Anything that does not match an
  allowlisted shape falls through to volatile or stable.
- `detail` has the same TTL as `stable` in the CLI. It exists as its own
  tier because it is the only tier eligible for R2 on the hosted MCP.
- Today the CLI reads events through project and issue endpoints
  (`getEvent`, `getLatestEvent` in `cli/src/lib/api/events.ts`), and the MCP
  through `/organizations/{org}/issues/{id}/events/{event_id}/`. So in
  practice the detail tier covers trace items until a caller moves to the
  organization event endpoint. That is worth doing per call site only where
  the response has every field the caller uses.
- When server headers are present they still win. The CLI keeps honoring
  `max-age`, so if the server later extends it, the CLI follows without a
  release.
- This lands as its own CLI PR before the move into `toolkit-core`, so the
  move itself stays a no-behavior-change refactor. The existing
  `response-cache.property.test.ts` cases that assert 24-hour event and
  trace caching are replaced with scenarios from the spec delta.

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

### Retries are for idempotent requests and honor rate-limit headers

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

- Only GET, HEAD, and OPTIONS are retried, unless a request opts in with
  `idempotent: true`. A replayed write can duplicate a comment or an alert.
- `Retry-After` wins when present. Otherwise a 429 waits until
  `X-Sentry-Rate-Limit-Reset`, measured against the response `Date` when the
  local clock disagrees with it by more than a couple of seconds.
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
- **R2 (hosted MCP, detail tier only).**
  - Persists an entry only when it is in the detail tier _and_ the response
    carries `Cache-Control: private` with a positive `max-age`. The server
    header is the opt-in: until getsentry/sentry#128828 ships and is
    enabled, R2 stores nothing.
  - Object key is `<identity>/<sha256(normalized URL)>`, with the expiry,
    the lesser of the server `max-age` and 5 minutes, in custom metadata and
    checked on read.
  - A bucket lifecycle rule deletes objects after 1 day, the shortest rule
    R2 supports. It is garbage collection only; reads enforce the expiry.
  - Writes happen in `ctx.waitUntil()`, so they never delay a response.
  - Detail entries are never targeted by mutation invalidation, so R2 never
    needs `deleteMatching`. The short expiry bounds how long a revoked or
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

- `get` checks memory first, then R2 for detail keys, and copies R2 hits
  into memory with the remaining expiry.
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

### `runMcpServer()` takes a transport

`McpServerOptions` gains `fetch?: typeof fetch`.

- `sentry mcp` passes the CLI's authenticated fetch, so local sessions get
  CLI auth, refresh, retries, and the on-disk cache.
- `mcp-cloudflare` builds an `api-transport` around the OAuth token and the
  tiered store.

Inside `mcp-core`, `SentryApiService` sends all requests through the
injected fetch, and `@sentry/api` operations receive the same fetch through
their client options.

### `fresh` is a shared read-tool input

Read-only tools gain an optional `fresh: boolean`, defined once in the
shared tool schema helpers. The tool handler sets a request-scoped bypass
(`AsyncLocalStorage`), and the transport honors it. The tool count does not
change. Token cost is checked with `pnpm run measure-tokens`, and the
description stays short.

### Move MCP methods onto `@sentry/api` by domain

The order is:

1. organizations, projects, teams (already partial)
2. issues and events
3. explore, traces, logs
4. releases and replays
5. monitors, alerts, and uptime

Endpoints that `@sentry/api` lacks call the shared transport directly and
keep their Zod schemas. Each domain lands as its own PR. Endpoint behavior
is checked against `~/src/sentry`, as `AGENTS.md` requires.

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
  copy until it expires: up to 5 minutes for detail entries, including
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
- **Snapshot and eval churn.** Each domain migration lands with its own
  snapshot updates and an eval run.
- **CLI-issued tokens lack MCP scopes.** The MCP and CLI use different OAuth
  client IDs and scope lists today. Compare them before deprecating the
  standalone login. If they differ, widen the CLI's requested scopes.

## Migration Plan

1. Land the catalog alignment (#1672), the CLI cache tier correction, and
   `api-retry` with the MCP 429 fix, each as its own PR.
2. Land the pure `toolkit-core` modules (pagination, cache policy, codecs),
   with the CLI switched over and no behavior change.
3. Land `api-transport` and the CLI switch-over.
4. Land the MCP transport injection and `sentry mcp` passing the CLI fetch,
   then the hosted memory store behind a flag (`MCP_RESPONSE_CACHE=memory`).
5. Enable the hosted memory cache. Add the R2 binding and the detail tier
   behind `MCP_RESPONSE_CACHE=tiered`, and enable it only after the server
   headers ship and the security sign-off.
6. Run the domain-by-domain `@sentry/api` migration PRs.
7. Deprecate the standalone MCP login.

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
