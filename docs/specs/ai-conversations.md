# Agent Conversations MCP Specification

## Overview

Agent Conversations should be a first-class MCP concept with conversation-shaped
search and detail retrieval. Users should not need to know that conversations
are implemented on top of spans or the `gen_ai.conversation.id` span attribute.

The MCP interface should expose:

- `search_agent_conversations` for finding and listing matching conversations
- `get_agent_conversation_details` for fetching one conversation transcript by ID
- `get_sentry_resource` for fetching one conversation from a Sentry URL

For backward compatibility, `search_ai_conversations` and
`get_ai_conversation_details` remain callable as deprecated catalog aliases.
New integrations should use the Agent tool names.

Raw span search remains available for lower-level telemetry investigation, but
it is not the primary interface for conversation discovery.

## Motivation

Agent Conversations string together related GenAI spans into an agent session or
thread. The user intent is conversation-level:

- "show recent agent conversations"
- "find failed conversations"
- "search conversations where the user asked about checkout"
- "show conversations that used this tool"
- "find expensive conversations"

Using `search_events` with `dataset="spans"` returns span rows. That leaks the
implementation detail and can produce many rows per conversation. Conversation
search should instead return one row per conversation, with conversation-level
summary fields and clear follow-up paths to inspect the transcript or related
traces.

## User Model

An Agent Conversation is a logical agent session or thread made from related GenAI
telemetry. In MCP, users interact with three shapes:

1. **Conversation summary**: a row in search/list results.
2. **Conversation detail**: a transcript and structured artifact for one
   conversation.
3. **Conversation URL**: a stable Sentry Explore URL that can be passed to
   `get_sentry_resource`.

Spans are an implementation detail for this feature. Use span search only when
the user explicitly wants raw span-level analysis or needs to debug underlying
telemetry.

## Tool Surface

Add one catalog-only tool:

```text
search_agent_conversations
```

Keep existing tools:

- `get_agent_conversation_details`: fetches one conversation by
  `gen_ai.conversation.id`
- `get_sentry_resource`: detects conversation URLs and routes to conversation
  details
- `search_events`: searches raw events, logs, spans, metrics, profiles, and
  replays

Do not add agent conversation tools to the top-level direct MCP surface for now.
Catalog-only is sufficient because:

- `get_sentry_resource` handles pasted Sentry conversation URLs directly.
- `search_sentry_tools` and `execute_sentry_tool` can discover and invoke
  catalog tools.
- The default direct surface remains small.

## Search Interface

`search_agent_conversations` answers conversation-level discovery questions. It
returns one item per conversation, never one item per span.

```typescript
interface SearchAIConversationsParams {
  organizationSlug: string;
  query?: string;
  project?: string | string[];
  environment?: string | string[];
  period?: string;
  start?: string;
  end?: string;
  limit?: number;
  cursor?: string;
  regionUrl?: string;
}
```

Parameter behavior:

- `organizationSlug` is required.
- `query` is a user-facing conversation query/filter string passed to the
  Sentry Agent Conversations list endpoint.
- Results use the Sentry endpoint's default ordering: most recent conversation
  activity first. Do not expose alternate sort options until the backend applies
  them.
- `project` scopes results to one or more projects. The backend accepts numeric
  project IDs; MCP may resolve project slugs to IDs for ergonomics.
- `environment` scopes results to one or more environments.
- `period` or `start`/`end` controls the MCP-facing time range.
- `limit` controls page size and must respect the backend maximum.
- `cursor` requests the next page when Sentry pagination provides one.
- `regionUrl` selects the Sentry region endpoint.

## Backend API

Use the Sentry Agent Conversations list endpoint:

```text
GET /api/0/organizations/{organizationSlug}/agents/conversations/
```

Do not implement conversation search through
`search_events(dataset="spans")`.

Issue and trace detail enrichment may still perform a bounded opportunistic
span lookup when the caller already has a trace ID. That lookup must stay scoped
to the trace, request only the fields needed to identify conversation IDs and
matching spans plus any field required for result ordering, cap results to a
small number, and route transcript follow-up through
`get_agent_conversation_details`. It is not a replacement for
`search_agent_conversations`. This follows Sentry's Spans-backed agent conversation
endpoints, which select `gen_ai.conversation.id` from spans, and existing
trace-scoped spans queries that use `trace:<trace_id>`.

