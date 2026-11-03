# Tasks

The API work these tasks build on is `unify-sentry-api-layer`. New commands
use `@sentry/api` operations and do not wait for the shared client to move
there.

## 1. Command metadata for agents

- [ ] 1.1 Add a permission class (read, write, destructive) to every command, derived from its operations in `command-api.json` and its `destructive` flag, with a lint check that fails when a class is missing or disagrees with the operations. Verify the check fails on a planted GET-only command marked write and a write command marked read.
- [ ] 1.2 Generate `command-catalog.json` from the route tree: path, brief, parameters with types and completion kinds, examples, output fields, API operations, permission class, and `portable`. Verify a test that it matches `lib/introspect.ts` output for the full tree.

## 2. CLI parity with the MCP catalog

One PR per domain. Each adds the commands from the parity table in design.md, on `@sentry/api` operations, with unit tests, and ticks its rows. Pending MCP tool PRs for the same capability are redirected here.

- [ ] 2.1 Projects and teams: `project edit`, `team create`, `project team add/remove`. Supersedes `refine-project-management-tools`.
- [ ] 2.2 DSNs: `dsn create`, `dsn edit`.
- [ ] 2.3 Issues: `issue assign`, `issue comment`, `issue activity`; breadcrumbs and user reports where `event view` and `feedback list` fall short.
- [ ] 2.4 Events: `event attachment list/download`; dropped events (#1812).
- [ ] 2.5 Monitors: `monitor view`, `monitor env delete`, `monitor uptime list/view/create/edit/delete` (the detectors work in #1837 moves here).
- [ ] 2.6 Profiles: `profile list/view`.
- [ ] 2.7 Snapshots, alert options, and the metrics dataset in `explore`: check against the MCP tools and fill the gaps.
- [ ] 2.8 `sentry open <url>`: resolve any Sentry URL to the matching resource and command.
- [ ] 2.9 Mark every row in the parity table done or dropped, with the reason.

## 3. Code Mode on stdio

- [ ] 3.1 Add the Code Mode tool definitions (`search_sentry`, `execute_sentry_code`) to `mcp-core`, reusing #1670's descriptions and result handling. Verify `pnpm run measure-tokens`.
- [ ] 3.2 Add the stdio host in the CLI: a QuickJS sandbox with a `sentry` global whose calls are RPCs to the host, which runs them through `createSentrySDK()` with the session's credentials, constraints, and permission class, and size-caps results. Multi-yield commands are buffered; streaming commands are not exposed. Verify tests for each permission class, constraint pinning, a call that exceeds the result cap, and that the sandbox has no network or host globals.
- [ ] 3.3 Serve it from `sentry mcp --code-mode`, next to the catalog. Add `--read-only`. Verify `/mcp-qa` over stdio.
- [ ] 3.4 Add `render: "markdown"` for commands with a plain markdown renderer. Verify a test for `issue view` and `trace view`.

## 4. API routes in Code Mode

- [ ] 4.1 Move `sentry schema`'s index and #1670's API search onto `@sentry/api`'s operation catalog, with #1807's shared path matcher. Verify `sentry schema` output and the Code Mode search tests are unchanged.
- [ ] 4.2 Add `sentry.api.request()` on stdio, with the same operation list and permission checks as hosted. Verify a raw read, a raw write denied under `--read-only`, and an unpublished path refused.

## 5. Completion for agents

- [ ] 5.1 Split the completers in `lib/complete.ts` into portable completers over a data source: the SQLite cache with a live API fallback on stdio, the live API with the memory response cache on hosted. Verify the shell completion tests pass unchanged.
- [ ] 5.2 Add `sentry.complete(argv)` and `search_sentry`'s completion mode, returning candidates with descriptions. Verify tests for slugs, issue IDs, dataset fields and aggregates, and query keys and values.
- [ ] 5.3 Document the query syntax in `search_sentry` results for the search commands, replacing the embedded search agents' prompts.

## 6. Hosted Code Mode on the CLI

- [ ] 6.1 Land #1670 (HTTP Code Mode), #1675 (evals), and #1807 (shared path matcher) as the hosted base.
- [ ] 6.2 Split commands into resolve, operate, and render, domain by domain, starting with the read domains the evals use most (issues, events, traces, organizations and projects). Operations move to `operations/` and return the command's data. Verify the CLI unit and SDK tests pass with output unchanged. (Formerly `unify-sentry-api-layer` 11.1.)
- [ ] 6.3 Guard `operations/` and the Code Mode host with the portability checks and expose them as the `sentry/mcp` entry. Verify the guard fails on a planted `node:` import, and that `mcp-cloudflare` bundles the entry without command handlers, SQLite, or Ink. (Formerly 11.2.)
- [ ] 6.4 Switch hosted Code Mode to the `sentry/mcp` host: `search_sentry` lists portable commands from `command-catalog.json`, `execute_sentry_code` runs their operations, and `sentry.api.request()` keeps #1670's broker. Verify the Workers tests and the #1675 evals.
- [ ] 6.5 Map hosted consent to permission classes: API Read, API Write, destructive, and the existing skills as command groups. Verify a test per grant.
- [ ] 6.6 Allow `mcp-cloudflare` to import only `sentry/mcp` from `sentry`. Verify the rule fails on a planted import. (Formerly 11.7.)
- [ ] 6.7 Compare the CLI's OAuth scopes with the MCP `SCOPES` and widen the CLI's if needed. Verify a test that the CLI's scopes cover every command's operations. (Formerly 11.5.)

## 7. Slim stdio bundle

- [ ] 7.1 Bundle the `sentry/mcp` entry, the stdio host, and QuickJS into `@sentry/mcp-server`, keeping the guard against command handlers, Ink, the terminal renderer, and SQLite WASM. Re-measure the size budget. Verify the bundle test (`initialize`, `tools/list`, an `execute_sentry_code` call against mocks).

## 8. Eval gate and cutover

- [ ] 8.1 Run the full `mcp-server-evals` suite on catalog, Code Mode, and both, with at least two clients or models. Record task success, tokens, and latency in `docs/testing/`.
- [ ] 8.2 Make Code Mode the default on stdio and hosted once it matches the catalog. Keep the catalog behind `--catalog` and a hosted skill for one release.
- [ ] 8.3 Delete the catalog tools, their `SentryApiService` endpoint wrappers, the embedded search agents, and the agent provider configuration from `mcp-core`. Verify `pnpm run tsc && pnpm run lint && pnpm run test`.
- [ ] 8.4 Update mcp.sentry.dev setup, `docs/` architecture and operations pages, and the agent skills for the Code Mode surface.
