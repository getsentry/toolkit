# HTTP Code Mode evaluations

The agent evaluation harness tests tasks missing from the normal MCP catalog
through the real MCP transport and Dynamic Worker runtime. Sentry API responses
come from stateful local fixtures; an independent verifier checks persisted
state rather than accepting the agent's success claim.

See [HTTP Code Mode](code-mode.md) for the runtime, permissions and deployment
boundary. These evaluations do not exercise hosted OAuth or authorize production
writes. Historical successes are not fresh evaluations of every later runtime
change. SDK comparisons remain future work.

## Surfaces and fixtures

`packages/mcp-server-evals/src/code-mode/run-dashboard.ts` starts an authenticated
loopback API fixture and a local Wrangler Worker, then creates a fresh external
agent session. It never supplies a task algorithm. Each repetition resets state.

| Surface            | Available tools and agent instructions                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `code-mode`        | The two HTTP tools, with explicit instructions to use them; execution baseline only                           |
| `catalog-and-code` | Normal top-level tools/catalog plus Code Mode; Claude's default system prompt and an outcome-only user prompt |
| `catalog`          | The same normal catalog without Code Mode; negative control                                                   |

Natural discovery prompts do not mention Code Mode, JavaScript, HTTP, schemas or
tool names. The same MCP is named `sentry`; release examples in tool descriptions
avoid scaffolding dashboard copying. Discovery searches the full pinned OpenAPI
snapshot (159 paths / 254 operations), although only fixture routes execute.
No catalog-first sequence is required: selection is the behavior being measured.

All surfaces use an empty temporary directory and disable other MCP servers,
built-in tools, hooks, skills and persistence where supported by the client.
This is a controlled MCP selection test, not a test with every client capability
enabled. `discovery-worker.ts` uses the real core server and rejects non-loopback
API configuration. It is an eval-only composition, not hosted authorization.

The isolated entrypoint uses a direct bearer token held outside generated code.
Server-owned `API_BASE_URL`, `OPENAPI_URL` and `CODE_MODE_ALLOW_WRITES` configure
its API origin/prefix, trusted dereferenced schema and writes (false by default).
Evaluations supply local URLs, synthetic data, a dummy token and explicit writes
where needed. They do not call a real Sentry account.

| Task                  | Missing catalog capability             | Independent verification                                                                                                                                                  |
| --------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dashboard`           | Create dashboard copies                | Exactly two copies for two projects with environment `staging`; source, widgets, queries, order, layout, other filters and time range preserved; real IDs/links           |
| `release`             | Release/deploy writes                  | Exactly one release for two projects and one staging deploy; requested metadata/timestamps; original resources unchanged; actual deploy ID                                |
| `repositories`        | Repository listing                     | All 107 active records retrieved across pages; four matching GitHub repositories with exact IDs/names/URLs and count; sorted, no disabled results or writes               |
| `alert`               | Issue alert editing                    | Workflow disabled with frequency 60; conditions, actions, owner, environment, detector associations and another alert preserved at every write                            |
| `monitor`             | Cron monitor editing                   | Requested weekday schedule/timezone; name, slug, owner, enabled state, thresholds, notifications, per-environment mute state and another monitor preserved at every write |
| `release-recovery`    | Safe recovery after an ambiguous write | A deploy persists but its first POST response is 502; exactly one deploy must remain, with its real ID                                                                    |
| `repositories-retry`  | Read recovery                          | First inventory GET is 503; complete paginated result, no writes                                                                                                          |
| `repositories-denied` | Honest permission failure handling     | Persistent 403 yields JSON `blocked` with a reason; no invented inventory/writes and at most two denied collection attempts                                               |

The repository page cap is 100 and matching results exist on page two. Release
grading inspects all persisted deployments even though the API lists the latest
per project/environment. Alert/monitor graders inspect every successful write,
so later repairs cannot erase collateral changes. A blocked 403 outcome is a
successful evaluation of limitation handling, not a completed inventory.
Recovery variants reuse the original prompts; injected faults are not revealed.

Fixtures model CLI task semantics, not a benchmark run of the native CLI:
`sentry release create/finalize/deploy/deploys`, `sentry repo list`,
`sentry alert issues edit`, and `sentry api` for monitor changes. Routes were
checked against CLI revision `b625111aef9cc3a44abbed634a043fce8505366d` and Sentry
revision `b4b356554798716ceaeab74efdc095782be9ca16`. Auxiliary alert project,
detector and workflow reads were checked against Sentry revision
`c4b7b5f3502b7f7c2ae8edc9ae1da36c8a1c98a4`. Reports record provenance and source
hashes. Dashboard schema provenance is in `dashboard-fixture-data.json`.

Fixtures do not emulate query-language validation, quotas, feature flags, all
valid auxiliary routes or real authorization. Unimplemented fixture routes may
remain discoverable. Their 404s are not automatically product failures.

## Running evaluations

Use Node 24 for this checkout. After `pnpm install --frozen-lockfile`:

```bash
pnpm --filter '@sentry/mcp-core...' --if-present run build
pnpm --filter @sentry/mcp-cloudflare test:code-mode
pnpm --filter @sentry/mcp-cloudflare tsc:code-mode
pnpm --filter @sentry/mcp-server-evals test:code-mode
pnpm --filter @sentry/mcp-server-evals tsc:code-mode

