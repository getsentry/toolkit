# Telemetry

## Goal

Use this when investigating Sentry MCP production incidents across the
Cloudflare HTTP server, stdio package, MCP tools, OAuth flows, and test-client

Primary backend: Sentry Logs, Issues, Spans/Traces, and Metrics in the MCP
server projects. Start with a Sentry event, trace ID, route, user, client
family, OAuth symptom, tool name, resource URL, or GenAI/model symptom, then use
the pivots and recipes below.

## Where To Query

| Starting Point | Query Surface | Pivot | Answers | Next Step |
| -------------- | ------------- | ----- | ------- | --------- |
| `trace_id` from an issue, span, or log | Sentry Traces and Logs | `span_id` | full request/tool timeline and failing span | inspect child spans and logs |
| Sentry `event_id` | Sentry Issue/Event | `trace_id`, `http.route`, `gen_ai.tool.name` | exception context and owning request/tool | query trace logs |
| HTTP route or status symptom | Sentry Metrics and Logs | `http.route`, `http.response.status_code` | route volume, status mix, local rate limits | inspect matching traces |
| OAuth sign-out or refresh symptom | Sentry Metrics and Logs | `app.client.family`, `app.access.*`, `app.oauth.*` metrics | refresh outcome, revoked grants, client family | inspect user trace or request logs |
| MCP tool name | Sentry Spans and Issues | `gen_ai.tool.name` | failing or slow tool calls | inspect tool span and Sentry API spans |
| Sentry resource URL/type | Sentry Spans | `app.resource.type` | `get_sentry_resource` dispatch behavior | inspect resolved type and downstream tool |
| Agent/model/token symptom | Sentry Spans | `gen_ai.*` | provider, model, token, and agent behavior | inspect agent and tool spans |
| Client or transport symptom | Sentry Logs, Spans, Metrics | `app.transport`, `app.client.family`, `user_agent.original` | stdio vs HTTP, client bucket, and request family | compare route or OAuth metrics |

## Event Validation Diagnostics

For `Event failed schema validation`, check `contexts.log.contextType` on the
issue event or `contextType` in log properties. It records the legacy `context`
container type (`null`, `array`, or JavaScript `typeof`), never its keys or values.
Read it alongside `validationIssues`; another field may have failed.

## Investigation Pivots

| Pivot | Meaning | Found In | First Query |
| ----- | ------- | -------- | ----------- |
| `trace_id` | one request, tool call, or agent run trace | issues, logs, spans | open trace |
| `span_id` | one request, tool, model, or API span | logs, spans | inspect span |
| `event_id` | captured Sentry error | Sentry issue/event | open event |
| `user.id` | authenticated Sentry user ID | events, logs, metrics | user request or OAuth history |
| `http.route` | normalized Cloudflare route template | metrics, logs, spans | route health |
| `http.response.status_code` | final HTTP response code | metrics, logs, spans | response distribution |
| `app.response.reason` | application local response reason | metrics | local rate-limit diagnosis |
| `app.rate_limit.scope` | local rate-limit scope | metrics | IP vs user rate limits |
| `app.route.group` | coarse route family | metrics | `mcp`, `oauth`, `chat`, `search` |
| `app.transport` | MCP transport | tags, spans | `http`, `sse`, or `stdio` |
| `app.server.mode.experimental` | experimental-mode flag | metrics, spans, tags | `?experimental=1` or stdio `--experimental` adoption |
| `mcp.session.id` | MCP session identity | spans | session timeline |
| `gen_ai.tool.name` | MCP tool being called | spans, issues | tool timeline |
| `mcp.tool.name` | canonical MCP tool name on the span | spans | tool timeline for renamed tools |
| `gen_ai.tool.call.result` | JSON tool result payload | spans | returned tool output |
| `gen_ai.tool.call.result.count` | number of results returned by a tool | spans | zero-result tool calls |
| `app.resource.type` | resolved Sentry resource type | spans | resource dispatch |
| `app.constraint.organization_slug` | active organization constraint | spans | constrained session behavior |
| `app.constraint.project_slug` | active project constraint | spans | constrained session behavior |
| `gen_ai.tool.call.arguments.<key>` | effective tool arguments | spans | called tool input |
| `app.client.family` | bucketed MCP client family | metrics, spans | client-specific OAuth behavior |
| `app.access.method` | upstream access method | spans | `mcp_grant` or `sentry_access` |
| `app.client.registration.method` | CIMD vs DCR client registration method | metrics, auth spans | `cimd`, `dcr`, or `unknown` on auth paths only |
| `app.access.refresh.outcome` | OAuth refresh outcome | metrics | token refresh diagnosis |
| `app.access.grant.revoked_reason` | wrapper grant revoke reason | metrics | sign-out diagnosis |
| `app.consent.skill` | skill granted during approval | metrics | per-skill adoption |
| `app.consent.skill.<skill>.granted` | skill granted on an MCP request | spans | tool behavior by enabled skills |
| `app.access.probe.status_code` | upstream probe HTTP status | metrics | Sentry token validity probe result |
| `app.access.probe.reason` | indeterminate probe bucket | metrics | upstream instability |
| `app.upstream.host` | configured Sentry host | tags, spans | host-specific behavior |
| `app.server.version` | MCP server package version | tags, spans | release/version behavior |
| `app.utm_source` | sanitized `X-Sentry-Utm-Source` header or `utm_source` query param | spans | in-product / plugin attribution |
| `app.referrer.family` | low-cardinality bucket of the `Referer` host | spans | external traffic attribution |
| `gen_ai.provider.name` | GenAI provider | spans, tags | provider-specific model behavior |
| `gen_ai.request.model` | requested GenAI model | spans | model-specific behavior |
| `user_agent.original` | original HTTP user agent | request data, spans | client identification |

