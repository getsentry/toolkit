# MCP tools

Sentry MCP gives an agent tools to read and change Sentry data from the
harness the user already works in, such as Claude Code, Codex, or Cursor.

## Intent

- The agent finds the right Sentry tool through its harness's own tool
  search. Sentry MCP lists every tool the session can call, and does not hide
  long-tail tools behind a search tool of its own, because tier 1 harnesses
  now load tool schemas on demand.
- A change works in every tier 1 harness (Codex, Claude Code, Cursor). Tier 2
  harnesses (OpenCode, Pi, VS Code with Copilot) do not break, and a known
  tier 2 gap is written down in the supported harnesses guide before it ships.
- A session lists only the tools it can call. Skills, the org or project
  scope, and the server mode decide that before a tool is listed or run, so
  the agent never picks a tool that fails for access reasons.
- Each tool definition stays small, because every name, description, and
  schema costs context in every session that lists it.
- Tool descriptions and parameter descriptions carry the guidance on when to
  pick a tool. Results answer the current call, and do not steer the agent
  like a system prompt.

## Entry points

- `tools/list` and `tools/call` from an MCP client, over stdio (`sentry mcp`,
  `@sentry/mcp-server`) or remote HTTP (`https://mcp.sentry.dev/mcp`).
- Server instructions, sent on `initialize`.
- `get_sentry_resource` for a pasted Sentry URL, or an issue, event, trace,
  or replay ID.
- `--experimental` (stdio) or experimental mode (remote) for tool variants
  that are not stable yet.
- `search_sentry_tools` and `execute_sentry_tool`, only on the fallback
  gateway surface.
- MCP Apps views, which follow [MCP Apps views](./mcp-apps.md).
  `render_sentry_chart` is the one tool with a view.

## Rules

- Every tool says whether it only reads, whether it can destroy data, and
  whether it reaches outside Sentry. Harness filters and confirmation prompts
  depend on these hints, so none is ever left unset.
- Every tool has a unique display title.
- `tools/list` returns one page, so a client that ignores paging still sees
  every tool.
- Server instructions stay under 1,500 characters, and name a tool only when
  the session has it.
- The fallback gateway surface lists about 20 tools, and never more than 25.
- Tools are not a raw proxy for the Sentry API. A tool exists for a question
  or task a user brings, and its result follows
  [MCP tool responses](./mcp-tool-responses.md).

## Gaps

- VS Code with Copilot loads every tool schema up front for models other
  than Claude newer than 4.5 and GPT-5.4 or later, so a full listing costs
  those sessions context. This breaks "the agent finds the right Sentry tool
  through its harness's own tool search" for a tier 2 harness.
