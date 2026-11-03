# Design

## Context

- The CLI's command tree is introspectable at runtime (`lib/introspect.ts`,
  `sentry help --json`) and at build time (`generate-skill.ts`,
  `generate-command-api.ts`). `src/generated/command-api.json` records which
  API operations each command calls, and commands declare `destructive`
  (`lib/command.ts`).
- `createSentrySDK()` (`src/index.ts`, `lib/sdk-invoke.ts`) calls command
  handlers directly with typed flags and returns their data, buffering
  commands that yield more than once. It needs Node: SQLite, the
  filesystem, `node:os`.
- `sentry schema` (`commands/schema.ts`, `lib/api-schema.ts`) searches the
  published API index from `@sentry/api`, and `sentry api` sends any
  request.
- Shell completion is declared for every positional and flag (#1751, #1759)
  and completes dataset fields and aggregates (#1782). Completers read the
  SQLite completion cache, warmed at login (#1788, #1789).
- HTTP Code Mode (#1670, evals in #1675) runs agent JavaScript in a
  Cloudflare Dynamic Worker with no token and no network. A broker in the
  parent Worker checks each request against the shipped operation list and
  the connection's API Read or API Write grant, then sends it through
  `SentryApiService`.
- The hosted MCP runs on Cloudflare Workers. CLI command handlers do not run
  there.

## Goals / Non-Goals

Goals:

- One product surface: CLI commands. The MCP adds no Sentry logic of its own.
- Agents can do anything a command can, plus any published API operation.
- The same discovery, completion, and permission rules on stdio and hosted.

Non-goals:

- Running the full CLI on Workers. Hosted runs portable operations only.
- Changing the hosted MCP's OAuth flow or moving it off Workers.
- Keeping the catalog's agent-tuned output formats. Code returns data, and
  can ask for the CLI's markdown rendering where that helps.

## Decisions

### Commands are the only product surface

A capability an agent needs is a CLI command, built on `@sentry/api`. The
MCP gets no new hand-written tools; pending tool PRs (for example #1846,
#1837, #1517) become commands. Fixes to existing catalog tools are fine until
the cutover, since they ship to users now.

### CLI parity inventory

From a listing of `mcp-core/src/tools/catalog/` against
`cli/src/commands/` (by name and brief, not by behavior; each row is checked
when its command lands):

| MCP catalog tools                                                                                    | CLI today                                                          | Gap                                                            |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| `whoami`, `find_organizations`, `find_projects`, `find_teams`, `find_dsns`                           | `auth whoami`, `org list`, `project list`, `team list`, `dsn list` | none                                                           |
| `create_project`                                                                                     | `project create`                                                   | none                                                           |
| `update_project`                                                                                     | none                                                               | `project edit`                                                 |
| `create_team`, `add_team_to_project`, `remove_team_from_project`                                     | none                                                               | `team create`, `project team add/remove`                       |
| `create_dsn`, `update_dsn`                                                                           | none                                                               | `dsn create`, `dsn edit`                                       |
| `search_issues`, `get_issue_details`, `search_issue_events`, `get_issue_tag_values`                  | `issue list/view/events/tags`                                      | none                                                           |
| `update_issue`                                                                                       | `issue resolve/unresolve/archive`                                  | assignment: `issue assign`                                     |
| `add_issue_note`, `get_issue_activity`                                                               | none                                                               | `issue comment`, `issue activity`                              |
| `get_issue_breadcrumbs`, `get_issue_user_reports`                                                    | partly in `event view`, `feedback list`                            | check, then flags or commands                                  |
| `link_issue`, `unlink_issue`, `analyze_issue_with_seer`                                              | `issue link/unlink/explain/plan`                                   | none                                                           |
| `get_event_stacktrace`                                                                               | `event view`                                                       | none                                                           |
| `get_event_attachment`                                                                               | none                                                               | `event attachment list/download`                               |
| `search_events`, `search_errors`, `search_logs`, `search_traces`, `search_metrics`, `search_replays` | `event list`, `explore`, `log list`, `trace list`, `replay list`   | metrics dataset to check; no natural-language mode (see below) |
| `get_trace_details`, `get_span_details`, `get_replay_details`                                        | `trace view`, `span view`, `replay view`                           | none                                                           |
| `search_profiles`, `get_profile`, `get_profile_details`                                              | none                                                               | `profile list/view`                                            |
| `search_attributes`                                                                                  | `attribute list`                                                   | none                                                           |
| `search_agent_conversations`, `get_agent_conversation_details`                                       | `agent-conversation list/view`                                     | none                                                           |
| `find_dashboards`, `get_dashboard_details`                                                           | `dashboard list/view`                                              | none                                                           |
| `find_releases`, `get_release_details`                                                               | `release list/view`                                                | none                                                           |
| alert rule and metric monitor CRUD, `get_alert_options`                                              | `alert issues ...`, `alert metrics ...`                            | `get_alert_options` to check                                   |
| `find_monitors`, `get_monitor_details`, `delete_monitor_environment`                                 | `monitor list`                                                     | `monitor view`, `monitor env delete`                           |
| uptime monitor CRUD (5 tools)                                                                        | none                                                               | `monitor uptime list/view/create/edit/delete`                  |
| `find_dropped_events`                                                                                | none                                                               | `event dropped` or similar (#1812 open)                        |
| `get_snapshot`, `get_latest_base_snapshot`, `get_snapshot_image`                                     | `snapshots download/diff`                                          | read commands to check                                         |
| `get_sentry_resource`                                                                                | URL positionals on most commands                                   | a generic `sentry open <url>` resolver                         |
| `search_docs`, `get_doc`, `submit_feedback_to_sentry_team`                                           | `docs list/query`, `cli feedback`                                  | none                                                           |
| `get_sentry_mcp_info`, `onboarding_status_update`                                                    | MCP-specific                                                       | keep as host functions or drop                                 |

About 20 tools have no command yet, and a few more are partial. Each gap
is a command PR, grouped by domain.

### The MCP surface: `search_sentry` and `execute_sentry_code`

Two tools, on stdio and hosted:

- **`search_sentry`** takes a free-text query and returns compact entries:
  commands (path, brief, positionals and flags with types and completion
  kinds, examples, output fields, permission class) and API operations
  (method, path, summary, parameters). An entry can be expanded to a
  TypeScript signature for the matching `sentry.*` call. It also takes a
  partial argv and returns completions (see below).
- **`execute_sentry_code`** runs an async JavaScript body with one global,
  `sentry`:
  - `sentry.<group>.<command>(params)`: the `createSentrySDK()` method,
    returning the command's data. `{ render: "markdown" }` returns the
    command's plain markdown output instead, for commands whose terminal
    rendering already summarizes well, such as `issue view` or `trace view`.
  - `sentry.api.request({ method, path, query, body })`: a published API
    operation, as `sentry api` sends it.
  - `sentry.complete(argv)`: completion candidates.

The tool descriptions stay small; agents learn the surface through
`search_sentry`, not from a full type declaration in the tool list.

### The sandbox orchestrates; the host runs commands

The agent's code never runs CLI code and never sees a credential. Each
`sentry.*` call is an RPC to the host:

1. The host checks the call against the connection's permissions and
   constraints.
2. It runs the command operation, or the API request, with its own
   credentials.
3. It returns the data, size-capped, to the sandbox.

This keeps one execution model with two hosts:

- **stdio (`sentry mcp`):** the host is the CLI process. It runs commands
  through `createSentrySDK()` in Node, so every command works there as soon
  as it exists, with the CLI's login, cache, and region lookup. The sandbox
  is an in-process WebAssembly JavaScript engine (QuickJS); `node:vm` is not
  a security boundary.
- **hosted (`mcp-cloudflare`):** the host is the parent Worker and the
  sandbox is the Dynamic Worker from #1670. The host runs portable
  operations from the CLI's `sentry/mcp` entry (next decision).

### Portable operations for the hosted host

The hosted MCP can list every command but can only run commands whose API
work is portable. Commands split, domain by domain, into:

- **resolve** (host-specific): CLI flags, cwd, config, DSN detection; or
  Code Mode parameters and session constraints;
- **operate** (portable): resolved inputs and an `@sentry/api` client in,
  the command's data out;
- **render**: the existing `output.human` and JSON modes.

`operations/` gets the portability guard from `unify-sentry-api-layer`
(no `node:*` imports or Node globals, a DOM-only typecheck) and ships as
the `sentry/mcp` entry with the Code Mode host. Generated metadata marks
each command `portable`; the hosted `search_sentry` shows only portable
commands, so hosted coverage grows as domains move. Commands with unbounded
streams (`--follow`, tail) are not exposed. Commands that need local files
(uploads, `init`, `sourcemap inject`) stay CLI-only.

This replaces group 11 of `unify-sentry-api-layer`, except that MCP tools no
longer move into the CLI one by one: the Code Mode host exposes operations
generically.

### One introspection source

`sentry mcp` reads the route tree at runtime with `lib/introspect.ts`. The
build generates the same metadata as JSON (`command-catalog.json`: commands,
parameters, completion kinds, output fields, the API operations from
`command-api.json`, the permission class, `portable`), and the hosted MCP
reads that from the `sentry/mcp` entry. A test fails when the two differ.

### API routes: one index for `sentry schema` and Code Mode

`sentry schema` and #1670's `search_sentry_api` index the same `@sentry/api`
release separately. Both move to `@sentry/api`'s operation catalog
(`@sentry/api/operations`), and Code Mode's path matching uses the shared
matcher from #1807. Only published operations are reachable; endpoints the
CLI or MCP call that are not in the published schema are the main gap, and
`unify-sentry-api-layer` handles them.

### Completion for agents

Completers in `lib/complete.ts` read the SQLite completion cache. They are
split into portable completers that take a data source:

- **stdio:** the SQLite cache, as for the shell, with a live API fallback.
- **hosted:** the live API through the shared client, with the in-memory
  response cache.

`sentry.complete(argv)` and `search_sentry`'s completion mode return
candidates with descriptions for the argument under the cursor: slugs,
issue IDs, enum values, dataset fields and aggregates, and search query
keys and values. This is how agents get valid queries without the catalog's
embedded search agents.

### Embedded natural-language search agents are dropped

`search_events`, `search_issues`, and `search_issue_events` translate
natural language with a second model call. Under Code Mode the calling agent
writes the query itself, with `search_sentry` documentation of the query
syntax and `sentry.complete()` for keys and values. Dropping them removes
the MCP's OpenAI and Anthropic provider configuration (#1754 becomes moot).

### Permissions are command metadata

Each command gets a permission class from its API operations in
`command-api.json`: **read** if it calls only GET, HEAD, or OPTIONS;
otherwise **write**; and **destructive** if it declares `destructive`. A
lint check fails when the class is missing or disagrees with the operations.

- Hosted consent keeps #1670's API Read and API Write grants. API Read
  allows read commands; API Write allows write commands and raw writes.
  Destructive commands need API Write. The existing skill checkboxes
  (Triage Issues, Manage Projects & Teams, and so on) map to command groups
  until consent is simplified.
- Organization and project constraints from the session (`sentry mcp
  <org>/[<project>]`, hosted URL constraints) fill and pin command inputs in
  the resolve step.
- The host still checks every outgoing API request against the operation
  list and grant (#1670's `ApiAuthorization`), so a command cannot exceed
  the connection's grant.
- stdio adds `--read-only`, matching hosted API Read.

### `@sentry/mcp-server` carries operations, not commands

The slim bundle (#1731) bans command handlers and has a 3.75 MB budget.
Under Code Mode it needs the operations and the Code Mode host. It bundles
the `sentry/mcp` entry plus the stdio host and QuickJS, and its guard keeps
banning command handlers, Ink, the markdown terminal renderer, and SQLite
WASM. The budget is re-measured when the QuickJS sandbox lands. Commands
that are not yet portable are unavailable in the slim bundle and available
in `sentry mcp`.

### Eval-gated cutover

Code Mode ships next to the catalog:

1. Extend #1675's harness to run the full `mcp-server-evals` suite on three
   surfaces: catalog, Code Mode, and both.
2. Make Code Mode the default when it matches or beats the catalog on task
   success, and record token cost and latency next to it. Run more than one
   client and model, not only Claude Opus.
3. Keep the catalog behind a flag (`--catalog`, a hosted skill) for one
   release.
4. Delete the catalog tools, their `SentryApiService` endpoint wrappers,
   the search agents, and the provider configuration from `mcp-core`.

## Risks / Trade-offs

- **Weaker clients.** Code Mode depends on the model writing correct
  JavaScript. Small models and clients that cap tool calls may do worse than
  with typed tools. The eval gate runs several models, and the flag keeps
  the catalog available during the window.
- **Output quality.** Catalog tools format stack traces, traces, and issue
  summaries for agents. `render: "markdown"` reuses the CLI's renderers for
  those commands; the evals check the gap.
- **Hosted coverage lags stdio.** Commands appear on hosted only when their
  domain is portable. The parity table and `portable` flags make that
  visible.
- **Sandbox on stdio.** QuickJS adds bundle size and its own escape surface.
  It runs no host code and holds no credentials; every capability is an
  RPC the host checks.
- **Unpublished endpoints.** Commands and raw requests can only reach what
  `@sentry/api` covers. See `unify-sentry-api-layer`.

## Migration Plan

1. Command metadata (permission class, `portable`, generated catalog) and the
   parity commands, by domain.
2. Code Mode on stdio over `createSentrySDK()`, behind a flag, with the
   QuickJS sandbox and completion.
3. `sentry schema` and Code Mode on one `@sentry/api` operation index.
4. Hosted Code Mode (#1670) on portable operations, domain by domain.
5. Eval gate, default flip, catalog deletion.

**Rollback:** until the catalog is deleted, the flag switches back. After
that, a revert of the deletion PR restores it.

## Open Questions

- Whether `get_sentry_mcp_info` and `onboarding_status_update` survive as
  host functions on `sentry` or are dropped.
- The QuickJS bundle cost, and whether Node's permission model is good
  enough on supported Node versions to use a worker thread instead.
- When to simplify hosted consent from skill checkboxes to API Read, API
  Write, and destructive.
