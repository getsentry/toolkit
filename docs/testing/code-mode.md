# HTTP Code Mode integration and evaluations

HTTP Code Mode lets an external MCP agent discover an OpenAPI schema, write
JavaScript, and execute HTTP requests in a Cloudflare Dynamic Worker. It covers
published API operations absent from the hand-maintained tool catalog, subject
to the connection's permissions. There is no embedded LLM or endpoint-specific
execution tool. The hosted MCP integration uses the existing authentication flow
and has no beta or opt-in flag. This document describes the implementation and
local evidence; it does not establish that the change has been deployed.

The evaluation harness remains separate from the hosted authorization boundary.
Its historical write successes do not demonstrate that existing production
grants authorize those writes. An SDK interface and HTTP-versus-SDK evaluation
are deferred; neither is a deployment prerequisite.

## Ownership, model usage and protocol

This is **server-side execution of client-generated code**. The external MCP
client's model discovers the API, writes JavaScript, corrects failures and writes
the final answer. Our MCP server runs that JavaScript; it does not call a model.

| Responsibility                                          | Owner                   | Cost boundary                                   |
| ------------------------------------------------------- | ----------------------- | ----------------------------------------------- |
| Planning, code generation, corrections and final answer | Client's agent/provider | Client's model account or subscription          |
| OpenAPI search and JavaScript execution                 | Our Dynamic Workers     | MCP operator's Cloudflare infrastructure        |
| Credential injection and per-request access enforcement | Our host-side broker    | MCP operator's infrastructure                   |
| Serving API requests                                    | Sentry API              | Sentry infrastructure and applicable API limits |

Adding an embedded agent would introduce server-side model usage; that is not
part of this design. The local eval used the authenticated Claude CLI account and
local workerd; it did not deploy or consume hosted Dynamic Workers.

