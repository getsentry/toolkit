---
name: mcp-qa
description: QA MCP tool changes with local CLI and real agent clients. Use when explicitly invoked via /mcp-qa or when asked to QA MCP tool changes end-to-end.
---

Verify MCP tool behavior end-to-end before committing or creating a PR. Prefer
agent-callable paths over browser or inspector workflows.

## 1. Quality Gate

```bash
pnpm run tsc && pnpm run lint && pnpm run test
```

Fix any failures before proceeding.

## 2. Stdio CLI

This is the primary QA path for tool behavior. Stdio runs the local MCP server
against prod Sentry without depending on the Cloudflare worker, local `/mcp`
route, or Cloudflare OAuth configuration.
When validating code or tool changes, build first because the test client
launches `packages/mcp-server/dist/index.js`:

```bash
pnpm -w run build
```

Check auth first:

```bash
pnpm --filter @sentry/mcp-server start auth status
```

If no cache exists, warm the device-code cache:

```bash
pnpm --filter @sentry/mcp-server start auth login
```

Device-code auth uses the bundled stdio public client ID, requires no client
secret, is separate from the Cloudflare OAuth app, and caches the token in
`~/.sentry/mcp.json`.

First prove startup and auth:

```bash
pnpm -w run cli --transport stdio --list-tools
pnpm -w run cli --transport stdio "who am I?"
```

Then prove the changed behavior with a realistic prod prompt. Choose a prompt
that requires the new or modified tool path, uses real org/project/resource
inputs, and asks for enough detail to prove the endpoint response is usable.

```bash
pnpm -w run cli --transport stdio \
  "<prompt that exercises the changed MCP behavior against prod data>"
```

Passing QA means the local CLI prints `Connected to MCP server (stdio)`, uses
the expected MCP tool path, and returns real prod data that demonstrates the
behavior. For catalog tools, expect `search_sentry_tools` followed by
`execute_sentry_tool(name: <changed_tool>)`. For direct tools, expect the tool name in
the transcript. `--list-tools` alone is not QA.

For mutating catalog-only tools, avoid live prod changes unless there is a
disposable resource prepared for the test. Add or run a server-level
`execute_sentry_tool` dispatch test with MSW coverage to prove catalog
discovery, generated schema exposure, constraint injection, and tool dispatch
without changing real Sentry data.

For output-format changes, also inspect the raw MCP tool result when possible,
not only the LLM's final answer. The final answer can add model-specific text
that is not part of the tool response. Review raw tool output against
`docs/contributing/tool-responses.md`: it should be user-facing, structured,
and free of raw API JSON, internal implementation IDs, empty placeholders, and
unrelated instructions.

## 3. Real Agent Clients

Use these when validating Claude Code, Codex, or behavior that only reproduces
in a real agent client:

```bash
pnpm -w run build
```

What this verifies:

- The CLI is installed and can see the named MCP server
- The provider can run a connectivity prompt against Sentry MCP
- The final answer includes the authenticated email from `whoami`

For agent-client-specific behavior, replace the default harness prompt with the
same realistic prod prompt used for stdio QA. Passing QA requires the same
changed-tool transcript evidence, not only `whoami`.

as an isolated auth cache. Real clients do not give stdio subprocesses a TTY,
so warm the cache before running the harness. It also runs the built
`packages/mcp-server/dist/index.js`, so build first to avoid stale code.

## 4. Cloudflare HTTP Only When Relevant

Run this only when changes touch Cloudflare, HTTP transport, `/mcp`
routing, OAuth, web UI, or hosted-server compatibility. It is not required for
ordinary tool handler changes.

Start the dev server in a separate terminal or background process:

```bash
pnpm dev
```

Then verify it is reachable:

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/
```

If `pnpm dev` fails because local Cloudflare/Wrangler is not configured, note
the failure and continue with stdio QA for tool behavior.

```bash
pnpm -w run cli "who am I?"
pnpm -w run cli "list all available tools"
pnpm -w run cli "<same realistic prod prompt used for stdio QA>"
pnpm -w run cli --mcp-host=http://localhost:5173/mcp/<org> \
  "<same realistic prod prompt used for stdio QA>"
pnpm -w run cli --mcp-host=http://localhost:5173/mcp/<org>/<project> \
  "<same realistic prod prompt used for stdio QA>"
```

Look for `Connected to MCP server (<resolved MCP URL>)` to confirm HTTP
transport, plus the same changed-tool transcript evidence required for stdio
QA. Use scoped `/mcp/<org>` or `/mcp/<org>/<project>` URLs when validating
routing, OAuth, or resource-scope behavior. Use `--setup repo --server sentry`
to test the hosted server instead.

## 5. Source Build Stdio Only When Relevant

Use this when specifically checking the built local stdio server rather than
dev-time source execution:

```bash
pnpm -w run build
pnpm --filter @sentry/mcp-server start auth status
pnpm -w run cli --transport stdio "who am I?"
```

Look for `Connected to MCP server (stdio)` to confirm stdio transport.
