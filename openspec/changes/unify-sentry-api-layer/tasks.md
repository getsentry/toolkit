# Tasks

## 1. Version alignment

- [ ] 1.1 Add `@sentry/api: 0.400.0` to the pnpm catalog and point `packages/cli` and `packages/mcp-core` at `catalog:`. Verify `pnpm install --frozen-lockfile` succeeds and the lockfile has one `@sentry/api` version.
- [ ] 1.2 Fix any `mcp-core` breakage from the `0.337.0` → `0.400.0` bump. Verify `pnpm --filter @sentry/mcp-core run tsc` and `pnpm --filter @sentry/mcp-core run test` pass.

## 2. Shared pagination

- [ ] 2.1 Move `paginate`, `fetchAllPages`, page sizing, and cursor encode/decode from `cli/src/lib/api/infrastructure.ts` into `toolkit-core/src/pagination.ts`. Failures are returned as typed results, and the host supplies the logger. Verify with toolkit-core unit tests that cover each `sentry-api-pagination` scenario.
- [ ] 2.2 Switch the CLI to the shared module, mapping errors to `ApiError` and keeping the `sentry-cli/no-manual-pagination` lint rule. Verify the CLI unit tests pass with no snapshot changes.
- [ ] 2.3 Document the module in `packages/toolkit-core/README.md`, and verify `pnpm run docs:check` passes.

## 3. Shared cache policy and codecs

- [ ] 3.1 Move tier classification, key derivation (moved to WebCrypto HMAC), URL normalization, and invalidation prefixes into `toolkit-core/src/response-cache/`. Verify with unit tests for the tier, identity-scoping, and invalidation scenarios.
- [ ] 3.2 Add a codec module (zstd level N, brotli fallback, raw below 1 KB) with runtime detection. Verify round-trip tests in Node 22, and a test with zstd stubbed out.
- [ ] 3.3 Define the `CacheStore` interface and add the byte-budgeted memory store. Verify tests for LRU eviction, the per-entry cap, and the budget staying within its bound under many identities.
- [ ] 3.4 Re-implement the CLI filesystem store on `CacheStore`, with compressed entries and a byte budget, while reading existing uncompressed entries. Verify the CLI cache tests pass and an old-format entry is still served.
- [ ] 3.5 Add conditional revalidation: send `If-None-Match` for stale entries that have an `ETag`, and treat a 304 as a hit. Verify with a test against a mocked `ETag` endpoint.

## 4. Shared transport

- [ ] 4.1 Move auth headers, 401 refresh, timeouts, GET retry/backoff, redirect validation, and region routing from `cli/src/lib/sentry-client.ts` into `toolkit-core/src/api-transport.ts`, with an injected `CredentialProvider`, `CacheStore`, logger, and span hook. Verify with transport unit tests.
- [ ] 4.2 Switch the CLI to the shared transport, wiring in the database credentials, the filesystem store, and telemetry spans. Verify the CLI unit and e2e tests pass.
- [ ] 4.3 Add a request-scoped fresh-read bypass to the transport, and verify a test that a bypassed request skips cache reads and replaces the entry.

## 5. MCP transport injection

- [ ] 5.1 Add `fetch` to `McpServerOptions`, and route all `SentryApiService` requests and `@sentry/api` calls through it. Verify an `mcp-server` test where a supplied fetch receives every tool request.
- [ ] 5.2 Pass the CLI's authenticated fetch from `cli/src/lib/mcp.ts`. Verify a CLI test where `sentry mcp` tool calls hit the shared cache, and `/mcp-qa` stdio QA passes.
- [ ] 5.3 Add the `fresh` input to read tools through the shared schema helpers. Regenerate definitions, then verify `pnpm run measure-tokens` and the tool tests pass.

## 6. Hosted cache

- [ ] 6.1 Wire the memory store into `mcp-cloudflare` behind `MCP_RESPONSE_CACHE` (`off`/`memory`/`tiered`), with identity taken from the wrapper token's user and grant IDs. Verify the Workers tests pass, and a two-identity isolation test.
- [ ] 6.2 Confirm `node:zlib` zstd on a deployed preview Worker. If it is unavailable, keep brotli as the hosted codec and record that in `docs/cloudflare/architecture.md`.
- [ ] 6.3 Add the R2 binding, the immutable-tier store, and `TieredStore`, with writes in `waitUntil` and a 1-day lifecycle rule. Verify tests for cross-isolate immutable hits and memory-only volatile entries.
- [ ] 6.4 Add cache hit, miss, and eviction metrics and memory-budget logging. Document them in `docs/operations/monitoring.md`, and verify they appear in a preview deploy.

## 7. Move MCP endpoints onto `@sentry/api`

- [ ] 7.1 Organizations, projects, and teams. Verify the MCP tests and snapshots for the affected tools.
- [ ] 7.2 Issues and events. Verify the MCP tests and snapshots for the affected tools.
- [ ] 7.3 Explore, traces, and logs. Verify the MCP tests, snapshots, and a search-events eval run.
- [ ] 7.4 Releases and replays. Verify the MCP tests and snapshots for the affected tools.
- [ ] 7.5 Monitors, alerts, and uptime, keeping the shared-transport fallback for the endpoints `@sentry/api` lacks. Verify the MCP tests and snapshots.
- [ ] 7.6 Update `docs/contributing/api-patterns.md` for the new client layering, and verify `pnpm run docs:check` passes.

## 8. Standalone login deprecation

- [ ] 8.1 Compare the OAuth scopes the CLI requests with the MCP `SCOPES`, and widen the CLI's requested scopes if needed. Verify a test that the CLI's scope list covers every MCP tool's required scopes.
- [ ] 8.2 Add a deprecation notice to the standalone `@sentry/mcp-server` auth flow and docs pointing to `sentry mcp`. Verify with an output test and an update to `docs/operations/stdio-auth.md`.

## 9. Integration

- [ ] 9.1 Run `pnpm run tsc && pnpm run lint && pnpm run test` and the MCP eval suite on the final state, and record the results in the PR.

## Workflow follow-up

- Archive the change after review once all tasks are complete.
- Follow up on getsentry/sentry#128818 and revisit the TTL tiers when server cache headers ship.
- Propose moving pagination, then the transport, into `@sentry/api`.