# Natural selection, followed by a catalog-only control:
pnpm --filter @sentry/mcp-server-evals eval:code-mode:discovery --runs 3
pnpm --filter @sentry/mcp-server-evals eval:code-mode --client claude --surface catalog --runs 1

# Additional operations and failure recovery:
pnpm --filter @sentry/mcp-server-evals eval:code-mode:flows --runs 3
pnpm --filter @sentry/mcp-server-evals eval:code-mode:resilience --runs 5
pnpm --filter @sentry/mcp-server-evals eval:code-mode --client claude --surface catalog-and-code --task alert --runs 3

# Isolated execution baseline:
pnpm --filter @sentry/mcp-server-evals eval:code-mode --client claude --runs 3
pnpm --filter @sentry/mcp-server-evals eval:code-mode --client codex --model '<available-model>' --runs 3
```

Fixture tests and typechecks require no model credentials and run through the
package's `sentryCi` configuration. Model-based evals require an installed,
authenticated CLI session and use that account's model access. The server does
not call a model. The default Codex client requires an explicit available model;
discovery/control surfaces require Claude.

Codex uses `exec --ignore-user-config` with medium reasoning. Some built-in tools
and global `CODEX_HOME/AGENTS.md` may still be included. Claude uses its default
model unless overridden, records the resolved model, and sets medium effort.
The isolated baseline gives both clients the same task/instructions and rejects
outside tools. Claude discovery surfaces retain the default system prompt and
allow the selected MCP inventory. Keep client, model, settings and budgets fixed
when comparing changes; these are client benchmarks, not bare-model benchmarks.

Reports default to `.cache/code-mode/http-<task>-<client>-<surface>.json`.
`--report` selects another destination for one task only. Multi-task suites keep
separate reports. Failed verification still writes evidence and exits nonzero;
that includes catalog-only controls that cannot complete their task.

Reports retain requested/resolved model, client version, prompts, full inventory,
tool sequence, generated code, usage, API outcomes, state and implementation
hashes. Synthetic reports are local artifacts, not committed generated files.
Claude usage is taken once from its final aggregate: uncached input, cache
creation, cache reads and output remain separate. Do not count cached tokens as
free or sum aggregate and per-message usage. Subscription billing is not inferred
from client-reported dollar estimates.

## Historical dashboard evidence

The following pilot results predate the hosted authorization boundary and RPC
dispatcher. They establish fixture-backed behavior at their recorded revisions,
not production readiness or current success rates.

### Natural selection, 2026-10-26

Claude Code 2.1.263, resolved `claude-opus-5`, medium effort:

| Surface                    | Result          | Actual selection                              | MCP calls | API calls | Wall time |
| -------------------------- | --------------- | --------------------------------------------- | --------- | --------- | --------- |
| Catalog + Code Mode, run 1 | Pass            | Execute → schema search → execute             | 3         | 5         | 23.269 s  |
| Catalog + Code Mode, run 2 | Pass            | Execute → schema search → execute             | 3         | 7         | 21.889 s  |
| Catalog + Code Mode, run 3 | Pass            | Execute → schema search → execute             | 3         | 5         | 18.983 s  |
| Catalog-only control       | Cannot complete | Five catalog searches, two catalog executions | 7         | 2         | 31.338 s  |

Each combined run created two correct copies, preserved source/content/filters
and returned real IDs/links without API errors. The agent selected Code Mode
directly, read the source, inspected the create schema, then wrote and verified
copies. This demonstrates unprompted selection, not catalog-first fallback.
The control read the original, created nothing and reported its limitation.

Evidence: `.cache/code-mode/http-dashboard-natural-claude.json` and
`.cache/code-mode/http-dashboard-catalog-control-claude.json`. These four runs
cover one synthetic task, not broad reliability or savings. Per-user favorites
and dashboard permissions are outside the preservation grader.

### Isolated baseline, 2026-10-26

The same Claude client/model completed 3/3 repetitions with explicit Code Mode
instructions. Every run used two schema searches and two executions. Its final
execution read the source, created both copies and re-read the source: four HTTP
requests inside one MCP call. Generated payloads removed source widget/query IDs.

| Run | Result | Wall time | MCP calls | API calls | Uncached input | Cache creation | Cache reads | Output |
| --- | ------ | --------- | --------- | --------- | -------------- | -------------- | ----------- | ------ |
| 1   | Pass   | 24.625 s  | 4         | 5         | 8              | 9,234          | 11,060      | 1,944  |
| 2   | Pass   | 20.312 s  | 4         | 5         | 8              | 6,054          | 11,635      | 1,495  |
| 3   | Pass   | 19.206 s  | 4         | 5         | 8              | 6,564          | 12,221      | 1,514  |

Each run made three GETs/two POSTs with no API or MCP errors; schema downloads
are excluded. Total input including caches was 20,302 / 17,697 / 18,793 tokens.
Fresh conversations can still reuse provider caches. These programs returned
complete dashboards; compact projection was not optimized. Evidence:
`.cache/code-mode/http-dashboard-claude.json`.

An earlier session-driven proof on 2026-10-25 passed with three MCP calls and
seven API calls. Generated calls were relayed unchanged; a large schema response
was transferred verbatim through a file. No token usage is available, and relay
latency is not comparable. Initial automatic attempts failed before inference
because Claude authentication expired and Codex rejected requested models.
Those are infrastructure failures. Evidence:
`.cache/code-mode/http-dashboard-session.json`.

## Historical operation and recovery evidence

All reported agent runs used synthetic APIs. Natural prompts did not name tools
or algorithms; tool descriptions included a release example, so prompts do not
imply an unprimed model or a statistically neutral benchmark.

### Discovery guidance comparison, 2026-10-26

Baseline runs used Claude Code 2.1.263, `claude-opus-5`, medium effort,
Wrangler 4.80.0 and workerd 1.20260401.1. Nine normal top-level tools were
available, plus two Code Mode tools on the combined surface. The same fixtures,
prompts and preservation graders were used before/after general discovery
guidance; OpenAPI, API behavior and permissions were unchanged.

| Task                 | Success before → after | MCP calls before → after | API calls before → after | API errors before → after |
| -------------------- | ---------------------- | ------------------------ | ------------------------ | ------------------------- |
| Release/deploy       | 3/3 → 3/3              | 4–5 → 4                  | 5–7 → 6–7                | 0–1 → 1–2                 |
| Repository inventory | 3/3 → 3/3              | 2–4 → 3–4                | 2–4 → 2–4                | 0 → 0                     |
| Disable alert        | 3/3 → 3/3              | 8–9 → 5                  | 10–12 → 4                | 1–4 → 0                   |

Catalog-only controls completed 0/1 for each task and left state unchanged.
Baseline durations were 18.5–24.2 s for release, 14.3–23.7 s for repositories
and 26.3–31.7 s for alerts. Release 404s checked existence before creation;
alert 404s came from legacy route guesses. Searching operation metadata rather
than paths alone found workflows without those guesses in all three later runs.
Each later alert run performed one PUT and preserved IDs/monitor connections,
but still resent full nested configurations and fetched the resource twice.
This measured less discovery friction, not improved preservation success.

Across three alert runs, tool-result bytes fell 214,374 → 100,024 and output
tokens 6,146 → 5,164. Release bytes rose 27,350 → 50,251; repository bytes rose
8,892 → 30,513 as the agent retrieved more contract information. Descriptions
grew 2,420 → 4,452 UTF-8 bytes. Cache variation and three samples cannot establish
general token/cost savings. An additional dashboard regression passed 3/3 with
4–6 MCP calls/seven API calls per run, but used a different historical runner.

Evidence: `.cache/code-mode/guidance-before/` and
`.cache/code-mode/guidance-after/`. The frozen baseline excludes earlier
diagnostic runs with incomplete fixtures or weaker grading; those remain below.

### Further operations and failure recovery

This expansion used 31 fresh Claude Code 2.1.263 / `claude-opus-5` conversations
at medium effort, with the normal catalog plus Code Mode.

| Scenario                        | Initial results                     | After generic write guidance |
| ------------------------------- | ----------------------------------- | ---------------------------- |
| Monitor schedule/timezone       | 0/5                                 | 5/5                          |
| Persisted deploy, lost response | 5/5                                 | 3/3                          |
| Repository GET initially 503    | 5/5                                 | Not rerun                    |
| Repository GET always 403       | 5/5 blocked after grader correction | Not rerun                    |
| Alert regression                | Earlier 3/3 baseline                | 3/3 after parser correction  |

All five initial monitor programs copied GET's aggregate `isMuted` into PUT,
changing a child environment the user asked to preserve. Later repairs could
not erase the violation. Generic guidance now explains that GET is not a write
template: use required fields/requested changes and include unchanged fields
only when the update contract requires them. No monitor fields, routes or SDK
were added to the tool description.

With the same prompt, fixture, grader, model and settings, five later runs each
used one successful write and preserved child mute state (initially 2–9 writes).
Some unchanged fields were still included. This does not prove minimal payloads
or safe writes across all endpoints. No new catalog-only controls were run.

Two grading corrections are separate from agent behavior:

- The original 403 grade was 4/5 because harmless `readOnly: true` answer
  metadata was rejected. Regrading unchanged evidence yields 5/5; fabricated
  inventory, writes and repeated denials still fail.
- The alert grade was 2/3 because a parser included explanatory braces after
  valid fenced JSON. The shared parser now accepts one explicit fence and
  rejects multiple/malformed fences. Reconstructing exact saved write boundaries
  and regrading unchanged answers yields 3/3, with preservation checks intact.

These corrections replayed evidence, not model inference or generated code.
Raw reports remain under `.cache/code-mode/expanded-diagnostic/` and
`.cache/code-mode/expanded-after/`; `repositories-denied-regraded.json` and
`alert-regraded.json` record original report hashes, grader hashes and both
verdicts. New reports hash the shared JSON parser.

The monitor fixture omits valid experimental repair routes. Some diagnostic
404s reflect fixture limits; they do not explain first-write violations or prove
repair is impossible in Sentry. The 403 grader checks honest blockage, not the
accuracy of suggestions about missing OAuth scopes.

### Diagnostic and later smoke evidence

Earlier alert diagnostics were 2/3 under final-state-only grading. One program
removed condition IDs, recreating three conditions; another detached then
restored `detectorIds`. Final-state grading hid the temporary detachment. The
current grader checks exact state after every successful write. Original traces
remain under `.cache/code-mode/diagnostic-http-*` without retroactive relabeling.

Initial fixtures omitted valid auxiliary alert and organization/project reads;
those routes were later added. One release catalog control called a catalog-only
tool directly instead of through `execute_sentry_tool`, and the client rejected
it. `http-release-claude-catalog.json` retains that failure;
`http-release-claude-catalog-repeat.json` records a valid control that read
projects/releases, made no changes and reported missing write capabilities.

Two later smoke checks on 2026-10-26 used `catalog-and-code` without instructions
to choose Code Mode: dashboard copying passed in one run (five MCP/six API calls),
and repository 403 handling produced an honest blocked result in one run. Both
resolved to `claude-opus-5`. Evidence: `.cache/code-mode/ready-dashboard.json`
and `.cache/code-mode/ready-repositories-denied.json`. They do not establish a
success rate or hosted authorization.

## Interpretation and next comparisons

The [Cloudflare MCP implementation](https://github.com/cloudflare/mcp) at
`550e1be82b2227818e6b98fc32a313a59403ae3f` tests the real MCP/Worker path with
external API fixtures. This suite follows that boundary and measures capabilities
beyond existing catalog tools. [Stainless](https://www.stainless.com/blog/sdk-code-mode/)
separates completeness, efficiency and factual accuracy; state verification and
second-page sentinels make completeness explicit here before comparing usage.
[Armin Ronacher's article](https://lucumr.pocoo.org/2026/10/6/codemode/) discusses
host-side composition; client-side Code Mode wrapping this server was not tested.

Measure success before optimizing tokens or latency. These small samples from
one client/model do not establish production compatibility, complete API
coverage, general token savings or an HTTP-versus-SDK winner. For a later SDK
comparison, keep task, fixture, verifier, client, model settings and budgets
identical. SDK work is not required for the HTTP deployment.
