# Tool Responses

Tool responses are product UX for agents and users. A response should help an
assistant answer a real Sentry question without forcing it to understand
upstream API shapes, internal implementation details, or placeholder values.

Use this policy when adding a tool, changing formatted handler output, updating
snapshots, or QAing MCP behavior. For the full tool implementation flow, see
[adding-tools.md](adding-tools.md). For snapshot requirements, see
[../testing/overview.md](../testing/overview.md). For end-to-end MCP
validation, see [.agents/skills/mcp-qa/SKILL.md](../../.agents/skills/mcp-qa/SKILL.md).

## Response Contract

Every formatted tool response should optimize for:

- **Usefulness**: Include the fields someone needs to inspect, compare, explain,
  or act on the resource.
- **Legibility**: Use Sentry product terms and stable markdown sections.
- **Actionability**: Include IDs, URLs, pagination cursors, and follow-up tool
  hints only when they help navigation or the next tool call.
- **Safety**: Do not expose secrets, credentials, raw tokens, or unrelated
  internal details. Follow [../operations/security.md](../operations/security.md)
  for security boundaries.
- **Agent fit**: The output should be easy for an LLM to quote, summarize, and
  reason over without post-processing raw API payloads.

## Markdown Shape

Use a predictable markdown structure:

```markdown
# Resource Type in **scope**

## Resource Name

**Kind**: Issue Alert
**ID**: 123
**Project**: backend
**Status**: enabled
**URL**: https://example.sentry.io/...

### Conditions

- Event frequency count (comparison: 10, result: true)

## Response Notes

- Use `get_alert_rule` with `kind` and the numeric rule ID for full details.
```

Guidelines:

- Start with a clear `#` title that names the resource set or detail scope.
- Use `##` and `###` sections for repeated resource groups and details.
- Prefer bold labels for scalar facts.
- Prefer bullets or compact tables for repeated items.
- Omit sections that have no meaningful data unless the absence itself matters.
- Use `## Response Notes` only for scoped, result-specific guidance.

See [common-patterns.md](common-patterns.md) for shared schema and validation
patterns used alongside response formatting.

## Include

Include data that is useful for real user questions:

- Resource identity: name, kind, ID, org, project, slug, status.
- Navigation: web URLs, dashboard URLs, issue URLs, or monitor URLs.
- Operational state: owner, assignee, environment, release, last seen,
  last triggered, frequency, priority, or status.
- User-facing configuration: alert conditions, filters, triggers, actions,
  routing, notification targets, dashboard widgets, monitor schedules.
- Follow-up handles: IDs or cursors needed for a documented next tool call.
- Timestamps when they answer real freshness, history, or audit questions.

## Avoid

Do not leak implementation details into ordinary tool output:

- Raw API JSON unless the tool explicitly returns raw data.
- Internal IDs that are not useful follow-up handles, such as workflow component
  IDs, detector IDs, synthetic filter IDs, or trace plumbing identifiers.
- Placeholder noise such as `null`, `undefined`, empty arrays, empty objects,
  empty strings, `data:`, or `target display: unknown`.
- Upstream field names when a user-facing label is obvious, such as
  `conditionResult` instead of `result`.
- Empty sections created only because the API has that property.
- Long opaque payloads that require the model to reverse-engineer meaning.
- Broad assistant instructions such as `IMPORTANT`, `MUST`, `CRITICAL`, or
  output that tries to override behavior beyond the current result.

Tool descriptions and parameter `.describe()` strings remain the right place
for durable tool-selection guidance. Result text can include light scoped
guidance, but it should not act like a system prompt. See "Response Formatting"
in [common-patterns.md](common-patterns.md) for examples of acceptable response
notes.

## Formatting Upstream Data

Translate upstream API shapes into user-facing terms:

- Humanize machine names: `event_frequency_count` -> `Event frequency count`.
- Humanize keys: `conditionResult` -> `result`, `targetIdentifier` -> `target`.
- Flatten nested config only when it improves readability.
- Preserve values exactly when they are user-entered text, slugs, queries, or
  identifiers needed for follow-up.
- Drop empty, nullish, or unknown placeholder values before rendering details.
- Cap long repeated lists and say how many additional items were omitted.
- Prefer shared helpers for dates, actors, IDs, and unknown values. If a helper
  emits noisy placeholders for a domain-specific field, filter before calling it.

When changing Sentry API endpoint usage, validate the upstream behavior in
`~/src/sentry` as required by [../../AGENTS.md](../../AGENTS.md). API schemas
should model what Sentry returns, but tool responses should model what users
need.

### Issue Details

`get_issue_details` includes the issue's suspect commit when available, with
its SHA, message, author, and source. Structured responses expose
`suspectCommit`; Markdown responses include a `Suspect Commit` section with
the same data. Without a commit, the structured field is `null` and Markdown
omits the section. Commit lookup is optional: failures do not prevent issue
details from loading, but unexpected server or response-validation failures
are reported to Sentry.

The event API's legacy `context` field (extra data) can be `null`. Issue details
must still load; omit the `Extra Data` section for null or empty values while
preserving the event's error, stacktrace, and structured `contexts` data.

## Structured Content

