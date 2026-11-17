# MCP tool surface

What a client gets from `initialize` and `tools/list` on the real `sentry mcp`
entry point: every tool the session can call, listed directly, each with
safety hints and a unique title, in one page, with short server
instructions. The goals are in `design/mcp-tools.md`.

## Claims

- `lists-all` A default session lists its tools directly, with no `search_sentry_tools` or `execute_sentry_tool`. Proof: `drive`.
- `hints-set` Every listed tool sets `readOnlyHint`, `destructiveHint`, and `openWorldHint` to a boolean. Proof: `drive`.
- `unique-titles` Every listed tool has a title, and no two share one. Proof: `drive`.
- `one-page` `tools/list` returns every tool with no `nextCursor`. Proof: `drive`.
- `instructions-short` Server instructions are at most 1,500 characters. Proof: `drive`.
- `metadata-lint` Server identity, tool names, hints, titles, description lengths, and `_meta` keys pass the metadata linter in stable and experimental mode. Proof: `test` with `pnpm --filter @sentry/mcp-core exec vitest run src/server.metadata.test.ts`.

## How to get to it

- `sentry mcp` over stdio, from an MCP client's server config.
- `npx @sentry/mcp-server`, which runs the same command.
- Remote HTTP at `https://mcp.sentry.dev/mcp`; this map does not drive it.

## Driving it with mcp-call.mjs

Preconditions:

- Launch and Doctor from `../SKILL.md` pass, and `$VERIFY_RUN` is set.

- **`lists-all`, `hints-set`, `unique-titles`, `one-page`, `instructions-short`: list tools.** Run `node .agents/skills/verify-toolkit/scripts/mcp-call.mjs --server cli --out "$VERIFY_RUN/mcp-tool-surface"`. It prints `connected: Sentry MCP (cli), N tools` with N above 25. Run `node .agents/skills/verify-toolkit/scripts/check-results.mjs surface "$VERIFY_RUN/mcp-tool-surface"`. Every line is `PASS`.
- **`instructions-short`: read them.** `initialize.json` has `instructions` that name only tools present in `tools-list.json`.

## Gotchas

- The offline host is self-hosted from the CLI's view, so the default session leaves out `seer` tools such as `analyze_issue_with_seer`. Pass `--server-arg --all-skills` to list them.
- The mock server's list is not the user's list: it grants every skill in experimental mode. Drive `--server cli` for this file.

## Gaps

- `gateway-cap` The fallback gateway surface lists at most 25 tools. It is a code constant that is off, so no entry point can turn it on.
