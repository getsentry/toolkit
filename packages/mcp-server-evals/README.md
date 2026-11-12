# @sentry/mcp-server-evals

Evaluation helpers and a local mock stdio runner used when developing and validating the Sentry MCP server.

## Mock stdio runner

- Command: `pnpm --filter @sentry/mcp-server-evals start`
- Entry: `src/bin/start-mock-stdio.ts`
- Purpose: Boots the MCP server in-process with MSW mocks enabled for deterministic evals.

### Scopes policy

The mock stdio script grants only the high-level admin scopes that imply all lower permissions via the hierarchy defined in `packages/mcp-core/src/permissions.ts`:

- `org:admin`, `project:admin`, `team:admin`, `member:admin`, `event:admin`
- Plus special non-hierarchical scope: `project:releases`

This keeps permissions minimal and readable while still enabling every tool in eval runs. Avoid enumerating every read/write scope explicitly — rely on the hierarchy to expand implied permissions.

### Notes

- No API keys are logged; MSW handles Sentry API mocking.
- For code changes, ensure `pnpm run tsc && pnpm run lint && pnpm run test` all pass.
- See `docs/contributing/adding-tools.md` and `docs/testing/overview.md` for contribution guidance.
