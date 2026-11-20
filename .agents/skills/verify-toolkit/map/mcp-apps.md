# MCP Apps chart view

What an MCP Apps host (Claude, VS Code, ChatGPT) gets for `render_sentry_chart`:
the tool names a `ui://` view in `tools/list`, the view reads back as one
self-contained HTML document, and the view renders the tool result, follows
the host theme, and calls the tool again through the host. The goals are in
`design/mcp-apps.md`.

## Claims

- `tool-meta` `render_sentry_chart` sets `_meta.ui.resourceUri` to a `ui://` URI and `_meta["openai/outputTemplate"]` to the same URI, with no deprecated flat `ui/resourceUri` key. Proof: `drive`.
- `view-resource` `resources/list` lists that URI, and `resources/read` returns it with mime type `text/html;profile=mcp-app` and an HTML document. Proof: `drive`.
- `view-listing` A session that cannot call `render_sentry_chart`, including every stable (non-experimental) session, lists no resources and no resources capability. Proof: `test` with `pnpm --filter @sentry/mcp-core exec vitest run src/server.ui-resources.test.ts`.
- `view-renders` Mounted through the ext-apps AppBridge, which also checks the view's hand-written MCP Apps bridge against the reference host, the view draws the series, shows a tooltip on hover, and hides its empty state. Proof: `drive`.
- `view-theme` The view follows the host's light or dark theme. Proof: `drive`.
- `range-roundtrip` The range picker calls `render_sentry_chart` through the host with the new period and redraws without remounting. Proof: `drive`.
- `open-link` "Open in Sentry" asks the host to open the result's Sentry URL with `ui/open-link`. Proof: `drive`.
- `grouped` A `groupBy` result draws one series per top group, with a legend. Proof: `drive`.
- `lifecycle` The view follows a `host-context-changed` theme change, shows a cancelled state on `ui/notifications/tool-cancelled`, and answers `ui/resource-teardown`. Proof: `drive`.
- `default-csp` The view loads and runs under the spec's default CSP with no console errors, so it needs no `csp` domains. Proof: `drive`.

## How to get to it

- An MCP Apps host that lists `render_sentry_chart` and reads its `ui://` resource, over stdio (`sentry mcp --experimental`, `npx @sentry/mcp-server --experimental`) or remote HTTP in experimental mode. Stable sessions list neither the tool nor the view.
- A host with no MCP Apps support gets the same tool with a text and structured result only.

## Driving it with mcp-apps-host.mjs

Preconditions:

- Launch from `../SKILL.md` has run on this checkout, and `$VERIFY_RUN` is set.
- A Chromium build for playwright-core is installed. If the script cannot launch it, run `pnpm --filter @sentry/mcp-core exec playwright-core install chromium-headless-shell`.

- **Every `drive` claim: act as the host.** Run `node .agents/skills/verify-toolkit/scripts/mcp-apps-host.mjs --out "$VERIFY_RUN/mcp-apps"`. It starts the mock server, calls the tool, reads the view, and mounts it in headless Chromium inside a host page that uses `AppBridge`. Every line it prints, also in `checks.txt`, is `PASS`. The screenshots `chart-light.png`, `chart-dark.png`, `chart-range-7d.png`, and `chart-grouped-dark.png` show each state. `host-log.json` holds the view's `tools/call` and `ui/open-link` requests to the host.

## Gotchas

- The mock server answers from built packages. Rerun `pnpm run build` after changing mcp-core or the mocks, or the script drives stale code.
- The view is generated. After changing `packages/mcp-core/chart-app/`, run `pnpm --filter @sentry/mcp-core generate-chart-app`, then build.
- The host page sets the default CSP with a meta tag in `srcdoc`. Real hosts serve the view from a sandbox origin with CSP headers.

## Gaps

- `real-hosts` Rendering in Claude, VS Code, ChatGPT, and Codex desktop needs those apps with a live server; this map drives only the reference AppBridge. Use `mcp-qa` for real hosts.
