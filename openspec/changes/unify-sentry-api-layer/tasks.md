# Tasks

## 1. Version alignment

- [ ] 1.1 Add `@sentry/api: 0.400.0` to the pnpm catalog and point `packages/cli` and `packages/mcp-core` at `catalog:`. Verify `pnpm install --frozen-lockfile` succeeds and the lockfile has one `@sentry/api` version.
- [ ] 1.2 Fix any `mcp-core` breakage from the `0.337.0` → `0.400.0` bump. Verify `pnpm --filter @sentry/mcp-core run tsc` and `pnpm --filter @sentry/mcp-core run test` pass.

## 2. CLI cache tier correction

- [ ] 2.1 Replace the CLI's `immutable` tier in `packages/cli/src/lib/response-cache.ts` with `detail` (5 minutes): exact path shapes for organization event details without `averageColumn` and project trace-item details without `debug`. Move issue events (including `latest`, `oldest`, `recommended`), project event details, and full traces to `volatile`, and check `/issues/` before any event pattern. Verify with `response-cache.property.test.ts` cases for each `Fallback TTL tiers` scenario, replacing the 24-hour assertions.
- [ ] 2.2 Ship it as its own PR with a changelog note, since repeated event and trace reads will now call the API more often. Verify the CLI unit tests pass.

## 3. Shared pagination

- [ ] 3.1 Move `paginate`, `fetchAllPages`, page sizing, and cursor encode/decode from `cli/src/lib/api/infrastructure.ts` into `toolkit-core/src/pagination.ts`. Failures are returned as typed results, and the host supplies the logger. Verify with toolkit-core unit tests that cover each `sentry-api-pagination` scenario.
- [ ] 3.2 Switch the CLI to the shared module, mapping errors to `ApiError` and keeping the `sentry-cli/no-manual-pagination` lint rule. Verify the CLI unit tests pass with no snapshot changes.
- [ ] 3.3 Document the module in `packages/toolkit-core/README.md`, and verify `pnpm run docs:check` passes.

## 4. Shared cache policy and codecs

- [ ] 4.1 Move tier classification, key derivation (moved to WebCrypto HMAC), URL normalization, and invalidation prefixes into `toolkit-core/src/response-cache/`. Verify with unit tests for the tier, identity-scoping, and invalidation scenarios.
- [ ] 4.2 Add a codec module (zstd level 3 for every tier, brotli-4 fallback, raw below 256 bytes, `encoding` and `dictId` recorded per entry) with runtime detection. Verify round-trip tests in Node 22, and a test with zstd stubbed out.
- [ ] 4.3 Define the `CacheStore` interface and add the byte-budgeted memory store. Verify tests for LRU eviction, the per-entry cap, and the budget staying within its bound under many identities.
- [ ] 4.4 Re-implement the CLI filesystem store on `CacheStore`, with compressed entries and a byte budget, while reading existing uncompressed entries. Verify the CLI cache tests pass and an old-format entry is still served.
- [ ] 4.5 Add conditional revalidation: send `If-None-Match` for stale entries that have an `ETag`, and treat a 304 as a hit. Verify with a test against a mocked `ETag` endpoint.

## 5. Shared transport

- [ ] 5.0 Add a pure, Workers-safe retry policy in `toolkit-core/src/api-retry.ts`: retryable statuses (429, 500, 502, 503, and 504, not every 5xx, since 501, 505, and the rest are deterministic); a 429 retried for any method, because Sentry's `RatelimitMiddleware` rejects it before the view runs; 5xx, timeouts, and network errors retried only for GET, HEAD, and OPTIONS, or for an explicit per-request `idempotent` opt-in, such as content-addressed chunk uploads; the delay from `Retry-After` (seconds or HTTP-date) or, on a 429, `X-Sentry-Rate-Limit-Reset`, kept within the range the response `Date` allows, and a per-wait and total-wait cap; a jittered exponential fallback, used for concurrency-limit 429s too; and an abortable sleep. The 401 refresh is not part of this policy and stays allowed for any method. MCP `request()` adopts it in the same PR, retrying rate-limited requests and filling `ApiRateLimitError.retryAfter` from the headers. Verify with toolkit-core unit tests for each `sentry-api-transport` retry scenario and MCP client tests. The CLI's interim local fix switches to this module in a follow-up PR.
- [ ] 5.1 Move auth headers, 401 refresh (any method), timeouts, retry and backoff through `api-retry` (429 for any method; 5xx, timeouts, and network errors for idempotent methods only), redirect validation, and region routing from `cli/src/lib/sentry-client.ts` into `toolkit-core/src/api-transport.ts`, with an injected `CredentialProvider`, `CacheStore`, logger, and span hook. The CLI used to retry every method on 5xx and timeouts, POSTs included; that was a bug, fixed separately before this move. Verify with transport unit tests.
- [ ] 5.2 Switch the CLI to the shared transport, wiring in the database credentials, the filesystem store, and telemetry spans. Verify the CLI unit and e2e tests pass.
- [ ] 5.3 Add a request-scoped fresh-read bypass to the transport, and verify a test that a bypassed request skips cache reads and replaces the entry.

