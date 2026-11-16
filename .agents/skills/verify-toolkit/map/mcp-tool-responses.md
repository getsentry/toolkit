# MCP tool responses

What a `tools/call` result gives an agent: structured content that is the
answer, markdown for tools without an output schema, follow-up calls the
session can make, side quests that name a fix, and tool errors that are not
dressed up as success. The goals are in `design/mcp-tool-responses.md`.

## Claims

- `structured-text-match` A tool with an output schema returns structured content, and its text is that payload as compact JSON. Proof: `drive`.
- `schema-valid` Every structured result matches the tool's advertised output schema. Proof: `drive` (the MCP client rejects a mismatch).
- `suggested-actions-callable` Suggested actions are at most three, each a complete `tool_call` with arguments, naming a tool in this session's `tools/list`. Proof: `drive`.
- `side-quest-fix` Each side quest has a tip that names the fix and an https docs link. Proof: `drive`.
- `markdown-only` A tool with no output schema returns markdown with a `#` title and no structured content. Proof: `drive`.
- `no-placeholders` Markdown results contain no `undefined`, `[object Object]`, or `NaN`. Proof: `drive`.
- `tool-error` A call with missing input returns `isError` with an input error message and no structured content. Proof: `drive`.
- `schema-guard` Every handler result in the mcp-core suite matches its output schema. Proof: `test` with `pnpm --filter @sentry/mcp-core exec vitest run src/server.metadata.test.ts -t "validates handler results against outputSchema in every test"`.

## How to get to it

- `tools/call` from any MCP client over stdio, here through `mcp-call.mjs` against the mock server.
- The same result reaches remote HTTP clients; this map does not drive that transport.

## Driving it with mcp-call.mjs

Preconditions:

- Launch and Doctor from `../SKILL.md` pass, and `$VERIFY_RUN` is set.
- The mock server's fixtures include org `sentry-mcp-evals`, issue `CLOUDFLARE-MCP-41`, and trace `a4d1aae7216b47ff8117cf4e09ce9d0a`.

- **`structured-text-match`, `schema-valid`, `suggested-actions-callable`, `side-quest-fix`, `markdown-only`, `no-placeholders`, `tool-error`: call four tools.** Run:

  ```bash
  node .agents/skills/verify-toolkit/scripts/mcp-call.mjs --out "$VERIFY_RUN/mcp-tool-responses" \
    --call get_issue_details '{"organizationSlug":"sentry-mcp-evals","issueId":"CLOUDFLARE-MCP-41"}' \
    --call find_projects '{"organizationSlug":"sentry-mcp-evals"}' \
    --call get_trace_details '{"organizationSlug":"sentry-mcp-evals","traceId":"a4d1aae7216b47ff8117cf4e09ce9d0a"}' \
    --call get_issue_details '{}'
  ```

  It exits 0 (so the SDK accepted both structured results against their schemas, `schema-valid`) and prints `ok, structuredContent` for calls 1 and 2, `ok, content only` for call 3, and `isError, content only` for call 4.

- **Same claims: check the evidence.** Run `node .agents/skills/verify-toolkit/scripts/check-results.mjs responses "$VERIFY_RUN/mcp-tool-responses"`. Every line is `PASS`: `structured-text-match` and `suggested-actions-callable` for calls 1 and 2, `side-quest-fix` for call 1, `markdown-only` and `no-placeholders` for call 3, and `tool-error` for call 4.
- **`tool-error`: read the message.** `call-4-get_issue_details.json` has `"isError": true`, and its text starts with `**Input Error**` and names `issueId` or `issueUrl`.

## Gotchas

- The mock server grants every skill and runs in experimental mode, so its `tools/list` is not what a user's session lists. Use `mcp-tool-surface.md` and `mcp-access.md` for that.
- A fixture the mock server lacks becomes an HTTP 500 tool error whose text includes the mock's own stack trace. That is a fixture gap, not a product result: use the fixture IDs above.
- `find_projects` ignores its `query` against the mock; do not use it to prove filtering.
- `check-results.mjs` appends to `checks.txt`. Use a fresh `--out` per run.

## Gaps

- `untrusted-contained` Upstream text cannot add headings, list items, or links to a markdown result. No mock fixture carries markdown in an upstream value.
- `feedback-only-for-bugs` A feedback suggestion appears only for likely Sentry MCP bugs. The mock server registers no feedback tool, because it has no DSN, so no result can carry the suggestion.
- `optional-detail-fails` A failed optional detail, such as a suspect commit, does not stop the main result. No fixture makes only the optional request fail.
