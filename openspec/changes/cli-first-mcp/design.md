# Design

## Context

- The CLI's command tree is introspectable at runtime (`lib/introspect.ts`,
  `sentry help --json`) and at build time (`generate-skill.ts`,
  `generate-command-api.ts`). `src/generated/command-api.json` records which
  API operations each command calls, and commands declare `destructive`
  (`lib/command.ts`).
- `createSentrySDK()` (`src/index.ts`, `lib/sdk-invoke.ts`) calls command
  handlers directly with typed flags and returns their data, buffering
  commands that yield more than once. It takes a token, URL, org, project,
  and `cwd` per instance, and scopes the environment per call with
  `AsyncLocalStorage` (`lib/env.ts`).
- The CLI's local state goes through one synchronous SQLite adapter
  (`lib/db/sqlite.ts`: `node:sqlite` `DatabaseSync`, or a WASM fallback),
  opened as a module-level singleton by `getDatabase()` in 23 files. A
  `detached` mode already uses an in-memory database.
- In `commands/` and `lib/`, 156 files import `node:` modules. The most
  common are `path`, `fs`, `fs/promises`, `os`, `child_process` (23 files),
  `tty` (14), and `crypto`.
- `sentry schema` (`commands/schema.ts`, `lib/api-schema.ts`) searches the
  published API index from `@sentry/api`, and `sentry api` sends any
  request.