## 6. MCP transport injection

- [ ] 6.1 Add `fetch` to `McpServerOptions`, and route all `SentryApiService` requests and `@sentry/api` calls through it. `SentryApiService` drops its own retry when it moves onto the transport, so retries do not stack. Verify an `mcp-server` test where a supplied fetch receives every tool request, and a test where a rate-limited GET reaches the API at most `maxRetries + 1` times.
- [ ] 6.2 Pass the CLI's authenticated fetch from `cli/src/lib/mcp.ts`. Verify a CLI test where `sentry mcp` tool calls hit the shared cache, and `/mcp-qa` stdio QA passes.
- [ ] 6.3 Add the `fresh` input to read tools through the shared schema helpers. Regenerate definitions, then verify `pnpm run measure-tokens` and the tool tests pass.

## 7. Hosted cache

- [ ] 7.1 Wire the memory store into `mcp-cloudflare` behind `MCP_RESPONSE_CACHE` (`off`/`memory`/`tiered`), with identity taken from the wrapper token's user and grant IDs. Verify the Workers tests pass, and a two-identity isolation test.
- [ ] 7.2 Confirm `node:zlib` zstd on a deployed preview Worker. If it is unavailable, keep brotli as the hosted codec and record that in `docs/cloudflare/architecture.md`.
- [ ] 7.3 Add the R2 binding, the detail-tier store, and `TieredStore`. Persist only detail-tier entries whose response carries `Cache-Control: private` with a positive `max-age`, expiring at the lesser of that `max-age` and 5 minutes. Write in `waitUntil` and add a 1-day lifecycle rule for garbage collection. Verify tests for a cross-isolate detail hit, no R2 write without server headers, expiry enforced on read, and memory-only volatile entries.
- [ ] 7.4 Get privacy and security sign-off on the 5-minute stale window after access revocation or deletion before setting `MCP_RESPONSE_CACHE=tiered` in production. Record the decision in `docs/cloudflare/architecture.md`.
- [ ] 7.5 Add cache hit, miss, and eviction metrics and memory-budget logging. Document them in `docs/operations/monitoring.md`, and verify they appear in a preview deploy.

## 8. Move MCP endpoints onto `@sentry/api`

- [ ] 8.1 Organizations, projects, and teams. Verify the MCP tests and snapshots for the affected tools.
- [ ] 8.2 Issues and events. Verify the MCP tests and snapshots for the affected tools.
- [ ] 8.3 Explore, traces, and logs. Verify the MCP tests, snapshots, and a search-events eval run.
- [ ] 8.4 Releases and replays. Verify the MCP tests and snapshots for the affected tools.
- [ ] 8.5 Monitors, alerts, and uptime, keeping the shared-transport fallback for the endpoints `@sentry/api` lacks. Verify the MCP tests and snapshots.
- [ ] 8.6 Update `docs/contributing/api-patterns.md` for the new client layering, and verify `pnpm run docs:check` passes.

## 9. Standalone login deprecation

- [ ] 9.1 Compare the OAuth scopes the CLI requests with the MCP `SCOPES`, and widen the CLI's requested scopes if needed. Verify a test that the CLI's scope list covers every MCP tool's required scopes.
- [ ] 9.2 Add a deprecation notice to the standalone `@sentry/mcp-server` auth flow and docs pointing to `sentry mcp`. Verify with an output test and an update to `docs/operations/stdio-auth.md`.

## 10. Trained compression dictionary (follow-up)

- [ ] 10.1 Build a training corpus that is safe to ship: a public demo organization, or a per-deployment corpus that never leaves the hosted MCP. Verify that no customer or internal strings appear in a shipped dictionary (`strings` audit in CI).
- [ ] 10.2 Add dictionary compression with a versioned `dictId` and a startup self-test that detects a silently ignored `dictionary` option (as in workerd today). Verify a test where an ignored dictionary falls back to plain zstd.
- [ ] 10.3 On Workers, evaluate WASM zstd for dictionary compression: bundle size, CPU in ms/MB, and ratio against native zstd-3. Record the results in design.md and adopt it only if the memory-tier gain outweighs the CPU cost.

## 11. Integration

- [ ] 11.1 Run `pnpm run tsc && pnpm run lint && pnpm run test` and the MCP eval suite on the final state, and record the results in the PR.

## Workflow follow-up

- Archive the change after review once all tasks are complete.
- Follow up on getsentry/sentry#128818 and getsentry/sentry#128828. When the server headers ship, confirm the CLI honors them and enable the R2 tier.
- Propose moving pagination, then the transport, into `@sentry/api`.
