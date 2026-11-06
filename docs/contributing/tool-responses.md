# Tool Responses

How to build an MCP tool result that meets
[MCP tool responses](../../design/mcp-tool-responses.md), which owns the goals
and rules. This guide covers conventions that apply to every tool. It does not
describe each tool's response: a tool's own output belongs in its description,
its `outputSchema`, and its tests.

Use it when adding a tool, changing formatted handler output, updating
snapshots, or QAing MCP behavior. For the full tool implementation flow, see
[adding-tools.md](adding-tools.md). For snapshot requirements, see
[../testing/overview.md](../testing/overview.md). For end-to-end MCP
validation, see [.agents/skills/mcp-qa/SKILL.md](../../.agents/skills/mcp-qa/SKILL.md).

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
- Request headers, cookies, and bodies, and other upstream data that can carry
  credentials.
- Broad assistant instructions such as `IMPORTANT`, `MUST`, `CRITICAL`, or
  output that tries to override behavior beyond the current result.

Tool descriptions and parameter `.describe()` strings remain the right place
for durable tool-selection guidance. Result text can include light scoped
guidance, but it should not act like a system prompt. See "Response Formatting"
in [common-patterns.md](common-patterns.md) for examples of acceptable response
notes.

## Side Quests

Side quests are things that might help but may not matter for the current
task, such as configuration issues or follow-ups. Source maps that failed to
apply are one. List each once, at the end under `## Concerns Identified`, as a
short tip that names the problem and its fix. When one changes how to read the
current data, say so in the tip: "Source maps weren't applied, so frames may be
minified." Raise one only when Sentry's own data shows it unambiguously. Build
them with `buildSideQuests` in `packages/mcp-core/src/internal/side-quests.ts`.

## Formatting Upstream Data

Translate upstream API shapes into user-facing terms:

- Humanize machine names: `event_frequency_count` -> `Event frequency count`.
- Humanize keys: `conditionResult` -> `result`, `targetIdentifier` -> `target`.
- Flatten nested config only when it improves readability.
- Preserve values exactly when they are user-entered text, slugs, queries, or
  identifiers needed for follow-up.
- Drop empty, nullish, or unknown placeholder values before rendering details.
- Cap long repeated lists and say how many additional items were omitted.
- Truncate long text with plain `slice`. A cut can leave half of an emoji, and
  strict JSON clients such as Codex reject that lone surrogate, so the server
  replaces it with U+FFFD in every tool response. Formatters do not need
  surrogate-aware slicing.
- Treat optional enrichment, such as a suspect commit, as best effort: when its
  request fails, keep the main result, and report only unexpected server or
  validation failures to Sentry.
- Return an empty result as a success. Return a missing named resource as a
  user input error that names the tool that can find it.
- Prefer shared helpers for dates, actors, IDs, and unknown values. If a helper
  emits noisy placeholders for a domain-specific field, filter before calling it.
- Render untrusted values with `@sentry/toolkit-core/markdown`, chosen by what
  the value is: `inlineCode` for identifiers, slugs, queries, and short values,
  `codeBlock` for multi-line data such as messages and stack traces, and `text`
  for values that should read as prose. Each keeps the value inside its line or
  block, so upstream data cannot add headings, list items, or links. Prefer
  `inlineCode`: it needs no escaping, so the model reads the value unchanged.

When changing Sentry API endpoint usage, validate the upstream behavior in
`~/src/sentry` as required by [../../AGENTS.md](../../AGENTS.md). API schemas
should model what Sentry returns, but tool responses should model what users
need.

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
  they must be equivalent. Form-only differences (`structuredContent` vs its
  serialized JSON text) are fine; a second answer that exists in only one
  field is a bug.
- Data tools should use `structuredResult(payload)`. The server generates
  `content` as compact JSON (no indentation) of that same payload. Most
  clients that read the text send it to a model, and indentation adds tokens
  without adding data.
- Markdown-only tools (for example trace details today) should return
  markdown and omit `structuredContent` until they have a real structured
  payload. Do not attach sparse structured side-channels such as
  `suggestedActions` alone on top of markdown.
