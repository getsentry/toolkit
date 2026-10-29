# Proposal

## Why

The CLI and the MCP server talk to the same Sentry API through two separate
request layers. The CLI has resume-safe pagination, an identity-scoped
response cache, 401 refresh, timeouts, and validated redirects. The MCP has
its own transport in `mcp-core/src/api-client/client.ts` (about 6,000 lines),
uses `@sentry/api` for only three operations, and caches nothing. Fixes and
features land in one product and not the other, and the two pin different
`@sentry/api` versions (`0.337.0` and `^0.400.0`).

`createSentrySDK()` cannot be the shared layer:

- The CLI depends on `@sentry/mcp-server` for `sentry mcp`.
- The SDK needs SQLite and a filesystem, which Cloudflare Workers lack.
- SDK errors flatten HTTP status into exit codes.

The shared layer must therefore sit below both products, on `@sentry/api`.
Its end state is inside `@sentry/api` itself, so every consumer, including
the Sentry frontend in the browser, gets one Sentry API client.

The plan has two steps:

1. Consolidate every `SentryApiService`-like layer, the MCP's
   `SentryApiService` and the CLI's API modules, into one shared client in
   `@sentry/toolkit-core`, structured the way it will live in
   `@sentry/api`.
2. Copy that client into getsentry/sentry-api-schema, publish a new
   `@sentry/api`, switch toolkit's imports to it, and delete the
   toolkit-core copies.

## What Changes

- Move the CLI's pagination into `@sentry/toolkit-core` and use it from both
  products: limit-bounded walks, even page sizing, and cursors that resume
  mid-page.
- **Behavior change (landed in #1681):** drop the CLI's 24-hour
  "immutable" cache tier. It matched every `/events/<id>/` and
  `/trace/<id>/` URL, but issue events, project events, and full traces
  change after they are first read (getsentry/sentry#128818). Issue events,
  project events, and full traces drop to 60 seconds; organization event
  details and trace-item details fall to the default 5 minutes.
- Move the CLI's response-cache policy into `@sentry/toolkit-core`. That
  covers TTL tiers, identity-scoped keys, invalidation after mutations, and
  bypass. Storage becomes a pluggable backend with a byte budget and
  compression.
- Add a shared retry policy to `@sentry/toolkit-core`: 429s are retried for
  any method and wait for Sentry's rate-limit reset header within a cap, while
  5xx responses and timeouts are retried only for idempotent requests. The MCP adopts it first, so rate-limited GETs retry instead of
  failing.
- Move the CLI's request transport into `@sentry/toolkit-core`, with
  credentials, storage, and telemetry injected by the host. It covers retries
  through the shared policy, timeouts, redirect validation, and region
  routing.
- The MCP's `SentryApiService` sends every request through the shared
  transport and drops its own retry loop.
- **Step 1:** add a shared API client to `@sentry/toolkit-core`, in one PR
  that also switches both products and deletes the code it replaces. It
  covers endpoint wrappers by domain on top of `@sentry/api` operations,
  the error types (`ApiError`, rate limits, `retryAfterMs`), response
  validation through the Standard Schema interface (the MCP keeps Zod and
  the CLI keeps valibot; shared code depends on neither), pagination,
  the cache policy, the retry policy, and the transport.
- **Portability rule:** the shared client imports only `@sentry/api` and
  toolkit-core modules that move with it, and uses only web-standard APIs,
  so it runs in Node, Workers, and browsers. No `node:*` imports, `Buffer`,
  `fs`, `process`, or `AsyncLocalStorage`. Credentials, storage, the
  fresh-read scope, and telemetry are interfaces each host provides. A lint
  rule and a browser-target typecheck enforce it.
- **Step 2:** move the shared client into `@sentry/api`, publish it, and
  switch toolkit over.
- The hosted MCP on Cloudflare uses a tiered cache:
  - an in-memory LRU, limited by bytes, for every tier
  - R2 for an allowlist of organization event details and project
    trace-item details, only when the server marks them `private, max-age`,
    for at most 5 minutes
  - zstd level 3 compression on both
- MCP read tools accept a `fresh` parameter that bypasses the cache, matching
  the CLI's `--fresh` flag. The request-scoped flag lives in the MCP host,
  not in shared code.
- Shared endpoint wrappers use `@sentry/api` operations where they exist. The
  endpoints `@sentry/api` lacks go through the same shared transport.
- Both products use one `@sentry/api` version from the pnpm catalog.

Out of scope, tracked separately:

- Server-side `Cache-Control` for event and trace-item detail responses
  (getsentry/sentry#128818, prototype in getsentry/sentry#128828).
- A later phase, after step 2: `sentry mcp` passes the CLI's authenticated
  fetch so local MCP sessions reuse the CLI login and on-disk cache, the
  CLI's OAuth scopes are widened to cover MCP tools, and the CLI SDK's
  portable operations move into the shared client so the CLI and MCP share
  them without the MCP importing the CLI. `@sentry/mcp-server` is retired
  in favor of `sentry mcp` in its own PR.

## Capabilities

### New Capabilities

- `sentry-api-pagination`: Limit-bounded, resume-safe pagination over Sentry
  list endpoints, shared by the CLI and MCP.
- `sentry-api-response-cache`: Identity-scoped caching of Sentry API GET
  responses. Covers TTL tiers, bypass, invalidation after mutations, and
  bounded, compressed storage.
- `sentry-api-transport`: When a Sentry API request is retried, how long it
  waits, and what a caller sees when it gives up.
- `sentry-api-client`: One portable Sentry API client, shared by the CLI and
  MCP from `toolkit-core` and later from `@sentry/api`, with host-injected
  credentials, storage, and telemetry.

### Modified Capabilities

None.

## Impact

- `packages/toolkit-core`: new `pagination`, `response-cache`, retry, and
  transport modules, then the `api-client` module, with tests, a lint guard
  against Node-only APIs, and a browser-target typecheck.
- `packages/cli/src/lib/api/infrastructure.ts`,
  `packages/cli/src/lib/response-cache.ts`,
  `packages/cli/src/lib/sentry-client.ts`: switch to the shared modules.
  Apart from the narrower cache tiers, CLI behavior does not change.
- `packages/mcp-core/src/api-client/`: the transport is replaced, then the
  endpoints, schemas, and errors move to the shared client. The MCP keeps
  its Zod-to-tool output formatting.
- `packages/cli/src/lib/api/`: endpoint wrappers, API errors, and
  pagination move to the shared client. The CLI keeps credential storage,
  the cache store, region storage, telemetry, and exit-code mapping.
- `packages/mcp-core` read tools gain a `fresh` input, and generated tool
  definitions change.
- `packages/mcp-cloudflare`: in-memory cache, an R2 bucket binding for
  allowlisted detail responses, and a wrangler config change.
- `pnpm-workspace.yaml`: a catalog entry for `@sentry/api`, bumped in step 2
  to the release that contains the shared client.
- getsentry/sentry-api-schema: receives the shared client in step 2.
- Snapshot and eval churn in `mcp-core` and `mcp-server-evals`.
