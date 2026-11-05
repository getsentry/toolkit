# Tasks

The API work these tasks build on is `unify-sentry-api-layer`. New commands
use `@sentry/api` operations and do not wait for the shared client to move
there.

## 1. Command metadata for agents

- [ ] 1.1 (#1880) Add a permission class (read, write, destructive) to every command, derived from its operations in `command-api.json` and its `destructive` flag, with a lint check that fails when a class is missing or disagrees with the operations. Verify the check fails on a planted GET-only command marked write and a write command marked read.
- [ ] 1.2 (#1880) Add an exposure (exposed, stdio-only, hidden) to every command, with a lint check that fails when one is missing. Mark session management, CLI maintenance, `local`, and `monitor run` hidden, and local-file commands stdio-only.
- [ ] 1.3 (#1881) Generate `command-catalog.json` from the route tree: path, brief, JSON Schema for parameters, completion kinds, examples, output fields, API operations, permission class, and exposure. Verify a test that it matches `lib/introspect.ts` output for the full tree.

## 2. CLI parity with the MCP catalog

One PR per domain. Each adds the commands from the parity table in design.md, on `@sentry/api` operations, with unit tests, and ticks its rows. Pending MCP tool PRs for the same capability are redirected here.

- [ ] 2.1 (#1883) Projects and teams: `project edit`, `team create`, `project team add/remove`. Supersedes `refine-project-management-tools`.
- [ ] 2.2 (#1884) DSNs: `dsn create`, `dsn edit`.
- [ ] 2.3 (#1885) Issues: `issue assign`, `issue comment`, `issue activity`; breadcrumbs and user reports where `event view` and `feedback list` fall short.
- [ ] 2.4 (#1886) Events: `event attachment list/download`; dropped events (#1812).
- [ ] 2.5 (#1887) Monitors: `monitor view`, `monitor env delete`, `monitor uptime list/view/create/edit/delete` (the detectors work in #1837 moves here).
- [ ] 2.6 (#1381) Profiles: `profile list/view`.
- [ ] 2.7 (#1888) Snapshots, alert options, and the metrics dataset in `explore`: check against the MCP tools and fill the gaps.
- [ ] 2.8 (#1889) `sentry open <url>`: resolve any Sentry URL to the matching resource and command.
- [ ] 2.9 (#1382) Mark every row in the parity table done or dropped, with the reason.

## 3. The command surface on stdio

- [ ] 3.1 (#1890) Add per-command tools to `mcp-core`: one MCP tool per exposed command in `command-catalog.json`, named from its path (`sentry issue list` → `sentry_issue_list`), with the catalog's brief, examples, and `{ positional, flags }` JSON Schema. Annotations from the permission class (read → `readOnlyHint`, write and destructive → `destructiveHint`; `sentry api` is one tool marked destructive, classed per call by `--method`). No `search_sentry` or `execute_*` meta-tools; harnesses search tools themselves (#1891 is folded in). Each call gets schema validation, session constraints, a result size cap that keeps JSON valid, and cursors. Verify `pnpm run measure-tokens` for the full list.
- [ ] 3.2 (#1890) Serve them from `sentry mcp --commands`, next to the catalog, running commands through `createSentrySDK()` with the session's credentials. Refuse hidden and stdio-only commands, local-path flags, and `--web`; reject streaming flags; buffer multi-yield commands. Add `--read-only`, which drops the write tools and limits `sentry api` to GET, HEAD, and OPTIONS. Verify tests for each permission class, constraint pinning, an invalid parameter returning the allowed values, a hidden or stdio-only command not listed, write tools absent under `--read-only`, the tool list matching the catalog's exposed commands, and `/mcp-qa` over stdio.
- 3.3 (#1891) Folded into 3.1 and 3.2: every exposed command is its own tool, and there is no separate search mode.
- [ ] 3.4 (#1892) Add `format: "markdown"` for commands with a plain markdown renderer. Verify a test for `issue view` and `trace view`.

## 4. API routes

- [ ] 4.1 (#1893) Expose `sentry api` and `sentry schema`. A `sentry api` call's permission class comes from its method, and hosted checks the path against the published operation list with #1807's shared matcher. Verify a raw read, a raw write denied under `--read-only`, and an unpublished path refused on hosted.
- [ ] 4.2 (#1894) Move `sentry schema`'s index onto `@sentry/api`'s operation catalog. Verify `sentry schema` output is unchanged.

## 5. Completion for agents

- [ ] 5.1 (#1895) Split the completers in `lib/complete.ts` into completers over a data source: the SQLite cache with a live API fallback on stdio, the live API, uncached, on hosted. Verify the shell completion tests pass unchanged.
- [ ] 5.2 (#1895) Wire them into the command tools' validation errors, returning candidates with descriptions; static suggestions stay in each parameter's schema `examples`. There is no completion tool. Verify tests for slugs, issue IDs, dataset fields and aggregates, and query keys and values.
- [ ] 5.3 (#1896) Document the query syntax in the tool descriptions of the search commands, replacing the embedded search agents' prompts.

## 6. The CLI SDK on the hosted MCP

- [ ] 6.1 (#1882) Spike: bundle `createSentrySDK()` with the exposed commands for workerd under `nodejs_compat` and a current compatibility date. Record what fails to bundle or run, by module and command, and the bundle size against the Workers script limit, in design.md. Mark blocked commands stdio-only.
- [ ] 6.2 (#1897) Add a no-persistence mode to the SDK: `getDatabase()` callers get a null store (reads miss, writes do nothing), and the response cache, `.sentryclirc` and config-directory reads, custom CA and header files, version checks, and telemetry state are off. Hosted rejects the `next`/`prev` cursor keywords; agents pass the raw `nextCursor`. Verify tests that run an exposed read command, a write command, and a paginated list with persistence off and no config directory.
- [ ] 6.3 (#1898) Audit module-level state on the exposed commands' import graph (for example `regionCache` in `lib/region.ts`, `loginTrustAnchor` in `lib/token-host.ts`, cached headers in `lib/custom-headers.ts`), and scope each item to the invocation or turn it off with persistence. Verify a test that runs two identities concurrently in one isolate and checks that neither sees the other's credentials, constraints, or results.
- [ ] 6.4 (#1899) In `mcp-cloudflare`'s Hono app, create one SDK instance per request with the OAuth grant's token and the session constraints, persistence off. Verify Workers tests for an exposed read command, a write command, and constraint pinning.
- [ ] 6.5 (#1899) Serve the command tools from `mcp-cloudflare` on the SDK, next to the catalog, listing only commands the hosted build can run. Verify the Workers tests and the #1675 harness against the command surface.
- [ ] 6.6 (#1907) Map hosted consent to permission classes: API Read, API Write, and the existing skills as command groups. Verify a test per grant.
- [ ] 6.7 For any domain the spike blocks entirely, split its commands into input resolution and a portable operation (formerly `unify-sentry-api-layer` 11.1), for that domain only.
- [ ] 6.8 (#1908) Compare the CLI's OAuth scopes with the MCP `SCOPES` and widen the CLI's if needed. Verify a test that the CLI's scopes cover every exposed command's operations. (Formerly 11.5.)

## 7. Slim stdio bundle

- [ ] 7.1 (#1909) Bundle the exposed command handlers and the SDK into `@sentry/mcp-server`, keeping the guard against stdio-only and hidden commands, Ink, the terminal renderer, and SQLite WASM. Re-measure the size budget. The package stays. Verify the bundle test (`initialize`, `tools/list`, a `sentry_issue_list` call against mocks).

## 8. Eval gate and cutover

- [ ] 8.1 (#1910) Run the full `mcp-server-evals` suite on the catalog and the command tools, with at least two clients or models. Record task success, tokens, and turns in `docs/testing/`.
- [ ] 8.2 (#1911) Make the command surface the default on stdio and hosted once it matches the catalog. Keep the catalog behind `--catalog` and a hosted skill for one release.
- [ ] 8.3 (#1911) Delete the catalog tools, their `SentryApiService` endpoint wrappers, the embedded search agents, and the agent provider configuration from `mcp-core`. Verify `pnpm run tsc && pnpm run lint && pnpm run test`.
- [ ] 8.4 (#1911) Update mcp.sentry.dev setup, `docs/` architecture and operations pages, and the agent skills for the command surface.

## 9. Later: Code Mode over the SDK (optional)

- [ ] 9.1 If 8.1 shows multi-step tasks losing to Code Mode (#1670), add `execute_sentry_code` whose `sentry` object calls the same execution path, permission checks included, in #1670's sandbox on hosted. Decide the stdio sandbox then.