## Query Recipes

Trace log history after opening a Sentry event or span.

```text
dataset=logs query='trace_id:"<trace_id>"'
fields=timestamp,level,message,trace_id,span_id,http.route,http.response.status_code,app.request.duration_ms,error.type,exception.message
sort=timestamp
```

Captured errors for a route, tool, or OAuth symptom.

```text
dataset=issues query='http.route:"<route>" OR gen_ai.tool.name:"<tool_name>" OR app.access.grant.revoked_reason:"<reason>"'
fields=timestamp,event_id,trace_id,http.route,gen_ai.tool.name,app.access.grant.revoked_reason,error.type,exception.message
sort=-timestamp
```

HTTP response rates by route and status.

```text
dataset=tracemetrics query='metric:app.server.response http.route:"<route>"'
aggregate=sum(value) by http.route,http.response.status_code
```

MCP mode adoption by client family.

```text
dataset=tracemetrics query='metric:app.server.response http.route:"/mcp/:organizationSlug?/:projectSlug?"'
```

Local rate-limit volume and scope.

```text
dataset=tracemetrics query='metric:app.server.response app.response.reason:local_rate_limit'
fields=timestamp,metric,http.route,app.rate_limit.scope,user.id,value
aggregate=sum(value) by http.route,app.rate_limit.scope
```

OAuth refresh outcomes by client family.

```text
dataset=tracemetrics query='metric:app.oauth.token_exchange'
fields=timestamp,metric,app.access.refresh.outcome,app.access.grant.shape,app.client.family,app.access.probe.status_code,app.access.probe.reason,user.id,value
aggregate=sum(value) by app.access.refresh.outcome,app.client.family
```

Grant revocations for sign-out reports.

```text
dataset=tracemetrics query='metric:app.oauth.grant_revoked user.id:"<user_id>"'
fields=timestamp,metric,app.access.grant.revoked_reason,app.client.family,user.id,value
aggregate=sum(value) by app.access.grant.revoked_reason,app.client.family
```

Register and callback volume by client family.

```text
dataset=tracemetrics query='metric:app.oauth.register OR metric:app.oauth.callback_completed'
fields=timestamp,metric,app.client.family,value
aggregate=sum(value) by metric,app.client.family
```

Completed auth flows by client registration method.

```text
dataset=tracemetrics query='metric:app.oauth.callback_completed'
fields=timestamp,metric,app.client.registration.method,app.client.family,value
aggregate=sum(value) by app.client.registration.method,app.client.family
```