- If a tool declares `outputSchema`, every successful `structuredContent` result
  must conform to that schema. `defineTool` enforces this at compile time: the
  handler must return `structuredResult(...)` typed as the schema's `z.output`,
  and markdown or raw content fails tsc. The payload type comes from the
  schema, so missing and mistyped fields are errors at the tool definition,
  and so are extra fields in an object literal passed to `structuredResult`.
  Spread or variable payloads (`structuredResult({ ...upstream })`,
  `structuredResult(payload)`) are not checked for extra fields, so map fields
  explicitly. A schema tool cannot set its own `content`.
  Do not add per-tool `satisfies z.infer<...>` checks; they repeat
  what the framework already checks. Shared builders should declare their
  return type (`StructuredToolOutput<z.output<typeof schema>>`) so
  `structuredResult` gets its type from there.
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

## Metadata Linter

`packages/mcp-core/src/server.metadata.test.ts` builds the server with every
skill granted, in stable and experimental mode, and checks what a client
receives from `initialize` and `tools/list`:

- `serverInfo` keeps `name: "Sentry MCP"` and sets `title`, `description`, an
  https `websiteUrl`, and https `icons`.
- `instructions` are non-empty and at most `MAX_SERVER_INSTRUCTIONS_LENGTH`
  characters.
- Every tool name matches `^[A-Za-z0-9_.-]{1,128}$`, its `inputSchema` root is
  an object, and it advertises no `execution.taskSupport`.
- Every tool has a unique, non-empty `title`; sets `readOnlyHint`,
  `destructiveHint`, and `openWorldHint`; and has a description of at most
  `MAX_TOOL_DESCRIPTION_LENGTH` characters.
- A tool exports only the `_meta` keys that `ALLOWED_TOOL_META` lists for it.
- Every tool declares an object `outputSchema`, unless it has a skip entry.

`test-utils/structured-output-guard.ts` wraps `defineTool` for the whole
mcp-core suite, the same way the SDK validates `tools/call`: a handler with an
`outputSchema` that returns no `structuredContent`, or `structuredContent` that
does not match the schema, fails the test that called it. Error results
(`isError: true`) are skipped. The linter checks that each listed tool with an
`outputSchema` has a colocated `<name>*.test.ts` that reads its
`structuredContent`.

To skip the `outputSchema` check, add the tool to one of two maps, with a
reason:

- `OUTPUT_SCHEMA_EXEMPT` for tools that return no structured content by design,
  such as the markdown-only tools above.
- `OUTPUT_SCHEMA_PENDING` for tools whose `outputSchema` has not landed, with
  the PR, for example `"pending getsentry/toolkit#2004"`.

An entry fails once its tool has an `outputSchema`, so the PR that adds one
also deletes the entry. To add a `_meta` key, add it to `ALLOWED_TOOL_META`
with a comment that says which client reads it.

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

Build each action with `buildSuggestedToolAction` from
`packages/mcp-core/src/internal/tool-helpers/suggested-actions.ts`. It returns
null when the session cannot call the tool, and routes through
`execute_sentry_tool` when the target is catalog-only.

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

## Feedback Suggestions

When a result likely means a Sentry MCP bug or gap, add a response note that
points the agent at `submit_feedback_to_sentry_team`. Build it with
`formatFeedbackSuggestion` from
`packages/mcp-core/src/internal/tool-helpers/feedback-suggestion.ts`. It returns
null when the session cannot call the tool, for example when Sentry has no DSN.

This is a note, not a `suggestedActions` entry: the agent has to write the task
and description, so the call is never complete. The note only names the tool.
Do not prefill arguments or event IDs; the feedback event already carries the
user and client tags and the trace that Sentry MCP sets on every tool call.

Suggest feedback only for:

- Unexpected errors, Sentry API 5xx errors, and embedded agent failures.
  `formatErrorForUser` adds these.
- `search_sentry_tools` results with no match.
- Translated event searches that return nothing.

Do not suggest it for input, validation, permission, auth, rate limit,
configuration, or AI provider errors, or for empty results that are expected.

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
- Capture the raw result offline with the `verify-toolkit` skill
  ([.agents/skills/verify-toolkit/SKILL.md](../../.agents/skills/verify-toolkit/SKILL.md));
  its `mcp-tool-responses` map checks the rules every result follows.
- Use the stdio MCP QA path in
  [.agents/skills/mcp-qa/SKILL.md](../../.agents/skills/mcp-qa/SKILL.md)
  against prod data.
- Inspect the raw MCP tool result when possible, not only the LLM's final
  answer. The test client's final answer can add model-specific phrasing that is
  not part of the tool response.
- Use a realistic prod prompt that asks for the fields the changed tool should
  support.

If the raw tool result is clean but the agent final answer adds unrelated
content, treat that as a client/agent prompt issue rather than a tool response
formatting issue.