MCP tools may expose `structuredContent` alongside generated text `content`.
Use it when clients need a typed result, pagination token, stable follow-up
handle, or machine-readable projection of the same result. The current MCP spec
defines `structuredContent` as a JSON object on `CallToolResult`, and
`outputSchema` as the schema for that object.

Policy (encoded in `packages/mcp-core/src/internal/tool-helpers/results.ts`):

- `structuredContent` is the source of truth when present.
- `content` text is a compatibility view of that same answer.
- Never put unique product data in only one side. If both fields are present,
  they must be equivalent. Form-only differences (JSON vs pretty text of the
  same payload) are fine; a second answer that exists in only one field is a
  bug.
- Data tools should use `structuredResult(payload)`. The server generates
  `content` as pretty JSON of that same payload.
- Markdown-only tools (for example issue and trace details today) should return
  markdown and omit `structuredContent` until they have a real structured
  payload. Do not attach sparse structured side-channels such as
  `suggestedActions` alone on top of markdown.
- If a tool declares `outputSchema`, every successful `structuredContent` result
  must conform to that schema.
- Do not duplicate a large structured payload into a markdown artifact block.
- Treat `structuredContent` as a stable product contract, not a raw upstream API
  passthrough. Map only documented fields that callers should depend on.
- Do not spread `.passthrough()` API schema objects directly into
  `structuredContent`; backend-only fields can leak into the public MCP
  interface.
- Keep names, nullability, arrays, cursors, and URLs aligned between
  `outputSchema`, tests, and generated definitions.
- Snapshot `structuredContent` for structured tools, similar to handwritten
  content snapshots for markdown tools. Include a regression assertion for
  fields that must not leak when the upstream response schema is passthrough.
- Test generated compatibility text at the server boundary, not inside
  structured tool handler tests.
- Use tool execution errors with `isError: true` for recoverable tool failures.
  Do not return partial success-shaped `structuredContent` for errors unless the
  error shape is explicitly modeled.

Reference: MCP 2025-11-25 Tools specification, sections "Structured Content"
and "Output Schema".

## Suggested Actions

Use `suggestedActions` when a tool result reveals a concrete follow-up tool call
that a client or agent could offer as a continuation. This is the
machine-readable counterpart to a narrow `## Response Notes` hint.

```typescript
interface SuggestedToolAction {
  type: "tool_call";
  toolName: string;
  arguments: Record<string, unknown>;
  reason: string;
}

interface SuggestedActionsContent {
  suggestedActions: SuggestedToolAction[];
}
```

Guidelines:

- Include only actions that are directly supported by the current result. Do not
  include broad investigation plans or generic next steps.
- Arguments must be complete enough to call the tool without reparsing markdown.
- Use public MCP parameter names and values, not upstream API field names.
- Respect tool availability in the current session. Omit actions for unavailable
  tools.
- Keep the list small and ordered by likely usefulness. Prefer one action; use a
  hard cap of three.
- Keep `reason` concise and descriptive. It should explain why the action is
  useful, not instruct the model how to behave.
- When the tool result is markdown-only, put the follow-up only in
  `## Response Notes` / product sections. Do not also emit sparse
  `structuredContent.suggestedActions`.
- When the tool result is structured, include `suggestedActions` in that same
  structured payload and keep any markdown/compat text equivalent.
- Do not include secrets, auth tokens, raw payloads, or sensitive user data in
  action arguments or reasons.

## Response Notes

Use response notes for narrow, operational guidance:

- Good: `Use get_alert_rule with kind and the numeric rule ID for full details.`
- Good: `More results are available. Pass cursor: "..." with the same scope.`
- Good: `Use these details to inspect alert conditions, filters, routing, and notification actions before changing the rule in Sentry.`

Avoid implementation jargon:

- Avoid: `Treat the returned payload as the canonical source for mutation workflows.`
- Avoid: `Inspect detector IDs before constructing workflow payloads.`
- Avoid: `Display these results exactly as written.`

## Snapshot Policy

Every MCP tool test suite must include at least one representative successful
call that snapshots the full formatted handler response. This requirement is
defined in [../testing/overview.md](../testing/overview.md) and applies to both
new tools and meaningful output changes.

When reviewing snapshots:

- Review them as user-facing product output, not only as changed strings.
- Confirm the output includes the fields needed for common real-world questions.
- Confirm internal IDs, raw JSON, and placeholder values are absent unless they
  are intentionally part of the contract.
- Add targeted negative assertions for known regression risks, such as raw
  workflow JSON or stale internal fields.
- Include representative upstream internals in fixtures when migrations need to
  prove that formatting cleans them up.

Partial `toContain()` assertions are useful for branch-specific behavior, but
they do not replace a full-response snapshot.

## QA Policy

For output-format changes:

- Run the normal quality gate from [quality-checks.md](quality-checks.md).
- Use the stdio MCP QA path in
  [.agents/skills/mcp-qa/SKILL.md](../../.agents/skills/mcp-qa/SKILL.md).
- Inspect the raw MCP tool result when possible, not only the LLM's final
  answer. The test client's final answer can add model-specific phrasing that is
  not part of the tool response.
- Use a realistic prod prompt that asks for the fields the changed tool should
  support.

If the raw tool result is clean but the agent final answer adds unrelated
content, treat that as a client/agent prompt issue rather than a tool response
formatting issue.
