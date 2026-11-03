# Proposal

## Why

Sentry's product logic for agents lives in two places. The CLI has about 40
command groups built on `@sentry/api`. The MCP server has 75 hand-written
catalog tools in `mcp-core/src/tools/catalog/`, with their own endpoint
wrappers (`mcp-core/src/api-client/client.ts`, about 5,000 lines), their own
Zod output formatting, and embedded natural-language search agents that need
an OpenAI or Anthropic key. Every capability is built twice, or exists in
only one product.

The earlier plan (`unify-sentry-api-layer`, group 11) kept both surfaces and
moved each MCP tool into the CLI as a portable `sentry/mcp` tool definition.
That still means one hand-written MCP tool per command.

Code Mode removes the second surface. HTTP Code Mode (#1670) already shows
agents completing API tasks the catalog cannot do, such as copying a
dashboard (#1675 evals). If the CLI is the only product surface, the MCP can
be a thin Code Mode layer over it: agents discover commands through the
CLI's own introspection and call them through the CLI SDK.

## What Changes

1. **CLI parity.** Every MCP catalog tool gets a CLI command. New Sentry
   capabilities are added as CLI commands only; no new hand-written MCP
   tools. Commands call the API through `@sentry/api`
   (`unify-sentry-api-layer`).
2. **The MCP is Code Mode over the CLI.** The MCP exposes two tools:
   `search_sentry` to discover commands and API operations, and
   `execute_sentry_code` to run JavaScript that calls them through a
   `sentry` object shaped like `createSentrySDK()`. The agent's code runs in
   a sandbox with no credentials or network; each `sentry.*` call goes to
   the host, which checks permissions and runs the command.
3. **One introspection source.** `sentry mcp` builds the tool surface from
   the CLI's route tree at runtime (`lib/introspect.ts`). The hosted MCP
   lists the same commands from metadata generated from the CLI at build
   time, and runs the portable ones.
4. **Every published API route.** `search_sentry` also searches the API
   schema that backs `sentry schema`, and `execute_sentry_code` exposes
   `sentry.api.request()`, the equivalent of `sentry api`, for operations
   with no command.
5. **Completion for agents.** The shell completion system
   (`lib/complete.ts`, `lib/completion-target.ts`) answers
   `sentry.complete(argv)` inside Code Mode and completion queries in
   `search_sentry`: organization and project slugs, issue IDs, dataset
   fields and aggregates, and search query terms.
6. **The catalog goes away after an eval gate.** Code Mode ships next to the
   catalog. When the MCP eval suite shows it matching the catalog, it
   becomes the default, and the catalog tools, their endpoint wrappers, and
   the embedded search agents are deleted from `mcp-core`.

## Capabilities

### New Capabilities

- `mcp-code-mode`: The MCP's tool surface: discovery, execution, permissions,
  and completion over the CLI's commands and the published API.

### Modified Capabilities

None. The project-management tool contract in
`refine-project-management-tools` is superseded: those operations become CLI
commands.

## Impact

- `packages/cli`: new commands for the parity gaps; agent metadata on
  commands (permission class, portability); a portable `sentry/mcp` entry
  with the Code Mode host and portable operations; portable completers.
- `packages/mcp-core`: keeps MCP plumbing (registration, transports,
  constraints, Code Mode tool definitions). Loses the catalog tools, the
  `SentryApiService` endpoint wrappers they use, the search agents, and the
  agent provider configuration.
- `packages/mcp-cloudflare`: Code Mode from #1670 switches from raw HTTP to
  the CLI's portable operations, with `sentry.api.request()` kept for raw
  calls. OAuth consent maps to command permission classes.
- `packages/mcp-server`: the slim bundle carries portable operations instead
  of catalog tools. Its size budget and module guard change.
- `packages/mcp-server-evals`: Code Mode and catalog runs of the full suite,
  then Code Mode only.
- Docs: mcp.sentry.dev setup, `docs/` architecture pages, and the agent
  skills (#1357 skills audit).