- Shell completion is declared for every positional and flag (#1751, #1759)
  and completes dataset fields and aggregates (#1782). Completers read the
  SQLite completion cache, warmed at login (#1788, #1789).
- HTTP Code Mode (#1670, evals in #1675) runs agent JavaScript in a
  Cloudflare Dynamic Worker with no token and no network. A broker in the
  parent Worker checks each request against the shipped operation list and
  the connection's API Read or API Write grant.
- The hosted MCP runs on Cloudflare Workers (`compatibility_date`
  2025-03-21, with KV and no Durable Objects or D1 today). CLI command
  handlers do not run there yet.

## Goals / Non-Goals

Goals:

- One product surface: CLI commands. The MCP adds no Sentry logic of its own.
- Agents can do anything a command can, plus any published API operation.
- The same discovery, completion, and permission rules on stdio and hosted.

Non-goals:

- Running commands that need the user's machine on Workers: local files,
  child processes, the terminal.
- Changing the hosted MCP's OAuth flow or moving it off Workers.
- A code-execution sandbox. Code Mode (#1670) can come later as an extra
  tool over the same SDK.
- Keeping the catalog's agent-tuned output formats. Commands return data,
  and can return their own markdown rendering where that helps.

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

### Two tools: `search_sentry` and `execute_sentry_command`

The MCP hides the command tree behind two tools, so the tool list stays
small however many commands the CLI has (well over 100 leaf commands):

- **`search_sentry`**
  - `query`: free text. Returns ranked commands with path, brief,
    permission class, and whether the host can run it.
  - `command`: a command path such as `issue list`. Returns its input schema
    (positionals and flags as JSON Schema, from introspection), examples,
    and output fields.
  - `complete`: a command, a parameter, the value typed so far, and the
    other parameters. Returns completion candidates (see below).
- **`execute_sentry_command`** takes `{ command, params }`:
  1. validates `params` against the command's schema; an invalid slug,
     enum value, or query key fails with completion candidates in the
     error;
  2. checks the command's permission class and the session's constraints;
  3. calls the matching `createSentrySDK()` method and returns its data,
     size-capped, with the next cursor for paginated commands. With
     `format: "markdown"` it returns the command's plain markdown output
     instead, for commands whose terminal rendering already summarizes
     well, such as `issue view` or `trace view`.

  Commands that yield more than once are buffered into one result, as the
  SDK does today. Streaming flags (`--follow`, tail) are rejected.

A second mode lists every exposed command as its own tool
(`sentry_issue_list`, with the same schema and description). It is for
harnesses that search large tool lists themselves. It comes from the same
metadata, so both modes always agree. The two-tool mode is the default.

#### How this differs from Code Mode

Code Mode (Cloudflare's term, and #1670) also hides tools behind search and
execute, but its execute tool takes a program: the model writes JavaScript
that calls several operations, loops, and filters, and only the program's
result goes back into context. That code is arbitrary, so it needs a sandbox.

`execute_sentry_command` runs one known command per call. The agent cannot
run anything that is not a command, and the parameters are validated data,
so there is nothing to sandbox. The cost is that multi-step work takes one
model turn per call, and intermediate results pass through context. Command
flags (`--limit`, `--fields`, queries) and `format` keep results small.
If evals show multi-step tasks need it, Code Mode can be added later as a
third tool whose `sentry` object calls the same `execute_sentry_command`
path, permission checks included.

### What is exposed

Every command declares how agents may use it, and a lint check fails when a
command has no declaration:

- **exposed**: available on stdio and hosted, once the hosted SDK build can
  run it.
- **stdio-only**: needs the user's machine: local files (uploads,
  `sourcemap inject`, `debug-files`, `init`), DSN detection from the `cwd`,
  or the terminal.
- **hidden**: never exposed: session management (`auth login`,
  `auth logout`), CLI maintenance (`cli upgrade`, `cli setup`,
  `cli uninstall`), `local`, and `monitor run`, which runs an arbitrary
  child process.

### The CLI SDK on Workers, without persistence

The hosted MCP runs commands through `createSentrySDK()` too, rather than
through a second, portable copy of each command. The hosted MCP's Hono app
creates one SDK instance per request, with the token from the OAuth grant
and the org and project from the session constraints.

**No persistence.** Everything the CLI persists is for a long-lived,
single-user install: stored accounts and tokens, defaults, release channel
and version checks, pagination cursor stacks, and caches (projects, DSNs,
aliases, regions, repos, issue orgs, completion values, project roots, the
response cache). A server needs none of it. The SDK already takes a token
(`createSentrySDK({ token })` sets `SENTRY_AUTH_TOKEN` and
`SENTRY_FORCE_ENV_TOKEN` for that invocation), and with an env token the
auth code never reads the `accounts` table. So hosted runs the SDK with
persistence off:

- `getDatabase()` callers (23 files, 20 of them in `lib/db/`) get a null
  store: reads miss and writes do nothing. An in-memory SQLite database is
  not an option, since workerd has no SQLite driver for the CLI's adapter.
- The response cache, `.sentryclirc` and config-directory reads, custom CA
  and header files, version checks, and telemetry state are off.
- Pagination is stateless. List commands already return `nextCursor` in
  their JSON envelope and accept a raw cursor, so hosted rejects the
  `next`/`prev` keywords, which need the stored cursor stack, and the
  agent passes the cursor it got back.
- Org-to-region lookups happen on every call that needs them. If that
  latency matters, an in-memory cache keyed by token fingerprint comes
  later, measured first.

D1, R2, and Durable Object storage are not needed. Commands that read or
write local files are stdio-only.

**Per-request state.** One SDK instance per request isolates what lives in
the instance and in `withEnv()`'s `AsyncLocalStorage`, but not module
scope: a Workers isolate reuses its modules across concurrent requests. The
auth path is already per invocation (token memos are keyed by the
invocation's env, and env tokens skip stored accounts). Some module-level
state is not, for example `regionCache` in `lib/region.ts` (keyed by org
slug only), `loginTrustAnchor` in `lib/token-host.ts`, and the cached
headers in `lib/custom-headers.ts`. With persistence off, the work is to
audit module-level state on the exposed commands' import graph and either
scope each item to the invocation or turn it off on hosted. A test runs
two identities concurrently in one isolate and checks that neither sees
the other's credentials, constraints, or results.

**Node built-ins.** `nodejs_compat` provides `path`, `crypto`, `util`,
`zlib`, `async_hooks`, and timers. It does not provide `child_process`,
`tty`, or an HTTP server, and its `fs` is an in-memory file system that
likely needs a newer compatibility date than the hosted MCP uses (to confirm in the spike). What matters is
what the exposed commands import transitively, which only a build answers.
So the first task is a spike: bundle the SDK for workerd with the exposed
commands, and list what fails to bundle or run, and the bundle size against
the Workers script limit.

Commands whose imports cannot be made Workers-safe are marked stdio-only
until fixed. If a whole domain is blocked, that domain's commands split into
input resolution and a portable operation (the old
`unify-sentry-api-layer` 11.1), for that domain only.

### One introspection source

`sentry mcp` reads the route tree at runtime with `lib/introspect.ts`. The
build generates the same metadata as JSON (`command-catalog.json`: commands,
JSON Schema for parameters, completion kinds, examples, output fields, the
API operations from `command-api.json`, the permission class, and the
exposure), and the hosted MCP reads that. A test fails when the two differ.

### API routes through `sentry api` and `sentry schema`

`sentry schema` and `sentry api` are exposed commands, so agents search the
published API with `execute_sentry_command({ command: "schema", ... })` and
call any published operation with `sentry api`. The permission class of a
`sentry api` call comes from its method, and hosted checks the path against
the published operation list with #1807's shared matcher, as #1670's broker
does. `sentry schema`'s index moves onto `@sentry/api`'s operation catalog
(`@sentry/api/operations`). Endpoints missing from the published schema
are the main gap, and `unify-sentry-api-layer` 8.8 handles them.

### Completion for agents

Completers in `lib/complete.ts` read the SQLite completion cache. They are
split into completers over a data source:

- **stdio:** the SQLite cache, as for the shell, with a live API fallback.
- **hosted:** the live API, uncached.

`search_sentry`'s `complete` mode and `execute_sentry_command`'s validation
errors return candidates with descriptions for the parameter in question:
slugs, issue IDs, enum values, dataset fields and aggregates, and search
query keys and values. This is how agents build valid queries without the
catalog's embedded search agents.

### Embedded natural-language search agents are dropped

`search_events`, `search_issues`, and `search_issue_events` translate
natural language with a second model call. Under this plan the calling agent
writes the query itself, using the query syntax in the command's
`search_sentry` entry and completion for keys and values. Dropping them
removes the MCP's OpenAI and Anthropic provider configuration (#1754 becomes
moot).

### Permissions are command metadata

Each command gets a permission class from its API operations in
`command-api.json`: **read** if it calls only GET, HEAD, or OPTIONS;
otherwise **write**; and **destructive** if it declares `destructive`. A
lint check fails when the class is missing or disagrees with the operations.

- Hosted consent keeps #1670's API Read and API Write grants. API Read
  allows read commands; API Write allows write and destructive commands.
  The existing skill checkboxes (Triage Issues, Manage Projects & Teams, and
  so on) map to command groups until consent is simplified.
- Organization and project constraints from the session (`sentry mcp
  <org>/[<project>]`, hosted URL constraints) fill and pin command
  parameters; a call for another organization is refused.
- stdio adds `--read-only`, matching hosted API Read.

### `@sentry/mcp-server` needs the exposed commands

The slim bundle (#1731) bans command handlers and has a 3.75 MB budget.
Under this plan it must carry the exposed command handlers, since that is
what its tools run. It bundles them with the SDK and keeps banning the
stdio-only and hidden commands, Ink, the terminal markdown renderer, and
SQLite WASM. The budget is re-measured. The package stays; whether installs
move to `npx sentry mcp` later is out of scope here.

### Eval-gated cutover

The command surface ships next to the catalog:

1. Extend #1675's harness to run the full `mcp-server-evals` suite on the
   catalog, the two-tool mode, and the all-tools mode.
2. Make the command surface the default when it matches or beats the
   catalog on task success, and record token cost and turn count next to
   it. Run more than one client and model.
3. Keep the catalog behind a flag (`--catalog`, a hosted skill) for one
   release.
4. Delete the catalog tools, their `SentryApiService` endpoint wrappers,
   the search agents, and the provider configuration from `mcp-core`.

## Risks / Trade-offs

- **More turns than Code Mode** for multi-step tasks. The evals record turn
  count; Code Mode stays available as a later addition.
- **Output quality.** Catalog tools format stack traces, traces, and issue
  summaries for agents. `format: "markdown"` reuses the CLI's renderers; the
  evals check the gap.
- **Cross-user leaks on hosted.** With persistence off, the remaining risk
  is module-level state shared by concurrent requests in one isolate. The
  concurrent two-identity test is required before hosted serves any
  command.
- **Extra round trips on hosted.** Without caches, region and slug
  resolution hit the API on every call. Measure before adding a cache.
- **Workers compatibility.** Unknown until the spike. Commands that fail
  stay stdio-only, so hosted coverage can lag stdio.
- **Tool descriptions come from CLI help text.** Weak help text makes weak
  tools. Improving it improves both the CLI and the MCP.
- **Unpublished endpoints.** Commands and `sentry api` can only reach what
  `@sentry/api` covers. See `unify-sentry-api-layer`.

## Migration Plan

1. Command metadata (permission class, exposure, generated catalog) and the
   parity commands, by domain.
2. The two tools on stdio over `createSentrySDK()`, behind a flag, with
   completion.
3. The Workers spike, then a no-persistence mode and the module-state
   audit, then hosted on the SDK.
4. Eval gate, default flip, catalog deletion.

**Rollback:** until the catalog is deleted, the flag switches back. After
that, a revert of the deletion PR restores it.

## Open Questions

- Which mode each client should default to: two tools, or every command as
  a tool for harnesses that search tools themselves.
- Whether `get_sentry_mcp_info` and `onboarding_status_update` survive.
- When to simplify hosted consent from skill checkboxes to API Read, API
  Write, and destructive.
