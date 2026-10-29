# Tasks

## 1. Version alignment

- [x] 1.1 Add `@sentry/api: 0.400.0` to the pnpm catalog and point `packages/cli` and `packages/mcp-core` at `catalog:`. Verify `pnpm install --frozen-lockfile` succeeds and the lockfile has one `@sentry/api` version.
- [x] 1.2 Fix any `mcp-core` breakage from the `0.337.0` → `0.400.0` bump. Verify `pnpm --filter @sentry/mcp-core run tsc` and `pnpm --filter @sentry/mcp-core run test` pass.

## 2. CLI cache tier correction

- [x] 2.1 Remove the CLI's `immutable` tier in `packages/cli/src/lib/response-cache.ts`. Move issue events (including `latest`, `oldest`, `recommended`), project event details, and full traces to `volatile`; organization event and trace-item details fall to `stable`. Verify with classifier and fake-clock expiry tests for each `Fallback TTL tiers` scenario.
- [x] 2.2 Ship it as its own PR (#1681). Verify the CLI unit tests pass.

## 3. Shared pagination

- [x] 3.1 Move `paginate`, `fetchAllPages`, page sizing, and cursor encode/decode from `cli/src/lib/api/infrastructure.ts` into `toolkit-core/src/pagination.ts`. Failures are returned as typed results, and the host supplies the logger. Verify with toolkit-core unit tests that cover each `sentry-api-pagination` scenario.
- [x] 3.2 Switch the CLI to the shared module, mapping errors to `ApiError` and keeping the `sentry-cli/no-manual-pagination` lint rule. Verify the CLI unit tests pass with no snapshot changes.
- [x] 3.3 Document the module in `packages/toolkit-core/README.md`, and verify `pnpm run docs:check` passes. Shipped in #1683.

## 4. Shared cache policy and codecs

- [x] 4.1 Move tier classification, key derivation (moved to WebCrypto HMAC), URL normalization, and invalidation prefixes into `toolkit-core/src/response-cache/`. Verify with unit tests for the tier, identity-scoping, and invalidation scenarios. Shipped in #1688.
- [x] 4.2 Add a codec module (zstd level 3 for every tier, brotli-4 fallback, raw below 256 bytes, `encoding` and `dictId` recorded per entry) with runtime detection. Verify round-trip tests in Node 22, and a test with zstd stubbed out. Shipped in #1695.
- [x] 4.3 Define the `CacheStore` interface and add the byte-budgeted memory store. Verify tests for LRU eviction, the per-entry cap, and the budget staying within its bound under many identities. Shipped in #1696.
- [x] 4.4 Re-implement the CLI filesystem store on `CacheStore`, with compressed entries and a byte budget, while reading existing uncompressed entries. Verify the CLI cache tests pass and an old-format entry is still served. Shipped in #1697.
- [x] 4.5 Add conditional revalidation: send `If-None-Match` for stale entries that have an `ETag`, and treat a 304 as a hit. Verify with a test against a mocked `ETag` endpoint. Shipped in #1698.
- [x] 4.6 Move the cache policy from `packages/cli/src/lib/response-cache.ts` into `toolkit-core/src/response-cache/`: freshness checks (server cache directives win, the URL tier is the fallback), stale lookup and 304 revalidation, retention (the freshness lifetime plus a 24-hour revalidation window for entries with an `ETag`), response header rebuild, and cache-entry construction. `http-cache-semantics` becomes a `toolkit-core` dependency. The CLI keeps the filesystem store, cache directory, identity fingerprint, env kill switches, telemetry, and the cache-age hint. Verify with toolkit-core unit tests for the moved logic, and the CLI cache tests passing unchanged. Shipped in #1704.

## 5. Shared transport

- [x] 5.0 Add a pure, Workers-safe retry policy in `toolkit-core/src/api-retry.ts`: retryable statuses (429, 500, 502, 503, and 504, not every 5xx, since 501, 505, and the rest are deterministic); a 429 retried for any method, because Sentry's `RatelimitMiddleware` rejects it before the view runs; 5xx, timeouts, and network errors retried only for GET, HEAD, and OPTIONS, or for an explicit per-request `idempotent` opt-in, such as content-addressed chunk uploads; the delay from `Retry-After` (seconds or HTTP-date) or, on a 429, `X-Sentry-Rate-Limit-Reset`, kept within the range the response `Date` allows, and a per-wait and total-wait cap; a jittered exponential fallback, used for concurrency-limit 429s too; and an abortable sleep. The 401 refresh is not part of this policy and stays allowed for any method. MCP `request()` adopts it in the same PR, retrying rate-limited requests and filling `ApiRateLimitError.retryAfter` from the headers. Verify with toolkit-core unit tests for each `sentry-api-transport` retry scenario and MCP client tests. Shipped in #1673; the CLI's interim local fix (#1677) switched to this module in #1710.
- [x] 5.1 Move auth headers, 401 refresh (any method), timeouts, retry and backoff through `api-retry` (429 for any method; 5xx, timeouts, and network errors for idempotent methods only), redirect validation, and region routing from `cli/src/lib/sentry-client.ts` into `toolkit-core/src/api-transport.ts`, with an injected `CredentialProvider`, `CacheStore`, logger, and span hook. The CLI used to retry every method on 5xx and timeouts, POSTs included; that was a bug, fixed separately before this move. Verify with transport unit tests. Shipped in #1719.
- [x] 5.2 Switch the CLI to the shared transport, wiring in the database credentials, the filesystem store, and telemetry spans. Verify the CLI unit and e2e tests pass. Shipped in #1719.
- [x] 5.3 Add a request-scoped fresh-read bypass to the transport, and verify a test that a bypassed request skips cache reads and replaces the entry. Shipped in #1720.

## 6. MCP on the shared transport

- [x] 6.1 Route every `SentryApiService` request, including `@sentry/api` operations, through `createApiTransport`, and drop `SentryApiService`'s own retry loop so retries do not stack. No host-supplied fetch: hosts share the client from group 8 instead. Verify a test where a rate-limited GET reaches the API at most `maxRetries + 1` times, and one where an in-flight abort keeps the caller's reason. Done in #1722.
- 6.2 Moved to group 11 (deferred): `sentry mcp` passing the CLI's fetch.
- [ ] 6.3 Add the `fresh` input to read tools through the shared schema helpers. The request-scoped flag lives in the MCP host (`AsyncLocalStorage` in `mcp-core`'s tool handler), and the shared client reads it only through the transport's `fresh()` callback. Regenerate definitions, then verify `pnpm run measure-tokens` and the tool tests pass.

## 7. Hosted cache

- [ ] 7.1 Wire the memory store into `mcp-cloudflare` behind `MCP_RESPONSE_CACHE` (`off`/`memory`/`tiered`), with identity taken from the wrapper token's user and grant IDs. Verify the Workers tests pass, and a two-identity isolation test.
- [ ] 7.2 Confirm `node:zlib` zstd on a deployed preview Worker. If it is unavailable, keep brotli as the hosted codec and record that in `docs/cloudflare/architecture.md`.
- [ ] 7.3 Add the R2 binding, its URL allowlist (organization event details without `averageColumn`, project trace-item details without `debug`), and `TieredStore`. Persist only allowlisted entries whose response carries `Cache-Control: private` with a positive `max-age`, expiring at the lesser of that `max-age` and 5 minutes. Write in `waitUntil` and add a 1-day lifecycle rule for garbage collection. Verify tests for a cross-isolate allowlisted hit, no R2 write without server headers, expiry enforced on read, and memory-only volatile entries.
- [ ] 7.4 Get privacy and security sign-off on the 5-minute stale window after access revocation or deletion before setting `MCP_RESPONSE_CACHE=tiered` in production. Record the decision in `docs/cloudflare/architecture.md`.
- [ ] 7.5 Add cache hit, miss, and eviction metrics and memory-budget logging. Document them in `docs/operations/monitoring.md`, and verify they appear in a preview deploy.

## 8. Step 1: consolidate the API layer in `toolkit-core`

Stacked PRs by layer, not by domain. Each one is based on the PR below it and keeps both products green. Earlier, issues and events moved onto `@sentry/api` operations inside `SentryApiService` (#1713, formerly 8.2); the rest of the old per-domain plan folds into this group. Mechanical moves are codemods run from outside the tree. Each run is a generated commit whose message gives the command, and the scripts go in the PR description.

- [x] 8.1 Audit the existing `toolkit-core` modules for anything that will not run in a browser, fix it, and add a guard: a lint rule that bans `node:*` imports and Node globals (`Buffer`, `process`, `AsyncLocalStorage`, and the like) in the shared modules, and a typecheck of them against the DOM library with no Node types. Modules that are host storage, such as the `node:zlib` cache codec, stay outside the guarded set and do not move in step 2. Verify the guard fails on a planted `node:` import. Done in #1732.
- [x] 8.2 Foundation: create `toolkit-core/src/api-client/` with errors (`ApiError`, rate limits with `retryAfterMs`), `apiPath`, response validation through the Standard Schema interface with host-supplied schemas (Zod in the MCP, valibot in the CLI; no Zod or valibot runtime dependency in shared code), and response reading. The MCP and the CLI use them. Verify the toolkit-core unit tests and both products' suites pass. Done in #1732.
- [ ] 8.3 Move pagination, cache policy, retry policy, and transport under `api-client/`, with the layout they will have inside `@sentry/api`, and rewrite every importer. Verify tsc, lint, and every suite pass with no behavior change. In review in #1736.
- [ ] 8.4 Add the core request handling and endpoint wrappers by domain on top of `@sentry/api` operations, and switch `SentryApiService` onto them: its endpoints, schemas, and errors come from the shared client, and the replaced code is deleted from `mcp-core`. The MCP keeps its Zod-to-tool output formatting. Credentials, cache storage, the fresh-read scope, logging, and telemetry are injected interfaces. Verify toolkit-core unit tests for the core and each domain, and the `mcp-core`, `mcp-server`, and `mcp-cloudflare` suites and snapshots. Lands as a core PR, then one PR per domain: the request core (`createApiClientCore`, with `SentryApiService` sending every request through it) is in review in #1737.
- [ ] 8.5 Add the CLI host seam and switch the CLI: its `lib/api/` endpoint wrappers, API errors, and pagination come from the shared client, and the replaced code is deleted. The CLI keeps credential storage and refresh, the SQLite and filesystem cache store, region lookup storage, telemetry, and the mapping of API errors to exit codes. Verify the CLI unit tests pass.
- [ ] 8.6 Merge the wrappers both products call for the same endpoint into one, so the CLI and MCP share it. Verify both products' suites pass.
- [ ] 8.7 In every PR, keep behavior the same and call out each intentional change in the PR body. Update `docs/contributing/api-patterns.md` and `packages/toolkit-core/README.md` for the new layering, and verify `pnpm run docs:check` passes.

## 9. Step 2: move the shared client into `@sentry/api`

- [ ] 9.1 Copy `toolkit-core/src/api-client/` and the modules it depends on into getsentry/sentry-api-schema with the same layout, and publish a new `@sentry/api` version. Verify the package's own tests there, and that its browser entry builds and makes a request with a mocked `fetch`, so the Sentry frontend can use it with session credentials and no cache store.
- [ ] 9.2 Bump `@sentry/api` in the pnpm catalog, switch the CLI and MCP imports to `@sentry/api`, and delete the toolkit-core copies in the same PR. Verify `pnpm run tsc && pnpm run lint && pnpm run test`.

## 10. Trained compression dictionary (follow-up)

- [ ] 10.1 Build a training corpus that is safe to ship: a public demo organization, or a per-deployment corpus that never leaves the hosted MCP. Verify that no customer or internal strings appear in a shipped dictionary (`strings` audit in CI).
- [ ] 10.2 Add dictionary compression with a versioned `dictId` and a startup self-test that detects a silently ignored `dictionary` option (as in workerd today). Verify a test where an ignored dictionary falls back to plain zstd.
- [ ] 10.3 On Workers, evaluate WASM zstd for dictionary compression: bundle size, CPU in ms/MB, and ratio against native zstd-3. Record the results in design.md and adopt it only if the memory-tier gain outweighs the CPU cost.

## 11. Deferred: MCP on the CLI's operations and host capabilities

Picked up after step 2; it gets its own spec then. Dependencies only point down (`cli → mcp-core → toolkit-core`, `mcp-cloudflare → mcp-core`), and `mcp-core` never imports `sentry`, not even type-only. See "Dependencies point down" in design.md.

- [ ] 11.1 Move the CLI SDK's portable operations into the shared client layer, so `createSentrySDK()`, the CLI commands, and the MCP tools are thin faces over the same operations. Verify the CLI SDK tests and the `mcp-core` and `mcp-cloudflare` suites pass, and that `mcp-core` has no import of `sentry`.
- [ ] 11.2 Declare the CLI-only host capabilities as optional interfaces in `mcp-core` or `toolkit-core`: the SQLite response cache store, the region cache, DSN detection from local files, and file uploads. `sentry mcp` injects the CLI's implementations and authenticated fetch from `cli/src/lib/mcp.ts` (formerly 6.2); `mcp-cloudflare` injects its own or omits them. Verify a CLI test where `sentry mcp` tool calls hit the shared cache, a Workers test with the capabilities omitted, and `/mcp-qa` stdio QA.
- [ ] 11.3 Compare the OAuth scopes the CLI requests with the MCP `SCOPES`, and widen the CLI's requested scopes if needed (formerly 9.1). Verify a test that the CLI's scope list covers every MCP tool's required scopes.
- [ ] 11.4 Retire `@sentry/mcp-server` in favor of `sentry mcp`, and move the MCP registry entry (`server.json`) to `sentry mcp` (replaces the former deprecation notice, 9.2). Tracked by the `@sentry/mcp-server` retirement PR. Verify `docs/operations/stdio-auth.md` and `docs/releases/stdio.md` point to `sentry mcp`.
- [ ] 11.5 Enforce the dependency direction: a lint rule that bans importing `sentry` from `mcp-core` and `mcp-cloudflare`, type-only imports included, and a manifest check that fails on a workspace dependency cycle. Both land in the retirement PR. Verify each fails on a planted import or dependency.

## 12. Integration

- [ ] 12.1 Run `pnpm run tsc && pnpm run lint && pnpm run test` and the MCP eval suite on the final state, and record the results in the PR.

## Workflow follow-up

- Archive the change after review once all tasks are complete.
- Follow up on getsentry/sentry#128818 and getsentry/sentry#128828. When the server headers ship, confirm the CLI honors them and enable the R2 tier.
