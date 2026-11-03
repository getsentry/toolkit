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
- 6.2 Moved to `cli-first-mcp`: the MCP runs commands through the CLI SDK, so it uses the CLI's fetch and cache.
- [x] 6.3 Add the `fresh` input to read tools through the shared schema helpers. The request-scoped flag lives in the MCP host (`AsyncLocalStorage` in `mcp-core`'s tool handler), and the shared client reads it only through the transport's `fresh()` callback. Regenerate definitions, then verify `pnpm run measure-tokens` and the tool tests pass. Shipped in #1832: catalog tools with `readOnlyHint` and `openWorldHint` (not the docs tools) get the input, costing 130 tokens across the 10 direct read tools.

## 7. Hosted cache

Off the critical path since `cli-first-mcp`. The memory store (7.1, #1833) can land on its own for the catalog tools; the hosted SDK path runs uncached (`cli-first-mcp` 6.2). The R2 tier (7.3, 7.4, #1842) is parked until traffic on the command surface shows whether cross-isolate reuse pays; the cache policy itself moves into `@sentry/api` with the rest of the client.

- [ ] 7.1 Wire the memory store into `mcp-cloudflare` behind `MCP_RESPONSE_CACHE` (`off`/`memory`/`tiered`), with identity taken from the wrapper token's user and grant IDs. Verify the Workers tests pass, and a two-identity isolation test.
- [ ] 7.2 Confirm `node:zlib` zstd on a deployed preview Worker. If it is unavailable, keep brotli as the hosted codec and record that in `docs/cloudflare/architecture.md`.
- [ ] 7.3 Add the R2 binding, its URL allowlist (organization event details without `averageColumn`, project trace-item details without `debug`), and `TieredStore`. Persist only allowlisted entries whose response carries `Cache-Control: private` with a positive `max-age`, expiring at the lesser of that `max-age` and 5 minutes. Write in `waitUntil` and add a 1-day lifecycle rule for garbage collection. Verify tests for a cross-isolate allowlisted hit, no R2 write without server headers, expiry enforced on read, and memory-only volatile entries.
- [ ] 7.4 Get privacy and security sign-off on the 5-minute stale window after access revocation or deletion before setting `MCP_RESPONSE_CACHE=tiered` in production. Record the decision in `docs/cloudflare/architecture.md`.
- [ ] 7.5 Add cache hit, miss, and eviction metrics and memory-budget logging. Document them in `docs/operations/monitoring.md`, and verify they appear in a preview deploy.

## 8. The shared client in `@sentry/api`

The plan used to finish the whole client in `toolkit-core` and copy it into `@sentry/api` at the end. It now moves what exists into `@sentry/api` first and builds the rest there, since the CLI is the only long-term caller of endpoint wrappers: the MCP's catalog wrappers are deleted when the CLI's commands replace the catalog (`cli-first-mcp`), so porting them is wasted work.

- [x] 8.1 Audit the existing `toolkit-core` modules for anything that will not run in a browser, fix it, and add a guard: a lint rule that bans `node:*` imports and Node globals (`Buffer`, `process`, `AsyncLocalStorage`, and the like) in the shared modules, and a typecheck of them against the DOM library with no Node types. Modules that are host storage, such as the `node:zlib` cache codec, stay outside the guarded set and do not move in step 2. Verify the guard fails on a planted `node:` import. Done in #1732.
- [x] 8.2 Foundation: create `toolkit-core/src/api-client/` with errors (`ApiError`, rate limits with `retryAfterMs`), `apiPath`, response validation through the Standard Schema interface with host-supplied schemas (Zod in the MCP, valibot in the CLI; no Zod or valibot runtime dependency in shared code), and response reading. The MCP and the CLI use them. Verify the toolkit-core unit tests and both products' suites pass. Done in #1732.
- [x] 8.3 Move pagination, cache policy, retry policy, and transport under `api-client/`, with the layout they will have inside `@sentry/api`, and rewrite every importer. Verify tsc, lint, and every suite pass with no behavior change. Done in #1736.
- [x] 8.4 Request core and the first shared domains: `createApiClientCore` with `SentryApiService` on it (#1737), the organizations domain (#1741), and the idempotent-write list both products use for retries (#1820). **Dropped:** moving the remaining MCP domains onto shared wrappers.
- [ ] 8.5 (#1875) Move `toolkit-core/src/api-client/` into getsentry/sentry-api-schema's `lib/`, reconciling it with what is already there (`browser-client.ts`, `sentry-errors.ts`, `sentry-pagination.ts`) so the package has one error type, one pagination helper, and one transport. Keep the injected interfaces (credentials, `CacheStore`, fresh-read scope, logger, span hook) and the portability rules. Publish a new `@sentry/api`. Verify the package's tests, and that its browser entry builds and makes a request with a mocked `fetch`. (Formerly 9.1.)
- [ ] 8.6 (#1876) Bump `@sentry/api` in the pnpm catalog, switch the CLI, `mcp-core`, and `mcp-cloudflare` to it, and delete the `toolkit-core` copies in the same PR. Verify `pnpm run tsc && pnpm run lint && pnpm run test`. (Formerly 9.2.)
- [ ] 8.10 (#1877) Release once 8.6 lands, before 8.7: the first toolkit release since `cli@0.47.0` (`sentry` and `@sentry/mcp-server`), which also validates Craft 3.8 `versioning.files` (#1825). Verify both packages install from npm and `sentry mcp` and `npx @sentry/mcp-server` answer `tools/list`.
- [ ] 8.7 (#1878) Move the CLI's endpoint wrappers (`cli/src/lib/api/`) onto the `@sentry/api` client, domain by domain, and delete the CLI's own API errors and pagination. The CLI keeps credential storage and refresh, the SQLite and filesystem cache store, region lookup storage, telemetry, and the mapping of API errors to exit codes. Wrappers that only reshape one generated operation are replaced by the operation. Verify the CLI unit tests pass. (Formerly 8.5.)
- [ ] 8.8 (#1879) Inventory the endpoints the CLI calls by raw path rather than through a generated operation (about 85 call sites in `cli/src/lib/api/` and 55 in `mcp-core/src/api-client/` by a path grep, many duplicates), and get each one into `@sentry/api`: publish it in getsentry/sentry's OpenAPI schema so it generates, or record why it stays raw. Verify the inventory is checked in and each new operation is used.
- [ ] 8.9 In every PR, keep behavior the same and call out each intentional change in the PR body. Update `docs/contributing/api-patterns.md` and the `@sentry/api` README for the new layering, and verify `pnpm run docs:check` passes. Ongoing: #1737, #1741, and #1820 updated the toolkit docs for their layers. (Formerly 8.7.)
- Old 8.6 **dropped:** merging the wrappers both products call. After the catalog is deleted, only the CLI calls endpoint wrappers; the MCP calls CLI operations.

## 9. Merged into group 8

Moving the client into `@sentry/api` (old 9.1, 9.2) is now 8.5 and 8.6.

## 10. Trained compression dictionary

**Dropped.** The hosted cache is off the critical path, and a shippable training corpus is not worth building for it.

## 11. MCP tools as a portable face of the CLI

**Replaced by `cli-first-mcp`.** The MCP exposes the CLI's commands through search and execute tools instead of one ported tool per command.

- [x] 11.6 `@sentry/mcp-server` as a dependency-free bundle of the server built from CLI source. Done in #1731. Under `cli-first-mcp` it carries the exposed command handlers instead of catalog tools (7.1 there).
- 11.1, 11.2, 11.4: replaced by `cli-first-mcp` group 6, which runs the CLI SDK itself on Workers, one instance per request with persistence off. The per-domain split into portable operations (11.1) survives only as a fallback for domains Workers cannot run (6.7 there).
- 11.3 **Dropped:** moving each MCP tool into `sentry/mcp`. The command surface exposes commands generically.
- 11.5 moved to `cli-first-mcp` 6.8 (OAuth scope comparison).
- 11.7 Partly done in #1731: an oxlint rule bans `sentry` in `mcp-core` and `toolkit-core`, and `lint:deps` fails on workspace cycles. `mcp-cloudflare` now imports the CLI SDK, so the remaining rule is set when `cli-first-mcp` 6.5 lands.

## 12. Integration

- [ ] 12.1 Run `pnpm run tsc && pnpm run lint && pnpm run test` and the MCP eval suite on the final state, and record the results in the PR.

## Workflow follow-up

- Archive the change after review once all tasks are complete.
- Follow up on getsentry/sentry#128818 and getsentry/sentry#128828. When the server headers ship, confirm the CLI honors them and enable the R2 tier.
