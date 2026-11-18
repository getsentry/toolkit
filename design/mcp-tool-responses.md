# MCP tool responses

A Sentry MCP tool result gives an agent what it needs to answer a real Sentry
question, in Sentry's own terms, without reading upstream API payloads.

## Intent

- A result is product output for the agent and the user. It has the fields
  someone needs to inspect, compare, explain, or act on the resource.
- A result models what users need, not what the Sentry API returns. Upstream
  field names, internal IDs, and empty placeholders stay out.
- A typed result is one answer. When a tool returns structured content, that
  content is the answer, and the text is the same answer for clients that only
  read text. No product data exists in only one of the two.
- A result never carries secrets, credentials, or tokens, and upstream text
  cannot rewrite the result around it.
- A result is a fact about this call, not an instruction. It may point at a
  next tool call that the result supports, but it never tells the agent how
  to behave.

## Entry points

- The result of any `tools/call`: text content, plus structured content for
  tools that declare an output schema.
- Suggested actions: follow-up tool calls that a client can offer.
- Response notes and side quests: short tips at the end of a result, such as
  a pagination cursor or source maps that failed to apply.
- Feedback suggestions that point at `submit_feedback_to_sentry_team`.

## Rules

- A tool that declares an output schema returns structured content that
  matches it on every successful call, and the text is that same payload as
  compact JSON.
- A markdown tool returns markdown only. It does not attach a sparse
  structured side channel, such as suggested actions alone.
- Structured content is a stable contract. It holds only the fields that
  callers should depend on, and never passes through upstream fields as-is.
- A suggested action is complete enough to call as-is, names a tool the
  session can call, and comes from this result. A result suggests at most
  three.
- A failed call is a tool error (`isError`), not a success-shaped result. An
  empty result is a success. A missing resource is an input error that points
  at the tool that can find it.
- Optional details, such as a suspect commit, never stop the main result from
  loading when they fail.
- Long lists and long text are capped, and the result says how much it left
  out.
- A side quest appears only when Sentry's own data shows the problem
  unambiguously, and it names the fix.
- A feedback suggestion appears only when the result likely shows a Sentry
  MCP bug or gap. Input, permission, auth, rate limit, and configuration
  errors, and empty results that are expected, never get one.

## Gaps

- `search_attributes` returns no structured content yet. This breaks "a typed
  result is one answer" for the one listed tool that has no output schema.
