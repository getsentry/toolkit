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

## What Changes

- Move the CLI's pagination into `@sentry/toolkit-core` and use it from both
  products: limit-bounded walks, even page sizing, and cursors that resume
  mid-page.
- Move the CLI's response-cache policy into `@sentry/toolkit-core`. That
  covers TTL tiers, identity-scoped keys, invalidation after mutations, and
  bypass. Storage becomes a pluggable backend with a byte budget and
  compression.
- Move the CLI's request transport into `@sentry/toolkit-core`, with
  credentials, storage, and telemetry injected by the host. It covers retries,
  timeouts, redirect validation, and region routing.
- `runMcpServer()` accepts a host-supplied transport. `sentry mcp` passes the
  CLI's authenticated transport, so local MCP sessions reuse the CLI login,
  refresh, and on-disk cache.
- The hosted MCP on Cloudflare uses a tiered cache:
  - an in-memory LRU, limited by bytes, for every tier
  - R2 for immutable responses (events, traces)
  - zstd compression on both
- MCP read tools accept a `fresh` parameter that bypasses the cache, matching
  the CLI's `--fresh` flag.
- MCP API methods move onto `@sentry/api` operations domain by domain. The
  endpoints `@sentry/api` lacks go through the same shared transport.
- Both products use one `@sentry/api` version from the pnpm catalog.
- **Deprecation:** the standalone `@sentry/mcp-server` device-code login is
  deprecated in favor of `sentry mcp` and `sentry auth login`.

Out of scope, tracked separately:

- Server-side `Cache-Control` and `ETag` for immutable API responses
  (getsentry/sentry#128818).
- Moving the shared infrastructure into `@sentry/api` once it has proven
  itself in `toolkit-core`.

## Capabilities

### New Capabilities

- `sentry-api-pagination`: Limit-bounded, resume-safe pagination over Sentry
  list endpoints, shared by the CLI and MCP.
- `sentry-api-response-cache`: Identity-scoped caching of Sentry API GET
  responses. Covers TTL tiers, bypass, invalidation after mutations, and
  bounded, compressed storage.
- `mcp-host-transport`: How an MCP host supplies credentials and the Sentry
  API transport, including `sentry mcp` reusing the CLI's login and cache.

### Modified Capabilities

None.

## Impact

- `packages/toolkit-core`: new `pagination`, `response-cache`, and transport
  modules, with tests.
- `packages/cli/src/lib/api/infrastructure.ts`,
  `packages/cli/src/lib/response-cache.ts`,
  `packages/cli/src/lib/sentry-client.ts`: switch to the shared modules.
  CLI behavior does not change.
- `packages/mcp-core/src/api-client/client.ts`: the transport is replaced and
  methods move to `@sentry/api`.
- `packages/mcp-core` read tools gain a `fresh` input, and generated tool
  definitions change.
- `packages/mcp-server/src/index.ts`: `McpServerOptions` gains a transport
  option, and the standalone auth flow is deprecated.
- `packages/cli/src/lib/mcp.ts`: passes the CLI transport.
- `packages/mcp-cloudflare`: in-memory cache, an R2 bucket binding for
  immutable responses, and a wrangler config change.
- `pnpm-workspace.yaml`: a catalog entry for `@sentry/api`.
- Snapshot and eval churn in `mcp-core` and `mcp-server-evals`.