Auth-path spans by client registration method.

```text
dataset=spans query='http.route:/oauth/callback OR http.route:/oauth/authorize OR http.route:/oauth/token OR http.route:/oauth/register'
fields=timestamp,trace,span_id,http.route,app.client.registration.method,app.client.family,user.id,http.response.status_code
aggregate=count() by app.client.registration.method,app.client.family,http.route
```

OAuth skill adoption by client family.

```text
dataset=tracemetrics query='metric:app.consent.skill_granted'
fields=timestamp,metric,app.consent.skill,app.client.family,value
aggregate=sum(value) by app.consent.skill,app.client.family
```

Zero-result `search_sentry_tools` catalog discovery queries.

```text
dataset=spans query='(mcp.tool.name:search_tools OR mcp.tool.name:search_sentry_tools) gen_ai.tool.call.result.count:0'
fields=timestamp,trace,span_id,mcp.tool.name,gen_ai.tool.call.arguments.query,gen_ai.tool.call.result.count,app.transport,app.client.family,user.id
sort=-timestamp
```

Tool execution timeline for a slow or failing tool.

```text
dataset=spans query='gen_ai.tool.name:"<tool_name>" app.consent.skill.<skill>.granted:true'
sort=-timestamp
```

Use the skill id with `-` replaced by `_` in span attribute keys, such as
`app.consent.skill.project_management.granted`.

Resource dispatch behavior for `get_sentry_resource`.

```text
dataset=spans query='app.resource.type:"<resource_type>"'
fields=timestamp,trace,span_id,span.duration,app.resource.type,gen_ai.tool.name,error.type
sort=-timestamp
```

Agent/model calls for provider, token, or cost symptoms.

```text
dataset=spans query='has:gen_ai.provider.name OR has:gen_ai.request.model'
fields=timestamp,trace,span_id,span.duration,gen_ai.provider.name,gen_ai.request.model,gen_ai.operation.name,gen_ai.usage.input_tokens,gen_ai.usage.output_tokens,error.type
sort=-timestamp
```

Stdio sessions by configured host or mode.

```text
dataset=spans query='app.transport:stdio app.upstream.host:"<host>"'
sort=-timestamp
```

## Domains

### Cloudflare HTTP Server

The hosted MCP server returned an unexpected status, rate-limited a customer, or
logged a request problem.

Metrics: `app.server.response`

Attributes: `http.request.method`, `http.route`,
`http.response.status_code`, `app.response.status_class`,
`app.route.group`, `app.response.reason`, `app.rate_limit.scope`,
`app.request.duration_ms`. MCP responses also include
`app.server.mode.experimental`.

### OAuth And Client Registration

Users report sign-outs, refresh loops, DCR churn, or callback/register
imbalance.

Metrics: `app.oauth.token_exchange`, `app.oauth.grant_revoked`,
`app.oauth.consent_prompted`, `app.oauth.consent_granted`,
`app.oauth.callback_completed`, `app.consent.skill_granted`,
`app.oauth.register`

Attributes: `app.access.method`, `app.access.refresh.outcome`, `app.access.grant.shape`,
`app.access.probe.status_code`, `app.access.probe.reason`,
`app.access.grant.revoked_reason`, `app.consent.skill`,
`app.client.family`, `app.client.registration.method`, `user.id`

`app.client.registration.method` is auth-path only (`cimd` | `dcr` |
`unknown`) on authorize/callback/register/token metrics and spans. It is not
attached to ordinary `/mcp` request spans. HTTPS URL `client_id` values map to
`cimd`; opaque non-URL ids map to `dcr`; `/oauth/register` is always `dcr`.
Named under `app.client.*` (not `app.oauth.*`) so default Sentry data scrubbing
does not redact values via the `auth` substring in `oauth`.

Diagnostic OAuth *attributes* use the readable `app.access.*` namespace for
the OAuth access lifecycle. This avoids scrubbed substrings (`auth`/`oauth`,
`token`, `bearer`, `credentials`); error/reason/method buckets avoid them too.
Metric names remain under `app.oauth.*`.

### MCP Tool Execution

