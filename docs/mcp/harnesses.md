# Supported Harnesses

The agent harnesses Sentry MCP treats as first class, and how each one handles
large MCP tool lists. Use this list as the baseline for MCP decisions that
depend on client behavior: tool count, tool exposure, schema size, transports,
and auth.

## When to Use

- Deciding whether a change is safe across clients, such as adding tools to
  `tools/list` or changing schema shape.
- Deciding when to retire `search_sentry_tools` and `execute_sentry_tool`.
- Picking which clients to QA with the `mcp-qa` skill.

## Harness Tiers

A change must work in every tier 1 harness. Tier 2 harnesses should not break,
and a known tier 2 gap must be written down here before we ship.

**Tier 1.** Each listed surface counts on its own.

- Codex: the CLI/TUI and the desktop app (the ChatGPT desktop app's Codex mode)
- Claude Code: the CLI/TUI and Claude Desktop's Code tab
- Cursor: the IDE agent and the CLI (`cursor-agent` / `agent`)

**Tier 2**

- OpenCode: TUI, web, and desktop share one server
- Pi (`earendil-works/pi`, formerly `badlogic/pi-mono`)
- VS Code with GitHub Copilot Chat agent mode

Clients outside these tiers, such as Claude.ai connectors, Gemini CLI, and
Windsurf, are best effort. They do not block a decision.

## Native Tool Search

Research date: 2026-11-03. Clients change quickly, so check the sources again
before you rely on a row for a new decision.

The question for each harness: when a server lists many tools, does the client
keep their schemas out of the context window and load them on demand? If every
harness does, Sentry MCP can list all of its tools directly and drop its own
search/execute pattern.

| Harness                | Native deferral | Mechanism                                                        | Default             | Gate                                                           |
| ---------------------- | --------------- | ---------------------------------------------------------------- | ------------------- | -------------------------------------------------------------- |
| Codex CLI              | Yes             | Responses API `tool_search` (client executed, local BM25)        | On, always defers   | Model `supports_search_tool` (GPT-5.4+)                        |
| Codex desktop          | Yes (inferred)  | Same `codex-rs` core as the CLI                                  | On                  | Same as the CLI; bundled core version not checked              |
| Claude Code CLI        | Yes             | Built-in `ToolSearch` with `defer_loading` and `tool_reference`  | On, always defers   | Claude 4 and later; `ENABLE_TOOL_SEARCH`                       |
| Claude Code desktop    | Yes (inferred)  | Same engine and configuration as the CLI                         | On                  | Same as the CLI                                                |
| Cursor IDE             | Yes             | Dynamic context discovery: tool JSON files plus file search      | On                  | None documented                                                |
| Cursor CLI             | Yes             | Lazy MCP loading, matching the IDE                               | On (since ~2026-09) | None documented; only a staff forum post                       |
| OpenCode               | Yes, Code Mode  | One `execute` tool; `search()` and calls run inside a JS sandbox | On per server       | `mcp.servers.<name>.codemode: false` opts out                  |
| Pi                     | Yes, Code Mode  | `codemode` exposure by default; `deferred` adds `tool_search`    | On per server       | Per-server `exposure`                                          |
| VS Code + Copilot Chat | Partial         | "Tool search tool" with `defer_loading` or Responses API search  | On                  | Claude newer than 4.5 and GPT-5.4+ only; other models load all |

### Server Instructions

Harnesses that defer tools still load the server `instructions` at session
start, so that text is how the model learns when to search for Sentry tools.
`buildServerInstructions` in `packages/mcp-core/src/server-instructions.ts`
writes them from the registered tools: one line on when to use Sentry, plus
routing rules that name a tool only when the session registered it. Every line
must change what the model does; leave out product description and anything a
tool description covers. Keep them under 1,500 characters; Claude Code cuts
server instructions at 4,096.

### Tier 1 Details

**Codex (CLI and desktop).** Since CLI 0.143.0 (2026-07-08), every MCP tool is
deferred behind the Responses API `tool_search` tool whenever the model
supports it. Codex runs the search locally with BM25 over tool names and
descriptions and returns up to 8 matches. There is no tool-count threshold. The
older `tool_search*` feature flags do nothing now.

- Unknown model slugs and Bedrock routing set `supports_search_tool = false`
  and send MCP tools directly.
- A server can opt out with `omit_tools_from = ["deferred"]`.
- Limits: 2,048 catalog items per server.
- The desktop app and the IDE extension run the same app-server and `codex-rs`
  core, pinned to a tested version.

**Claude Code (CLI and desktop).** MCP tool search has been on by default since
v2.1.7. It was `auto` at a 10% context threshold at first and now always defers.
Only tool names and server instructions load at session start; the model calls
`ToolSearch` to load schemas.

- `ENABLE_TOOL_SEARCH` accepts `true`, `false`, `auto`, and `auto:N`.
- Older models load everything up front. So do sessions with
  `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`, HIPAA sessions, and Azure Foundry.
- A server can keep chosen tools loaded with `_meta["anthropic/alwaysLoad"]`,
  for example `get_sentry_resource`. The key is specific to Claude Code, and
  long-term support is uncertain.
- Description caps: 4,096 characters for upfront tools and server instructions,
  16,384 for deferred tools.
- No fixed tool cap; the context window is the limit.
- Desktop docs say it uses the same engine and configuration as the CLI.

**Cursor (IDE and CLI).** The IDE has used dynamic context discovery since 2.4
(2026-01-22). Tool definitions are synced to JSON files, the model sees only
tool names, and it reads schemas on demand. Cursor no longer documents the old
~40-tool cap, though per-model provider caps still exist.

- Known bug: the IDE reads only the first `tools/list` page and ignores
  `nextCursor`. Staff confirmed it on 2026-09-15; it is not confirmed fixed.
  Sentry MCP returns `tools/list` as a single unpaginated page (SDK
  `McpServer`, 1.32.2), so the bug does not affect us today. Keep it that way.
- The CLI loaded every tool definition up front, and hit
  `Too many MCP tools are enabled for this model`, until a staff post on
  2026-09-09 said it now loads them lazily like the IDE. The CLI changelog does
  not mention this yet.

### Tier 2 Details

**OpenCode.** Since 2.0.0 (~2026-09-11), every MCP server is in Code Mode by
default. MCP tools leave the native tool list. The model gets one `execute`
tool and calls `search(...)` and `tools.<ns>.<tool>(...)` from JavaScript.

- The prompt catalog is capped at ~2,000 tokens, with descriptions cut to 120
  characters.
- `codemode: false` on a server, or denying `execute`, restores direct tools.
- OpenCode does not use Anthropic `defer_loading`. #45527 was closed as not
  planned.

**Pi.** MCP is built in since 0.99.0 (2026-09-29). Each server has an
`exposure` setting:

- `codemode` (default): tools are reachable only from scripts, through
  `searchTools()`.
- `deferred`: a built-in `tool_search` loads matches for the next call.
- `direct`: tools are declared up front.
- `hidden`: registered but unreachable.

The third-party `pi-mcp-adapter` replaces the built-in support with a single
`mcp` proxy tool.

**VS Code + Copilot Chat.** About 30 core tools stay loaded; MCP and other
tools get `defer_loading`. VS Code runs the search itself with embeddings and
returns the top 5 matches.

- Supported models: Claude newer than 4.5, and GPT-5.4 through GPT-6.
- Other models, such as Gemini and older Claude and GPT models, get every
  schema up front and a hard cap of 128 tools per request. "Virtual tools"
  grouping (`github.copilot.chat.virtualTools.threshold`) is the fallback.
- Subagents do not use tool search.

## Open Questions

- Which `codex-rs` version the current Codex desktop app bundles.
- Whether Claude Desktop connectors (in-process SDK servers) are deferred.
- Whether the Cursor IDE pagination bug is fixed, and whether Cursor offers an
  opt-out.
- How the Claude and Codex agent harnesses inside VS Code handle deferral.

## References

- Direct surface policy: `packages/mcp-core/src/tools/surfaces.ts`
- Server instructions: `packages/mcp-core/src/server-instructions.ts`
- Catalog wrappers: `packages/mcp-core/src/tools/special/`
- Codex: [MCP docs](https://developers.openai.com/codex/mcp),
  [rust-v0.143.0](https://github.com/openai/codex/releases/tag/rust-v0.143.0),
  [Codex harness](https://openai.com/index/unlocking-the-codex-harness),
  `codex-rs/core/src/mcp_tool_exposure.rs`
- Claude Code: [MCP tool search](https://code.claude.com/docs/en/mcp),
  [desktop](https://code.claude.com/docs/en/desktop),
  [changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- Cursor: [dynamic context discovery](https://cursor.com/blog/dynamic-context-discovery),
  [changelog 2.4](https://cursor.com/changelog/2-4),
  [CLI MCP](https://cursor.com/docs/cli/mcp),
  [pagination bug](https://forum.cursor.com/t/171728),
  [CLI lazy loading](https://forum.cursor.com/t/165642)
- OpenCode: [MCP servers](https://opencode.ai/v2/docs/mcp-servers),
  [2.0 notes](https://anoma.ly/notes/opencode-2-0/),
  `packages/core/src/codemode/`
- Pi: `packages/coding-agent/docs/mcp.md` in `earendil-works/pi`
- VS Code: [token efficiency post](https://code.visualstudio.com/blogs/2026/06/17/improving-token-efficiency-in-github-copilot),
  [MCP configuration](https://github.com/microsoft/vscode-docs/blob/main/docs/agents/reference/mcp-configuration.md)