MCP provides ordinary `tools/list` and `tools/call` with typed schemas, structured
results and tool errors. Code Mode is an architectural pattern, not a separate
protocol capability or required tool name in the
[2026-07-28 specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools).
The MCP TypeScript SDK's `2.x` version is separate from the dated wire protocol.
The client-side pattern in
[Client Best Practices](https://modelcontextprotocol.io/docs/2026-07-28/develop/clients/client-best-practices)
places the sandbox in the host. Our server supplies the sandbox, so the external
client only needs normal MCP tool support. This statement does not certify full
protocol compliance or hosted deployment behavior.

## Relationship to Cloudflare and Stainless

The implementation follows Cloudflare's
[server-side search/execute pattern](https://blog.cloudflare.com/code-mode-mcp/):
search the schema without loading the entire document into model context, then
compose authenticated HTTP requests in a Dynamic Worker. The inspected
`cloudflare/mcp` revision `550e1be82b2227818e6b98fc32a313a59403ae3f` also uses
Worker Loader directly, a fresh isolate per call, disabled search egress and a
credential-owning `GlobalOutbound` entrypoint. Following this pattern does not
require using the `@cloudflare/codemode` package.

The hosted integration uses a request-scoped RPC broker with all sandbox egress
disabled. Cloudflare supports passing capabilities, requests and responses through
[Workers RPC](https://developers.cloudflare.com/workers/runtime-apis/rpc/).
This keeps authorization and the existing 401 callback in their original request
context; callback objects cannot be placed in the persistently serializable
`ctx.props` of a loopback binding. The HTTP programming interface remains
`sentry.request()`.

Cloudflare now also offers
[`openApiMcpServer()` and `DynamicWorkerExecutor`](https://developers.cloudflare.com/agents/model-context-protocol/guides/build-codemode-openapi-mcp-server/).
They are candidates for reducing custom harness code. As reviewed on 2026-10-26,
the publisher still returns an MCP SDK v1 server and requires
`createLegacyMcpHandler`; this experiment uses SDK v2. It is not a drop-in
replacement. Authentication, per-operation authorization and Sentry routing
remain responsibilities of the host request implementation either way.

[Stainless's SDK Code Mode](https://www.stainless.com/blog/sdk-code-mode/) adds an
idiomatic SDK, focused SDK/API documentation, type checking and useful errors.
The initial HTTP version does not implement those SDK features. Its focus is
schema discovery, authenticated HTTP requests and compact program results. An SDK
interface can be evaluated later using the same runtime and broker; it would
change the programming interface, not the model or infrastructure cost owners.

Before deployment, account for
[Dynamic Workers pricing](https://developers.cloudflare.com/dynamic-workers/pricing/)
as well as model usage: Cloudflare meters unique Worker IDs/code per day,
requests and CPU. The runtime deliberately allocates a fresh ID for each tool
execution. Reusing identical code may reduce creation costs, but must preserve
per-request credentials and isolation; changing the ID alone is not sufficient.

## Runtime

The hosted MCP registers two additional tools on its existing authenticated
server. The separate `packages/mcp-cloudflare/wrangler.code-mode.jsonc` entrypoint
exposes the same tools at `/mcp` for isolated tests and evaluations:

- `search_sentry_api({code})`: execute an async arrow function against `spec`, the
  configured OpenAPI JSON document. Network access is disabled.
- `execute_sentry_code({code})`: execute an async arrow function with
  `sentry.request({method?, path, query?, body?})` (`GET` by default). It returns
  `{status, headers, body}`; non-2xx responses throw an error with API details.

Programs can loop, branch, combine responses and return a projection. Query arrays
become repeated URL parameters; `headers.link` is available for pagination. Tool
results provide both JSON text and `structuredContent`; failures use `isError`.
The MCP client generates the code and pays for its model calls. This Worker only
executes the submitted program.

Worker Loader runs generated code with `globalOutbound: null`, so raw `fetch()`
and network connections are blocked. The trusted sandbox wrapper implements
`sentry.request()` through an `ApiBroker` capability passed to its `run()` RPC
method. The broker executes in the parent request context and owns the access
token; its private credentials and authorization context are not exposed to
generated code. The broker permits only the configured API origin and path
prefix, replaces auth headers and rejects redirects.

The hosted integration derives write access from the existing MCP grant and
checks each broker request against the published schema; the isolated harness
uses its explicit fixture write setting instead. Generated code remains a
separate module. This RPC dispatch mechanism replaces the prototype's
`GlobalOutbound` loopback entrypoint while retaining the HTTP tool interface.

Each execution has a 20-call fetch budget, a 30-second I/O deadline, a 50,000-byte
result limit, and a 2,000,000-byte upstream response limit.
Before tool validation, the HTTP MCP SDK rejects arguments with more than 10,000
array elements or object keys. A bounded body reader rejects requests over 1 MiB
before dispatch, including legacy clients whose Agents transport omits the SDK's
body-limit option.

Dynamic Worker CPU and subrequest limits are also configured using the
[Cloudflare API](https://developers.cloudflare.com/dynamic-workers/usage/limits/).
**Local workerd does not enforce those platform limits in our probes. CPU
termination and deployment enforcement have not been validated.** This local
proof is not a production security certification.

There are no automatic retries or transactions spanning calls. A failed program
may already have created resources; errors instruct the agent to inspect state
before retrying writes.

## HTTP discovery and result size

The default `OPENAPI_URL` points to Sentry's published `openapi-derefed.json`,
pinned at `803d6de98c9156c15e9ddc1bf9accbac6e24cebc`. Sentry's existing API-docs
pipeline resolves references before publishing this artifact; the CLI consumes
the same artifact family. No runtime reference resolver, SDK dependency or
second operation catalog is needed. Custom schema URLs must also provide a
trusted, pre-dereferenced JSON document; the runtime does not resolve or fetch
references for them.

The pinned document contains 159 paths and 254 HTTP operations (4,296,871 bytes,
SHA-256 `270e5bd5de0cd185edfad90f5dd5a2af034c74b042c2325eb108f7a68ff85bb1`).
These are discoverable operations in that published snapshot, not a claim about
all Sentry features or the caller's permissions. Updating the pin is an explicit
schema update, independent of runtime changes.

The tool descriptions guide discovery across path, operation ID, summary,
description and tags. Product terms need not appear in an endpoint's URL. The
published example returns compact operation metadata; a separate category example
reads the existing top-level tags (including display names) or derives category
names from operation tags. Empty or unrelated results should lead to broader
metadata/category searches before trying guessed API routes. No synonym catalog,
semantic-search service or schema fetch during `tools/list` is added.

After finding an operation, inspect its description, request/response schemas and
both path-level and operation-level parameters. Operation parameters override a
path parameter with the same name and location. Schemas should be selected as JSON
values, not sliced JSON strings that can hide required fields.

HTTP write guidance distinguishes raw API bodies from the renamed, enriched or
filtered views returned by ordinary MCP tools. Even a raw GET response is not a
write template: resending an aggregate value can affect child resources. It asks the client to consult the
operation contract/defaults, read the current HTTP resource, avoid inventing empty
values for missing fields, and send only required fields and requested changes
when the contract permits. Additional unchanged fields need a reason in the
request contract or documented update/default behavior, rather than merely
appearing in GET. Resent nested collections must preserve existing IDs
and relationships unless the user requests changing them. Omission is not assumed
to preserve every field, and PUT is not assumed to replace every resource. The
client should verify the result and report unresolved ambiguity instead of
inventing semantics. An unexpected side effect should not trigger speculative
repair writes; report the actual state unless a documented repair is available.

These are global instructions, not per-endpoint enforcement. The instruction-only
changes measured below left OpenAPI, API behavior, permissions and the runtime
unchanged. The hosted authorization boundary described next is a separate
integration change. Better instructions cannot guarantee correct writes when the
contract is ambiguous; endpoint-specific limitations remain visible in the
evaluations.

Execution examples keep intermediate responses in JavaScript and return selected
fields plus pagination information. This is guidance, not automatic semantic
truncation: the client can return full objects when the task requires them, up
to the existing byte limit. The historical dashboard baseline predates these
description changes; it is preserved and does not measure their token impact.

A read-only smoke check on 2026-10-26 loaded the pinned document through the real
MCP server and local Dynamic Workers. It counted all 159 paths / 254 operations,
ran the then-advertised dashboard search examples, and inspected the inline
dashboard-create schema successfully. The examples now use releases to avoid
scaffolding the dashboard evaluation. It made no Sentry API or model calls. Local evidence is in
`.cache/code-mode/http-schema-smoke.json`; this checks discovery mechanics, not
agent task success across the full API.

## Authentication and scope

### Hosted MCP

`server/lib/mcp-handler.ts` builds a fresh MCP server for the authenticated request
and calls `registerProductionCodeModeTools()` with that request's `ServerContext`.
The existing shared upstream OAuth token and global scope request are unchanged.
There is no separate OAuth flow, rollout flag or embedded model call. The token
stays in the credential-owning broker. Production and canary Wrangler configurations
provide a `LOADER` binding. The parent passes an `ApiBroker` RPC capability to the
sandbox's trusted `run()` method. Code Mode is hosted-only.

The tools require the connection's explicit `api-read` or `api-write` skill.
`api-write` includes reads. These permissions appear in the normal MCP consent
screen; existing grants and remembered skill selections do not acquire them
implicitly. Legacy Inspect, Triage and Project Management grants retain their
existing tools and meaning. Project-constrained sessions do not expose Code Mode.
The broker computes write access from `api-write`; generated code cannot set it.

For new approvals, **API Read** is selected and **API Write** is unchecked.
Remembered selections for the same client are restored, including an explicit
API Write selection; preferences only preselect the form and do not grant access
without approval. The consent screen always shows the organization scope:
`/mcp/{org}` is limited to that organization, while `/mcp` can access any
organization authorized by the upstream token. Sentry's permissions still apply.

The API Write warning is visible before selection. It explains that permissions
are additive: API Write can modify issues even when Triage Issues is unchecked,
and projects or teams even when Manage Projects & Teams is unchecked. Those
checkboxes control their catalog tools; they are not deny rules for API Write.

Three authorities are kept separate:

- `grantedSkills` is the connection's MCP authorization.
- Legacy `grantedScopes` is derived from tool declarations for compatibility,
  not evidence of the token's actual permissions. Code Mode does not use it.
- `upstreamScopes` records the scopes in Sentry's OAuth token response. Missing
  metadata on older grants means unknown. It neither grants MCP access nor
  replaces the backend's token, role and resource checks.

Each broker retains an ordinary `ApiAuthorization` object bound to the original
request's context. It is not serialized into Worker bindings or exposed to
generated code. Raw `fetch()` is blocked; before forwarding any
`sentry.request()`, the policy checks:

- The exact path and HTTP method must exist in the pinned published OpenAPI.
  HEAD can use a GET contract when the schema has no explicit HEAD operation.
  Unknown or ambiguous paths are rejected. OpenAPI security metadata is not
  used to infer the connection's MCP permissions.
- Without `api-write`, only GET, HEAD and OPTIONS can reach Sentry. A broad
  upstream token never bypasses the connection's read-only grant.
- An organization-constrained connection requires a recognized organization
  path parameter containing the exact authorized slug. Other organizations,
  unresolved numeric aliases and global object-ID routes are rejected. Query
  parameters do not substitute for an organization-scoped path.

The policy resolves regional routing through the existing organization helper
and validates the regional host before the broker attaches credentials. It also
forwards the existing MCP client attribution. An upstream 401 invokes the
connection's existing unauthorized callback, once per policy instance, so Code
Mode follows the normal grant-revocation behavior. The backend still performs
its own token, user and resource permission checks.

**Dashboard example:** the backend accepts `org:read`, `org:write` or `org:admin`
for dashboard creation. With `api-write`, that POST reaches Sentry; no artificial
`:write` suffix requirement is added. With `api-read`, the broker blocks the POST
before contacting Sentry, even if the upstream token would allow it. A successful
MCP grant does not guarantee that Sentry will permit the request.

A Sentry 403 retains its HTTP status and message. The broker preserves
`WWW-Authenticate`, including `insufficient_scope` when the backend supplies it.
A generic 403 is not labelled as a missing scope or a need to reconnect: it may
reflect role or resource access. No failed program is automatically replayed,
since earlier writes may have succeeded.

Upstream 5xx responses create a Sentry issue through the existing `logIssue`
helper, even when generated code catches the HTTP error. The broker preserves
the response and exposes the event ID in `x-sentry-event-id`; reporting includes
only the HTTP method and status, not request or response payloads. Expected 4xx
responses do not create issues.

**Project-constrained sessions retain the existing tools without Code Mode.** A
project-bearing URL does not prove that an operation affects only that project.
For example, Sentry's project release-file endpoints modify a file belonging to
a release shared by multiple projects. Organization release deploys can also
affect every project in a release when `projects` is omitted. The current OpenAPI
does not provide a general resource-isolation contract, so the integration does
not infer one from a path prefix or append a project filter to arbitrary routes.
This limitation is based on the backend implementations in
`src/sentry/releases/endpoints/project_release_file_details.py` and
`src/sentry/releases/endpoints/release_deploys.py`, not on a rollout flag.

### Hosted integration validation

The hosted test suite uses `@cloudflare/vitest-plugin` 1.4.6, whose Wrangler and
Miniflare versions match the standalone Code Mode tests. Updating only the direct
Miniflare dependency left the old Vitest pool running an older workerd; the first
Linux CI run exited during the Dynamic Worker integration tests. The plugin
replacement removes that runtime mismatch without binary overrides.

Local validation on 2026-10-26 exercised the authenticated MCP handler, Dynamic
Workers and RPC broker with simulated external OpenAPI/Sentry HTTP responses:

- The full Cloudflare suite passed 469 tests across 35 files, including
  20 authenticated Code Mode integration tests and two public metadata tests.
  The dashboard regression reads the original,
  creates two project-specific copies and verifies them with `api-write`, while
  the simulated upstream token records only `org:read`.
- The isolated suite passed all 30 tests: 19 runtime, seven API path/organization
  checks and four OpenAPI loading tests. It uses the installed Miniflare/workerd
  aligned with Wrangler, without a binary override.
- MCP core (1,834 tests), stdio (89), test client (80) and Code Mode fixtures
  (56) passed, for 2,558 MCP tests in total (six existing core skips). Root
  build/typechecks, lint, Code Mode typechecks and frozen install passed.
  Generated metadata includes the
  hosted API skills; core tool registrations remain unchanged.
- The final `wrangler deploy --dry-run` packaged the production
  Worker with `LOADER`. This did not upload a version or deploy the change.

Two additional Claude smoke evals used the `catalog-and-code` surface without
instructing the agent to use Code Mode. Dashboard copying passed (one run, five
MCP calls, six API calls). Repository inventory produced the expected honest
blocked outcome on HTTP 403 (one run), without inventing data or a missing scope.
Both resolved to `claude-opus-5` and used synthetic fixtures. Local reports are
`.cache/code-mode/ready-dashboard.json` and
`.cache/code-mode/ready-repositories-denied.json`; these are smoke checks, not a
success-rate estimate. Unchanged CLI fixture/platform failures prevented a green
full workspace suite; CLI fixes are outside this change.

The integration tests verify regional routing, client attribution, concurrent
user token isolation, denied operations and organization escapes, project/skill
visibility, and upstream 401 revocation even when generated code catches the
error. They also reject oversized request bodies for modern and legacy clients,
bound nested tool arguments before execution, and verify that caught upstream
5xx failures are reported while expected 4xx responses are not. They do not test
a real Sentry account, production CPU enforcement, or an active hosted deployment.
Historical agent evals below remain separate evidence.

### Isolated harness

The local Code Mode entrypoint accepts a direct Sentry bearer token in the MCP
`Authorization` header and keeps it outside the generated program. It does not
run the hosted skills, constraints or regional authorization policy. Its
configuration is server-owned:

- `API_BASE_URL`: canonical origin and API prefix, such as
  `https://sentry.io/api/0`.
- `OPENAPI_URL`: trusted, pre-dereferenced JSON schema URL. Defaults to the pinned
  Sentry artifact above; the eval overrides it with its local schema fixture.
- `CODE_MODE_ALLOW_WRITES`: defaults to false; explicitly set `true` to allow
  writes in the isolated harness.

HTTP is allowed only on loopback for local tests. The eval supplies a dummy token
and local URLs; it never calls a real Sentry account.

OpenAPI discovery is limited to the supplied schema; availability also depends
on backend features and the effective upstream permissions. HTTP/JSON support
is not proof of coverage for multipart, streaming, internal or undocumented
endpoints. The isolated harness is not the deployment entrypoint for the hosted
MCP integration.

### Separate follow-ups

The integration does not change OpenAPI or add an SDK. HTTP errors caught inside
programs retain the allowed response headers, including `Retry-After`. Uncaught
program errors preserve execution statistics and HTTP metadata when available;
failures outside the sandbox, such as startup failures, do not have those stats.
Migration to a different Cloudflare runtime abstraction and existing platform
CPU/subrequest enforcement remain separate work requiring hosted validation.

## Dashboard eval

The historical agent results below predate the hosted authorization boundary and
RPC dispatcher. They are not fresh agent evaluations of this integration.

The task is to copy dashboard 101 into exactly two new dashboards, one for project
101 and one for project 102, both with saved environment `staging`. It must retain
widgets, queries, order, layout, other filters and time range, leave the source
unchanged, and return the real IDs and links. The current catalog can inspect
dashboards but cannot create these copies.

The runner starts an authenticated loopback API fixture and a local Wrangler
Worker, then opens a fresh external-agent session. The isolated baseline gives
the agent only the two generic tools and explicitly directs it to use them. The
natural discovery evaluation below includes the normal catalog and supplies no
such instruction. Neither runner supplies a copy algorithm. Only the Sentry
HTTP boundary is a fixture. MCP transport, schema search, generated JavaScript and
Dynamic Worker execution are real.

An independent verifier checks persisted API state rather than tool arguments or
the agent's claim of success. Exactly two copies must exist with the right
configuration, no duplicates, an unchanged original and links matching created
IDs. Fixture tests include unsuccessful and misleading answers.

The fixture contains three dashboard operations with their complete published
request/response schemas. This tests functionality, not discovery across the full
API corpus. Provenance commits are recorded in `dashboard-fixture-data.json`.
Its aliases, generated IDs and rejection of foreign widget IDs follow Sentry's
backend. It does not emulate query-language validation, quotas, feature flags or
real authorization.

### Natural tool selection in Claude Code

`eval:code-mode:discovery` connects Claude Code to one MCP named `sentry`, exposing
the nine normal top-level tools, the complete normal catalog behind
`search_sentry_tools` / `execute_sentry_tool`, and the two HTTP Code Mode tools.
It uses the real core server and Dynamic Worker runtime. Only the Sentry API is
a stateful local fixture; no real dashboards are changed.

The user prompt asks only for two dashboard copies with the project/environment
settings above. It does not mention Code Mode, JavaScript, HTTP, schemas or tool
names. Claude keeps its default system prompt; there is no custom or appended
system instruction telling it how to complete the task. The server is named
`sentry`, the synthetic organization is `dashboard-evals`, and tool examples use
releases instead of dashboards. Search uses the full pinned OpenAPI document
(159 paths / 254 operations), not the three-operation fixture schema.

The same runner offers `--surface catalog` as a negative control: the same task,
client settings and real catalog, without the two Code Mode tools. Traces record
the complete advertised inventory, actual tool sequence, code, API outcomes and
independently verified final state. We do not require a catalog search before
API discovery: selection is the behavior being measured, not a prescribed route.
A failed task still produces a report and exits nonzero, including the control.

```bash
pnpm --filter @sentry/mcp-server-evals eval:code-mode:discovery --runs 3
pnpm --filter @sentry/mcp-server-evals eval:code-mode --client claude --surface catalog --runs 1
```

Both surfaces run in an empty temporary directory with other MCP servers,
built-in tools, hooks, skills and session persistence disabled. This is a
controlled MCP selection test, not a test with every Claude Code capability
enabled. API endpoints outside the dashboard fixture remain unimplemented, even
when discoverable in the full schema. The eval-only Worker rejects non-loopback
API configuration and is not a production authorization integration.

Reports default to `.cache/code-mode/http-dashboard-<client>-<surface>.json`;
`--report` selects a separate evidence file. The original `--surface code-mode`
baseline remains available for testing execution alone and does not establish
unprompted tool selection.

### Natural selection results (2026-10-26)

Claude Code `2.1.263`, resolved model `claude-opus-5`, medium effort:

| Surface                           | Task result     | Actual selection                                      | MCP calls | API calls | Wall time |
| --------------------------------- | --------------- | ----------------------------------------------------- | --------- | --------- | --------- |
| Normal catalog + Code Mode, run 1 | Pass            | Execute code → search API schema → execute code       | 3         | 5         | 23.269 s  |
| Normal catalog + Code Mode, run 2 | Pass            | Execute code → search API schema → execute code       | 3         | 7         | 21.889 s  |
| Normal catalog + Code Mode, run 3 | Pass            | Execute code → search API schema → execute code       | 3         | 5         | 18.983 s  |
| Normal catalog only, control      | Cannot complete | Five catalog searches and two catalog tool executions | 7         | 2         | 31.338 s  |

All three combined-surface runs independently created exactly two correct copies,
retained the requested widget/filter/time configuration, preserved the source,
and returned the actual created IDs/links. All API calls succeeded. Claude chose
the code tools directly, before querying the normal catalog. This demonstrates
unprompted selection from the combined inventory; it does **not** demonstrate a
catalog-first fallback sequence. In each run it read the source through HTTP,
inspected the create schema, then generated a program that created both copies
and verified state with additional reads.

The control could read the dashboard and search the catalog but had no mutation
capability. It created nothing and reported the limitation instead of claiming
success. Its verifier failure and nonzero exit are expected task outcomes, not
an authentication or transport failure.

Local evidence: `.cache/code-mode/http-dashboard-natural-claude.json` and
`.cache/code-mode/http-dashboard-catalog-control-claude.json`. Each contains the
prompt, null custom system prompt, full MCP inventory, trace, generated programs,
usage, API outcomes, final state and implementation hashes. These are four pilot
runs of one synthetic scenario; they do not establish broad reliability, token
savings or production readiness. The verifier covers the requested content and
filters; it does not require copying per-user favorites or dashboard permissions.

### Automatic HTTP baseline (2026-10-26)

After renewing the Claude login, the automatic eval passed **3/3 repetitions**
using Claude Code `2.1.263`, resolved model `claude-opus-5`, and medium effort.
Each fresh conversation had exactly the two experimental MCP tools available
and explicit instructions to use them. This establishes execution capability,
not autonomous discovery among the normal tools.
Each run created exactly two valid copies and preserved the original, as checked
against persisted fixture state by the independent verifier.

| Run | Result | Wall time | MCP calls | Sentry API calls | MCP/API errors |
| --- | ------ | --------- | --------- | ---------------- | -------------- |
| 1   | Pass   | 24.625 s  | 4         | 5                | 0 / 0          |
| 2   | Pass   | 20.312 s  | 4         | 5                | 0 / 0          |
| 3   | Pass   | 19.206 s  | 4         | 5                | 0 / 0          |

Every run used two schema searches and two code executions. The final execution
fetched the source, created both copies and fetched the source again: four HTTP
requests inside one MCP call. The five API requests per run were three GETs and
two POSTs; schema downloads are excluded from that count. The model generated
the program itself and removed existing widget/query IDs from the creation
payloads. There was no embedded LLM or dashboard-specific tool.

Raw aggregate usage reported by Claude:

| Run | Uncached input | Cache creation input | Cache read input | Output |
| --- | -------------- | -------------------- | ---------------- | ------ |
| 1   | 8              | 9,234                | 11,060           | 1,944  |
| 2   | 8              | 6,054                | 11,635           | 1,495  |
| 3   | 8              | 6,564                | 12,221           | 1,514  |

Including cache creation and reads, input totals were 20,302, 17,697 and 18,793
tokens respectively. Fresh conversations may still reuse provider-side prefix
caches, so cache state is a comparison variable. Client-reported dollar estimates
are saved separately and do not establish the amount billed to a subscription.

The traces, generated programs, usage, final fixture state and implementation
hashes are saved locally in `.cache/code-mode/http-dashboard-claude.json`. This
establishes a baseline for further HTTP evaluations, not a token-savings claim.
These programs returned complete dashboard objects; compact result projection
is available but was not optimized in this pilot.

### Earlier session-driven proof (2026-10-25)

One fresh session subagent completed the task through the real MCP SDK and
Dynamic Worker. Its generated calls were relayed unchanged; the first large
schema response was transferred verbatim through a file. The independent
verifier passed: exactly two copies, IDs `201` and `202`, correct project and
environment filters, preserved widgets/settings, and original unchanged.

The run used three MCP calls (one search, two executions) and seven Sentry API requests
(five GETs, two POSTs), plus one OpenAPI download, with no API errors. The write program combined six HTTP
requests and returned a compact verification summary. This demonstrates the
missing capability without a dedicated dashboard creation tool.

The initial automatic clients could not perform inference: Claude's OAuth session was
expired, and the local Codex login rejected the requested models. Those attempts
are infrastructure failures, not task failures or successful benchmark runs.
The successful session-driven run has no available token usage and its relay
latency is not comparable with an automatic client. It does not establish a
three-run success rate, token savings, or an HTTP-versus-SDK winner. Full local
evidence is in `.cache/code-mode/http-dashboard-session.json`.

## CLI capabilities beyond the MCP catalog

Three additional tasks use the natural discovery surface: the normal MCP catalog
plus the two HTTP Code Mode tools, with Claude Code's default system prompt. The
user prompts describe the desired result without mentioning Code Mode, tool names,
API endpoints, or an algorithm. The agent can select either interface. Tool descriptions are unchanged across the
flows and include a release discovery example; natural prompts do not imply an
unprimed model or a statistically neutral benchmark.

| Task                   | Equivalent CLI operations                                                            | Gap in the normal MCP catalog                     | Independent verification                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release and deploy     | `sentry release create`, `release finalize`, `release deploy`, `release deploys`     | Release reads exist; release/deploy writes do not | Exactly one release for two projects and one staging deploy; requested timestamps, name and URL; original resources unchanged; complete final JSON including the actual deploy ID |
| Repository inventory   | `sentry repo list <org>/ --limit 200 --json`, then select active GitHub repositories | No repository listing tool                        | All 107 active repositories retrieved across pages; four GitHub results with exact IDs, names and URLs, sorted with a correct count; disabled repository excluded; no writes      |
| Disable an issue alert | `sentry alert issues edit <org>/<project>/701 --status disabled --frequency 60`      | Alert inspection exists; alert editing does not   | Workflow disabled with frequency 60; exact saved JSON; conditions, actions, owner, environment, detector associations and another alert unchanged throughout every write          |

The repository fixture caps a page at 100 records and puts matching repositories
on the second page. The release verifier inspects all persisted deployments, even
though the API lists only the latest per project/environment. The alert verifier
compares the complete saved configuration and checks unrelated settings after
every successful write, so restoring a temporarily detached monitor is still a
preservation failure. These checks reject plausible but
incomplete answers and destructive partial updates.

The fixtures model routes used by the CLI at revision
`b625111aef9cc3a44abbed634a043fce8505366d`, checked against Sentry backend revision
`b4b356554798716ceaeab74efdc095782be9ca16`. The normal alert inspection tool also
needs project, detector and workflow project-scope reads. Those auxiliary routes
were verified against Sentry `origin/master` revision
`c4b7b5f3502b7f7c2ae8edc9ae1da36c8a1c98a4`. The fixture records this separate
provenance; the core `get_alert_rule` handler was checked both with and without a
project constraint. Each report includes its fixture's source paths and CLI
commands. This is a comparison with CLI task semantics, not a benchmark run of
the native CLI.

Run all three flows, then the same prompts against the catalog alone:

```bash
pnpm --filter @sentry/mcp-server-evals eval:code-mode:flows --runs 3
pnpm --filter @sentry/mcp-server-evals eval:code-mode --client claude --surface catalog --task release --task repositories --task alert --runs 1
# A single task:
pnpm --filter @sentry/mcp-server-evals eval:code-mode --client claude --surface catalog-and-code --task alert --runs 3
```

Default evidence files are
`.cache/code-mode/http-<task>-<client>-<surface>.json`. A filesystem regression test
checks that a multi-task suite and its controls preserve separate reports.
`--report` overrides the destination for a single task only. Task runs reset the
fixture and start fresh conversations; each task gets its own API server and
Worker. Reports record API errors even if the agent recovers and succeeds.

The model, MCP server, discovery and Dynamic Worker execution are real; only the
Sentry API boundary uses synthetic fixtures. Discovery searches the full pinned
OpenAPI document, while only each fixture's routes are executable. These tests do
not prove production API compatibility or complete API coverage.

### CLI flow baseline before discovery guidance (2026-10-26)

The final frozen-fixture runs used Claude Code `2.1.263`, resolved model
`claude-opus-5`, medium effort, Wrangler `4.80.0` and workerd `1.20260401.1`.
The natural surface advertised nine core tools plus two Code Mode tools; the
control advertised the same nine core tools. The reports record the source hashes used
for this baseline. Copies are preserved under `.cache/code-mode/guidance-before/`
before modifying tool descriptions; subsequent guidance results are separate.

| Task                   | Catalog + HTTP Code Mode | Catalog-only control | MCP calls per successful run | API calls | Duration    |
| ---------------------- | ------------------------ | -------------------- | ---------------------------- | --------- | ----------- |
| Release and deploy     | 3/3                      | 0/1 completed        | 4–5                          | 5–7       | 18.5–24.2 s |
| Repository inventory   | 3/3                      | 0/1 completed        | 2–4                          | 2–4       | 14.3–23.7 s |
| Disable an issue alert | 3/3                      | 0/1 completed        | 8–9                          | 10–12     | 26.3–31.7 s |

These are nine successful executions of the final task definitions, not a claim
that every exploratory run succeeded. The release control above is the separate
valid repeat described below. None of the controls completed the requested work;
they explained the missing catalog capability and left the relevant state
unchanged. Rejected calls to nonexistent tools remain visible in the traces.

The agents chose Code Mode without prompt instructions to do so. Repository runs
used API discovery and code execution directly. Alert runs combined the normal
`get_alert_rule` tool with API discovery and HTTP mutation. Each final alert run
performed exactly one PUT, preserved existing condition IDs and monitor
connections throughout, and returned the actual saved values.

The final release runs include two expected 404 existence checks before creating
the release. Repository runs have no API errors. Alert runs encounter one, four
and one 404s respectively while trying legacy routes; ordinary catalog reads and
supported API operations succeed. The workflow schemas are present in OpenAPI:
initial searches for `rule` in paths miss them, while searches for `workflow` or
`detector` find them. This points to vocabulary and search strategy as a discovery
weakness, not missing workflow schemas.

Each report retains token/cache usage, tool result sizes and full generated code.
The suite does not establish token savings against the CLI or an SDK. The runtime
and tool descriptions were unchanged during that baseline evaluation; fixture coverage and
output/preservation grading were refined. Differences between diagnostic and final
runs cannot establish that runtime reliability improved.

### Global discovery and HTTP write guidance (2026-10-26)

The next comparison changes only the two tool descriptions and their examples.
Discovery now demonstrates searching path, operationId, summary, description and
tags, with category inspection and broader terms when matches are unrelated.
Execution guidance distinguishes raw HTTP resources from MCP projections and
asks the agent to inspect update semantics, preserve nested identity and verify
saved state. OpenAPI, the runtime, authentication and API permissions are unchanged;
there are no endpoint-specific exceptions or SDK methods.

Release, repository and alert runs use the same prompts, fixtures, graders,
client version, resolved model and settings as the baseline above. Only
`worker.ts` differs among their recorded execution source hashes. All nine runs
selected Code Mode without instructions to use it in the user prompt. The
unchanged catalog-only controls were not repeated.

| Task                   | Success before → after | MCP calls per run before → after | API calls before → after | API errors before → after |
| ---------------------- | ---------------------- | -------------------------------- | ------------------------ | ------------------------- |
| Release and deploy     | 3/3 → 3/3              | 4–5 → 4                          | 5–7 → 6–7                | 0–1 → 1–2                 |
| Repository inventory   | 3/3 → 3/3              | 2–4 → 3–4                        | 2–4 → 2–4                | 0 → 0                     |
| Disable an issue alert | 3/3 → 3/3              | 8–9 → 5                          | 10–12 → 4                | 1–4 → 0                   |

All three alert runs first searched for rules, then broadened the search to alert
metadata before making an API request. They found the workflow operation without
trying legacy routes. Each performed one successful PUT, preserved condition IDs,
monitor connections and unrelated settings at every write, and re-read the saved
resource. They still resent full nested configurations and fetched the resource
twice before writing; the guidance did not produce minimal writes. Both before
and after groups pass the same preservation grader, so this comparison shows
less discovery friction, not a measured improvement in preservation success.

The release errors are existence checks for the new release or its deploy list
before creation. Repository runs retrieve both pages and return all four expected
matches without writes. No run in these three tasks returned an MCP tool error.
An additional dashboard regression passed 3/3 with 4–6 MCP calls and seven API
calls per run, without API or MCP errors. Its historical baseline used an older
runner, so treat that comparison as a regression check rather than a controlled
efficiency comparison.

Efficiency is mixed. Across three alert runs, tool-result bytes fall from 214,374
to 100,024 and output tokens from 6,146 to 5,164. Release tool-result bytes rise
from 27,350 to 50,251, and repository bytes from 8,892 to 30,513, as the agent
retrieves more contract information. The two descriptions grow from 2,420 to
4,452 UTF-8 bytes. Reports retain input, cache creation, cache reads and output
separately. Three samples and changing cache usage do not establish general
token or cost savings.

Before/after evidence is preserved in `.cache/code-mode/guidance-before/` and
`.cache/code-mode/guidance-after/`. The changed examples are also obtained from
real `tools/list` responses and executed through a Dynamic Worker in deterministic
tests: metadata-only matches, declared and derived categories, and both parameter
levels. The focused Worker suite passes 15 tests; Code Mode typechecking, changed
TypeScript linting and core definition generation also pass, with no generated
core changes.

These results use synthetic API fixtures and do not prove production compatibility
or reliable writes across the API. Generic instructions cannot supply missing
endpoint semantics or enforce preservation by themselves. Further evals can
identify concrete limitations without making a full OpenAPI rewrite a prerequisite.

### Additional operations and failure recovery

Four further scenarios exercise HTTP Code Mode with the normal catalog available.
The user prompts describe outcomes without naming tools, routes or Code Mode.
The recovery variants reuse their original task prompts; the permission-denied
variant adds a general JSON fallback for an incomplete inventory, without revealing
the injected failure.

| Task                  | Scenario                                                                        | Independent verification                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `monitor`             | Change one named cron monitor's weekday schedule and timezone                   | Correct saved schedule; name, slug, owner, enabled state, thresholds, notifications, per-environment mute state and another monitor preserved after every write |
| `release-recovery`    | The deploy is persisted, but its first POST response is a simulated gateway 502 | Exactly one persisted deploy, correct saved release and actual deploy ID; replaying the POST fails grading even if the latest-deploy API hides the duplicate    |
| `repositories-retry`  | The first inventory GET returns a simulated 503                                 | Agent recovers, follows pagination and returns every expected repository; no writes                                                                             |
| `repositories-denied` | Inventory GETs always return a simulated 403                                    | Agent encounters the denial, reports JSON `blocked` with a reason, invents no inventory and performs no writes; no more than two denied collection attempts     |

The blocked outcome is a successful evaluation of limitation handling, not a
completed inventory. Reports include `expectedOutcome` to make that distinction
explicit. Transient failures are opt-in fixture conditions; the original scenarios
retain their previous behavior. They model infrastructure failures, not claims
that Sentry endpoints normally return these responses.

Monitor GET/PUT semantics were checked against Sentry backend revision
`b4b356554798716ceaeab74efdc095782be9ca16`. Configuration updates merge supplied
fields, while explicitly writing the aggregate `isMuted` value propagates it to
all monitor environments. The fixture starts with different environment mute
states so blindly copying the GET body cannot pass the preservation grader.
Monitor editing has no dedicated catalog tool; the CLI equivalent uses `sentry api`.

```bash
pnpm --filter @sentry/mcp-server-evals eval:code-mode:resilience --runs 5
# Run one scenario:
pnpm --filter @sentry/mcp-server-evals eval:code-mode --client claude --surface catalog-and-code --task monitor --runs 5
```

Each variant has a separate report and resets its fault state between repetitions.
Reports hash the wrapper and its shared fixture implementation. Fixture tests
reject duplicate deployments, incomplete pagination, fabricated blocked results
and collateral monitor changes before real-agent runs are evaluated.

#### Results and the resulting HTTP guidance change

This expansion ran 31 fresh conversations with Claude Code 2.1.263,
`claude-opus-5`, medium effort and the normal catalog plus Code Mode. Each run
used the real MCP/Worker path and synthetic Sentry API state.

| Scenario                                 | Initial runs                          | After the generic write guidance change |
| ---------------------------------------- | ------------------------------------- | --------------------------------------- |
| Monitor schedule/timezone edit           | 0/5                                   | 5/5                                     |
| Deploy persisted before a lost response  | 5/5                                   | 3/3                                     |
| Repository inventory with an initial 503 | 5/5                                   | Not rerun                               |
| Repository inventory denied with 403     | 5/5 blocked after a grader correction | Not rerun                               |
| Existing alert edit regression           | Earlier 3/3 baseline                  | 3/3 after a parser correction           |

All five initial monitor runs copied the aggregate mute value from GET into PUT,
changing a child environment that the user had asked to preserve. Later repair
attempts could not erase that violation: grading checks every successful write.
The execution tool description now explains that GET is not a write template,
including when an unchanged aggregate value can change child resources. It asks
agents to construct the body from required fields and requested changes, include
other fields only when the update contract requires them, and avoid speculative
repair writes. This is generic HTTP guidance, with no monitor-specific fields,
routes, schema changes or SDK implementation.

The five new monitor runs used the same prompt, fixture, grader, model and
settings; only the execution description changed. They all preserved the child
mute states, with one successful write each instead of 2–9. These runs still
sometimes sent other unchanged fields, so they do not establish that every body
was minimal or that instructions enforce safe writes across the API.

Two grader problems are recorded separately from agent failures:

- The original 403 report was 4/5 because its strict answer schema rejected
  harmless `readOnly: true` metadata. Replaying the same recorded requests and
  statuses and grading the unchanged answers yields 5/5. The grader still
  rejects fabricated inventory counts or rows, writes and repeated denied reads.
- The alert regression report was 2/3 because its parser included braces from
  explanatory text after a correct JSON fence. The shared parser now reads one
  explicit JSON fence and rejects multiple or malformed fences. Reconstructing
  every saved write boundary and final state with exact equality, then grading
  the unchanged answers, yields 3/3. This regrades evidence without rerunning
  generated code or model inference; preservation checks remain intact.

Raw reports remain in `.cache/code-mode/expanded-diagnostic/` and
`.cache/code-mode/expanded-after/`. Separate `repositories-denied-regraded.json`
and `alert-regraded.json` files record the original report SHA, grader hashes,
method and both verdicts. Future reports also hash the shared JSON parser.

These are small samples from one client/model and synthetic API behavior. No new
catalog-only control was run for this expansion. The monitor fixture omits valid
experimental environment-repair routes, so some diagnostic 404s are fixture
limits; they do not explain the first-write preservation failures or prove that
repair is impossible in Sentry. The 403 grader validates an honest blocked
outcome, not the accuracy of suggestions about specific missing OAuth scopes.
No production execution, deployment or broad API reliability claim follows from
these results.

### Diagnostic runs and grading limits

Earlier diagnostic runs reached release 3/3, repository inventory 3/3, and alert
2/3 under a final-state-only preservation check. Those alert traces exposed two
different problems: one run removed condition IDs from its PUT payload, causing
three existing conditions to be deleted and recreated; another temporarily
cleared `detectorIds`, then restored the monitor connection. The latter passed
final-state grading but did not preserve settings throughout the operation.
The current verifier checks each successful write and exact final JSON values.
Diagnostic evidence remains under `.cache/code-mode/diagnostic-http-*`; it is not
silently reclassified under the revised prompt or grader.

The initial fixtures also omitted valid auxiliary reads. Normal alert reads now
include project, workflow scope and detector endpoints, and exploratory workflow
and detector collection reads are supported. Repository fixtures include normal
organization/project discovery reads. Fixture-only 404s in earlier traces are not
product failures. Legacy or invented routes remain unsupported.

One release catalog control attempted to call the catalog-only `find_releases`
tool directly instead of invoking it through `execute_sentry_tool`; the client
rejected that run. Its evidence is retained in `http-release-claude-catalog.json`.
A separate control in `http-release-claude-catalog-repeat.json` read projects and
releases successfully, explained the missing write tools and made no changes.
Neither control completed the task, but these are different failure categories.

### What the references contribute to these evaluations

The rechecked [Cloudflare MCP implementation](https://github.com/cloudflare/mcp)
at revision `550e1be82b2227818e6b98fc32a313a59403ae3f` tests the real MCP/Worker
execution path with external API fixtures. Its
[Code Mode post](https://blog.cloudflare.com/code-mode-mcp/) motivates composing
requests and pagination inside one execution. This suite applies that pattern to
capabilities absent from Sentry's catalog; it does not restrict execution to
existing MCP tools.

[Stainless's evaluation](https://www.stainless.com/blog/sdk-code-mode/) separately
considers completeness, efficiency and factual accuracy. Here, state verification
and a second-page sentinel make completeness explicit before comparing token
usage. No SDK has been added.

[Armin Ronacher's Code Mode article](https://lucumr.pocoo.org/2026/10/6/codemode/)
examines host-side composition and structured tool results, including the friction
of nesting code-execution interfaces. This suite uses an ordinary Claude MCP
client with server-side execution; host-side Code Mode composing this server is
not part of the tested surface.

## HTTP validation

The Miniflare catalog version matches the version bundled with Wrangler, so the
Dynamic Worker tests use the same `workerd` binary as local Wrangler execution.
The test harness uses Miniflare's `convertV4MiniflareOptions()` adapter, also used
by Wrangler, to preserve its existing worker configuration on Miniflare 5. No
`MINIFLARE_WORKERD_PATH` override is required.

The hosted test pool configures outbound fixtures through Undici's `MockAgent`
directly. Unregistered outbound requests remain blocked with `disableNetConnect()`.

Use Node 24 for this checkout; its `better-sqlite3` dependency cannot compile with
Node 26. After `pnpm install --frozen-lockfile`:

```bash
pnpm --filter '@sentry/mcp-core...' --if-present run build
pnpm --filter @sentry/mcp-cloudflare test:code-mode
pnpm --filter @sentry/mcp-cloudflare tsc:code-mode
pnpm --filter @sentry/mcp-server-evals test:code-mode
pnpm --filter @sentry/mcp-server-evals tsc:code-mode
pnpm --filter @sentry/mcp-server-evals eval:code-mode --runs 3 --model '<available-model>'
# Or use an authenticated Claude CLI session:
pnpm --filter @sentry/mcp-server-evals eval:code-mode --client claude --runs 3
```

Tests and typechecks need no model credentials and are wired into the Toolkit
CI project matrix through each package's `sentryCi` configuration. Cloudflare's
`test:ci` and `tsc:ci` include its Code Mode checks; the eval package runs
`test:code-mode` and `tsc:code-mode`. Model-based evals remain separate and
require an installed, authenticated CLI session. The default `--client codex`
requires an explicit `--model` available to that login. It uses
`codex exec --ignore-user-config` with medium reasoning. Some built-in tools and
global `CODEX_HOME/AGENTS.md` may still be included by Codex.

`--client claude` uses Claude's default model unless `--model` is supplied, and
records the resolved model from its event stream. It sets medium effort, disables
built-in tools, hooks, skills and session persistence, and uses a strict MCP
configuration containing only the two experiment tools. In the isolated `code-mode` baseline, both clients run in an empty temporary
directory, receive the same task and instructions, and reject runs that invoke
other tools. The Claude-only discovery surfaces keep the default system prompt
and allow the entire selected MCP inventory instead. This is a client-based benchmark, not a bare-model
benchmark; keep the same client, model and settings when comparing HTTP changes.

Claude usage is taken once from its final aggregate result. Input, cache creation,
cache reads and output are recorded separately; cached tokens must not be
silently treated as free or counted twice by summing per-message usage.

The runner records requested model and client version, task/developer prompt, token usage,
duration, MCP requests/results, API request outcomes and independently verified
state in the selected report file. Reports contain synthetic data;
they are local artifacts, not committed generated files. A failed verification
sets a nonzero exit code. Repetitions reset state and use fresh conversations.

Measure success before optimizing tokens or latency. The CLI flows above cover discovery, pagination, combining responses and compact
result projection; later evaluations can expand failure recovery and API coverage. Three runs are a pilot, not statistical evidence of superiority. No
token savings or full-API coverage can be inferred from this experiment.

### Deferred SDK evaluation

An SDK interface is future work and is not required for the initial HTTP
deployment. If evaluated later, compare it against HTTP using the same task,
fixture, verifier, client, model settings and budgets. The existing HTTP results
do not establish an SDK advantage.