A tool is slow, failing, affected by session constraints, calling the wrong
Sentry API path, or returning no catalog discovery results.

Spans: tool call spans and downstream Sentry API spans

Attributes: `gen_ai.tool.name`, `mcp.tool.name`, `gen_ai.tool.call.arguments.<key>`,
`gen_ai.tool.call.result.count`, `mcp.session.id`,
`app.constraint.organization_slug`, `app.constraint.project_slug`,
`app.consent.skill.<skill>.granted`, `app.transport`, `user.id`

For `search_sentry_tools`, inspect `gen_ai.tool.call.arguments.query` and
`gen_ai.tool.call.result.count` to identify zero-result catalog searches.

### Resource Resolution

`get_sentry_resource` routes a URL or ID to the wrong resource handler, or a
supported-looking URL returns guidance instead of data.

Spans: `get_sentry_resource` tool span and downstream resource tool span

Attributes: `app.resource.type`, `gen_ai.tool.name`, `trace_id`, `span_id`

### Stdio Transport

resolution behaves differently than the hosted server.

`app.server.mode.experimental`, `app.upstream.host`, `app.url.full`

### Agent And GenAI

The test client or embedded agent has provider, model, token, or tool-call
issues.

Spans: GenAI agent/model/tool spans

Attributes: `gen_ai.provider.name`, `gen_ai.request.model`,
`gen_ai.operation.name`, `gen_ai.usage.input_tokens`,
`gen_ai.usage.output_tokens`, `gen_ai.tool.name`

## Configuration

| Setting | Controls | Default |
| ------- | -------- | ------- |
| `VITE_SENTRY_DSN` | Cloudflare Sentry telemetry | disabled when unset |
| `VITE_SENTRY_ENVIRONMENT` | Cloudflare Sentry environment | development |
| `SENTRY_DSN` | stdio and Node telemetry | disabled when unset |
| `SENTRY_RELEASE` | stdio release tag | unset |
| `SENTRY_HOST` | upstream Sentry host and `app.upstream.host` | `sentry.io` |
| `NODE_ENV` | stdio environment | production fallback in packaged runtime |

## Attribute Notes

- `http.*`, `network.*`, and `gen_ai.*` fields follow OpenTelemetry semantic
  conventions where applicable.
- `mcp.*` fields are reserved for current or draft OpenTelemetry MCP semantic
  attributes, such as `mcp.method.name`, `mcp.protocol.version`,
  `mcp.resource.uri`, and `mcp.session.id`.
- `app.*` fields are Sentry MCP application-owned attributes for product
  concepts that are not part of the MCP semantic convention, such as OAuth
  outcomes, route groups, constraints, and local response reasons.
- `gen_ai.tool.call.arguments.<key>` intentionally extends GenAI semconv with
  per-key tool arguments after constraints.
- `mcp.tool.name` is the canonical MCP tool name on spans. Use it when pivoting
  on renamed tools such as `search_tools` / `search_sentry_tools`.
- `gen_ai.tool.call.result.count` is a span-level integer result count. Zero
  means the tool returned no results. Do not use in metrics dimensions.
- `gen_ai.tool.call.result` is the full JSON tool result payload on spans. Use
  for targeted inspection only; it is high-cardinality and unsuitable for
  group-bys or metrics.
- Keep metric attributes low-cardinality. Avoid raw URLs, tokens, prompts,
  full request bodies, or other high-cardinality or sensitive values.
- Do not log secrets. Authorization headers and access tokens must remain
  scrubbed.
- Update this document, `docs/operations/monitoring.md`, and the relevant semantic lookup
  data file under `packages/mcp-core/src/internal/agents/tools/data/` when
  adding or renaming telemetry fields. Do not add unit tests solely to assert
  telemetry attribute spelling.

## References

- `docs/operations/monitoring.md`
- `docs/operations/oauth-signout-playbook.md`
- `docs/contributing/error-handling.md`
- `packages/mcp-cloudflare/src/server/metrics.ts`
- `packages/mcp-cloudflare/src/server/oauth/helpers.ts`
- `packages/mcp-core/src/internal/agents/tools/data/mcp.json`
- [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- [OpenTelemetry MCP semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/mcp/)
