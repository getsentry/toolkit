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
moved each MCP tool into the CLI as a portable tool definition. That still
means one hand-written MCP tool per command.

If the CLI is the only product surface, the MCP can be a thin layer that
exposes the CLI's commands as tools, found through the CLI's own
introspection and run through the CLI SDK.

## What Changes

1. **CLI parity.** Every MCP catalog tool gets a CLI command. New Sentry
   capabilities are added as CLI commands only; no new hand-written MCP
   tools. Commands call the API through `@sentry/api`
   (`unify-sentry-api-layer`).
2. **The MCP exposes the CLI's commands.** By default it lists three tools:
   `search_sentry` finds commands, and `execute_sentry_read` and
   `execute_sentry_write` run one command by name with JSON parameters
   through `createSentrySDK()`. Execute is split by permission class so MCP
   hosts can allowlist reads and ask before writes (#1254). No
   sandbox is involved: the agent can only run commands that exist, with
   parameters their schema accepts. Harnesses that search large tool lists
   themselves can instead list every command as its own tool.
3. **One introspection source.** Tool names, descriptions, and input schemas
   come from the CLI's route tree (`lib/introspect.ts`) on stdio and from
   metadata generated from it at build time on hosted.
4. **Every published API route.** `sentry api` and `sentry schema` are
   commands like any other, so search and execute
   reach every published `@sentry/api` operation with no extra tool.
5. **Completion for agents.** The shell completion system
   (`lib/complete.ts`, `lib/completion-target.ts`) answers completion
   queries in `search_sentry` and suggests values when a parameter fails
   validation: organization and project slugs, issue IDs, dataset fields
   and aggregates, and search query terms.
6. **The CLI SDK runs on the hosted MCP.** Hosted creates one SDK instance
   per request with the OAuth grant's token and runs it with persistence
   off: no SQLite, no config directory, no caches. Module-level state on
   the exposed commands' import graph becomes per-request. The hosted MCP
   then runs commands through the same SDK as `sentry mcp`.
7. **The catalog goes away after an eval gate.** The command surface ships
   next to the catalog. When the MCP eval suite shows it matching the
   catalog, it becomes the default, and the catalog tools, their endpoint
   wrappers, and the embedded search agents are deleted from `mcp-core`.

HTTP Code Mode (#1670), where the agent writes JavaScript that a sandbox
runs, is not part of this plan's critical path. It can be added later as a
third tool over the same SDK, for multi-step work that benefits from code.

## Capabilities

### New Capabilities

- `mcp-command-surface`: The MCP's tool surface: discovery, execution,
  permissions, and completion over the CLI's commands.

### Modified Capabilities

None. The project-management tool contract in
`refine-project-management-tools` is superseded: those operations become CLI
commands.

## Impact

- `packages/cli`: new commands for the parity gaps; agent metadata on
  commands (permission class, hosted availability); a no-persistence
  mode; per-request SDK state; a Workers build of the SDK.
- `packages/mcp-core`: keeps MCP plumbing (registration, transports,
  constraints, the two tool definitions). Loses the catalog tools, the
  `SentryApiService` endpoint wrappers they use, the search agents, and the
  agent provider configuration.
- `packages/mcp-cloudflare`: runs commands through the CLI SDK, one
  instance per request, with persistence off. OAuth consent maps to command permission classes.
- `packages/mcp-server`: the slim bundle needs the command handlers it
  exposes; its module guard and size budget change.
- `packages/mcp-server-evals`: command-surface and catalog runs of the full
  suite, then the command surface only.
- Docs: mcp.sentry.dev setup, `docs/` architecture pages, and the agent
  skills (#1357 skills audit).