When issue or trace detail output identifies agent conversation IDs, keep the
result markdown-only and put the callable follow-up in the markdown
`Response Notes` or `Agent Conversations` section. Do not attach sparse
`structuredContent.suggestedActions` on these tools: `structuredContent` is
source of truth when present, and a side-channel-only payload would uniquely
diverge from the issue/trace answer.

If `get_agent_conversation_details` is only available through the catalog, the
markdown instruction must call `execute_sentry_tool` with
`name: "get_agent_conversation_details"` and the target arguments; only use the
catalog tool name directly when it is exposed through `tools/list`. Emit either
instruction only when its direct tool surface is available. Follow the shared
suggested action contract in
[Tool Responses](../contributing/tool-responses.md#suggested-actions).

Expected query parameters:

- `query`
- `project`
- `environment`
- `statsPeriod` or `start`/`end`
- `cursor`
- `per_page`

Expected response item shape:

```typescript
interface AIConversationSummary {
  conversationId: string;
  title: string | null;
  flow: string[];
  startTimestamp: number;
  endTimestamp: number;
  errors: number;
  firstInput: string | null;
  lastOutput: string | null;
  llmCalls: number;
  toolCalls: number;
  toolErrors: number;
  toolNames: string[];
  totalTokens: number;
  totalCost: number;
  traceCount: number;
  traceIds: string[];
  user: {
    id: string | null;
    email: string | null;
    username: string | null;
    ip_address: string | null;
  } | null;
}
```

This shape is based on the Sentry backend source, specifically
`src/sentry/api/endpoints/organization_ai_conversations.py` and
`src/sentry/api/serializers/rest_framework/ai_conversations.py` in the Sentry
repository.

## Search Output

`search_agent_conversations` should return structuredContent optimized for agent
use. Do not hand-write markdown for this tool; the server generates
compatibility text from the same structured payload for clients that do not read
structuredContent yet.

The top-level structured result should include:

- Organization slug.
- A Sentry Explore conversations URL when constructible.
- Conversation summaries.
- Result count.
- Next cursor when Sentry pagination reports one.

Each result should include:

- Conversation ID.
- AI-generated title when Sentry has conversation metadata (`null` otherwise).
- Sentry URL: `/explore/conversations/{conversationId}/`.
- Start, end, and derived duration.
- Flow, when available.
- First input preview, capped to a compact debugging snippet.
- Last output preview, capped to a compact debugging snippet.
- User summary.
- Error count.
- AI call count.
- Tool call count and tool error count.
- Tool names.
- Total tokens and a display-formatted USD total cost. Use `—` for zero, `<$0.01` for positive sub-cent costs, and compact currency formatting otherwise.
- Trace count and a small sample of trace IDs.

Search and detail structured outputs use Unix millisecond timestamps for
conversation-level and timeline timestamp fields.

Agents should use the structured fields to decide follow-ups:

- Use `get_agent_conversation_details` with `conversationId` for the transcript and
  full structured detail.
- Use `get_sentry_resource` with the conversation URL when the user provides or
  wants to reuse a Sentry URL.
- Query spans with `search_events` using dataset `spans` and query
  `gen_ai.conversation.id:<conversationId>` when inspecting telemetry for the
  full conversation across traces.
- Treat sampled trace IDs as per-trace follow-up targets only; a conversation
  can span more traces than the sample includes.

## Detail Interface

`get_agent_conversation_details` remains the transcript/detail tool. The detail
response should be a conversation-native projection of GenAI telemetry, not a
raw span dump and not a lossy grouping invented by MCP.

Current expected behavior:

- Input is organization slug plus conversation ID.
- Output includes `title` when Sentry has conversation metadata (`null` otherwise).
- Output includes a chronological transcript timeline.
- Timeline events are sorted by event timestamp and include a `type`
  discriminator.
- Output includes the lookup window used for the Sentry request: either the
  default `statsPeriod` or explicit `start` and `end` values.
- User and assistant message events are extracted from GenAI input/output
  fields.
- User message events include `userEmail` when the source span has
  `user.email`.
- Tool call events are represented as first-class timeline events, not nested
  under a synthetic turn.
- Each timeline event includes enough trace context to debug it, including
  `spanId`, `traceId`, timestamp, status or duration when available, and compact
  tool input/argument fields when useful.
- Timeline events expose a stable `genAi` block for relevant GenAI attributes,
  including operation type, agent name, request/response model, token totals,
  raw message attributes, response fields, and tool definitions when available.
  Tool call timeline events expose their payloads through the event-level
  `arguments` and `input` fields; exact `gen_ai.tool.*` attribute names remain
  available on span summaries.
- Large raw GenAI message and tool payload attributes are truncated in the MCP
  response. Truncated `genAi` fields are listed in `genAi.truncatedFields`; use
  the event or span summary `spanId` and `traceId` to query the underlying span
  when the full value is needed.
- Output includes chronological span summaries with `spanId`, `traceId`,
  parent span ID, project, timestamp, duration, span name/op/description/status,
  transaction, and the same stable `genAi` attribute projection.
- Conversation-level context includes trace IDs, projects, token totals, and
  summary counts.
- A structured JSON artifact is included.

The transcript goal is chronological inspection. Agents should not need to
infer event order from nested turn structures, and MCP should not imply that a
tool call belongs to a message unless that relationship is explicit in the
underlying telemetry. Use trace/span IDs for deeper execution-tree analysis.

Required refinements:

- Update the description to recommend `search_agent_conversations` for discovering
  or listing conversations.
- Keep raw span search documented only as a fallback for low-level telemetry
  analysis.
- Accept `start` and `end` when details are fetched from a URL with explicit
  time bounds.
- Continue accepting `project` from URL query parameters.

## URL Handling

`get_sentry_resource` is the primary URL entrypoint for conversations.

Supported URL pattern:

```text
/explore/conversations/{conversationId}/
```

The URL parser should extract:

- `conversationId`
- `project`
- `start`
- `end`

Fetch by URL must not require `search_agent_conversations`. If a user pastes a
conversation URL, `get_sentry_resource` should route directly to
`get_agent_conversation_details`.

## Relationship To Traces

Traces and conversations should have parallel concepts:

Conversation:

- `search_agent_conversations`: returns matching conversations.
- `get_agent_conversation_details`: returns one full conversation.

Trace:

- `get_trace_details`: returns one full trace by trace ID.
- A true trace-level search tool does not currently exist.
- `search_events(dataset="spans")` returns span rows, not trace rows.

A conversation can include spans from multiple traces. `get_trace_details`
should not be the primary conversation follow-up because it only inspects one
trace. Agents should query spans by `gen_ai.conversation.id` when they need
conversation-related telemetry across trace boundaries.

Agent Conversations should not copy the current trace-search limitation.
Conversation search should be conversation-native from the start.

## Relationship To Spans

Use `search_events(dataset="spans")` only for:

- Debugging raw GenAI spans.
- Finding available attributes.
- Investigating a specific trace or conversation at the span level.
- Running aggregate telemetry analysis.

Do not route ordinary conversation discovery through spans once
`search_agent_conversations` exists.

## API Client Requirements

Add parsed schemas for:

- `AIConversationUserSchema`
- `AIConversationSummarySchema`
- `AIConversationSummaryListSchema`

Add an API client method:

```typescript
searchAIConversations(params, opts?)
```

The method should:

- Build query parameters safely.
- Support repeated `project` and `environment` parameters.
- Support `statsPeriod` or `start`/`end`.
- Support `cursor` and `per_page`.
- Avoid sending `sort` until the Sentry endpoint applies alternate ordering.
- Parse the list response.
- Preserve pagination metadata if existing client patterns support it.

If pagination metadata is not modeled elsewhere, the first implementation may
return the current page and expose a clear follow-up path for adding cursor
metadata.

## Source Verification Requirements

Before implementing or changing any Agent Conversations endpoint usage, verify the
current request and response contract against the Sentry source tree in
`~/src/sentry`. Do not rely only on UI assumptions, API docs, or existing MCP
schemas.

For this spec, the relevant source files are:

- `src/sentry/api/endpoints/organization_ai_conversations.py`
- `src/sentry/api/endpoints/organization_ai_conversation_details.py`
- `src/sentry/api/serializers/rest_framework/ai_conversations.py`
- `tests/sentry/api/endpoints/test_organization_ai_conversations.py`
- `tests/sentry/api/endpoints/test_organization_ai_conversation_details.py`

The implementation should be updated if those files show that accepted query
parameters, ordering behavior, sampling modes, response fields, pagination
behavior, feature gates, or retention behavior differ from this spec.

## Tool Registration

Register `search_agent_conversations` and `get_agent_conversation_details` in
the catalog. Keep `search_ai_conversations` and
`get_ai_conversation_details` as deprecated aliases for backward-compatible
catalog execution, but do not include the aliases in generated skill
definitions.

Do not add it to:

- `TOP_LEVEL_TOOL_NAMES`
- wrapper tools
- direct surface lists

After tool changes, run:

```bash
pnpm run --filter @sentry/mcp-core generate-definitions
```

## Documentation Requirements

Update tool descriptions so agents follow this workflow:

1. Use `search_agent_conversations` to find or list Agent Conversations.
2. Use `get_agent_conversation_details` to fetch a transcript by conversation ID.
3. Use `get_sentry_resource` for Sentry conversation URLs.
4. Use `search_events` with `dataset="spans"` only for raw span-level analysis.

At minimum, update:

- `get_agent_conversation_details` description.
- `get_sentry_resource` agent conversation guidance.
- Generated tool and skill definitions.

## Examples

Search recent conversations:

```typescript
search_agent_conversations({
  organizationSlug: "my-org",
  query: "recent conversations",
  period: "24h",
});
```

Find failed conversations:

```typescript
search_agent_conversations({
  organizationSlug: "my-org",
  query: "failed conversations",
  period: "7d",
});
```

Fetch a transcript from a result:

```typescript
get_agent_conversation_details({
  organizationSlug: "my-org",
  conversationId: "conversation-123",
});
```

Fetch from a Sentry URL:

```typescript
get_sentry_resource({
  url: "https://my-org.sentry.io/explore/conversations/conversation-123/",
});
```

## Testing

Add focused tests for:

1. Basic search:
   - Calls `/organizations/{org}/agents/conversations/`.
   - Passes `query`, `per_page`, and time parameters.
   - Returns one structured summary per conversation.
2. Empty results:
   - Returns an empty `conversations` array.
   - Includes result metadata such as organization slug and result count.
3. Filters:
   - `project`
   - `environment`
   - `statsPeriod`
   - explicit `start` and `end`
   - `cursor`
4. Structured output:
   - Includes conversation URLs.
   - Includes first input and last output previews.
   - Includes tool names and tool errors.
   - Includes trace count and sampled trace IDs.
   - Generates compatibility text from structuredContent at the server boundary.
5. Content block normalization:
   - `firstInput` arrays become readable text.
6. Catalog registration:
   - Tool is in the catalog.
   - Tool is not in the top-level direct surface.
7. Existing URL behavior:
   - `get_sentry_resource(url=conversationUrl)` still routes to details.

## Acceptance Criteria

This feature is complete when:

- Users can search and list Agent Conversations without knowing about spans.
- Search results are conversation summaries, not span rows.
- Users can fetch details by conversation ID.
- Users can fetch details by Sentry conversation URL.
- Tool descriptions route agents toward the conversation-native workflow.
- `search_events(dataset="spans")` remains available but is no longer the
  recommended conversation discovery path.
- Generated definitions are updated.
- Focused tests pass.

## Future Work

- Add a trace-level search tool that returns one row per trace, parallel to
  `search_agent_conversations`.
- Add pagination metadata to formatted output if the API client standardizes
  cursor handling.
