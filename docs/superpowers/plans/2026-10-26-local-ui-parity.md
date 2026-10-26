# Local UI investigation and replay implementation plan

> For agentic workers: use superpowers:executing-plans. The user approved the comparison's UI scope and explicitly requested implementation in PR #1509. No additional design approval is needed.

**Goal:** Make captured Local telemetry explorable through dedicated inspectors and performance views, with reproducible envelope replay. MCP is excluded.

**Architecture:** Extend the bounded telemetry store, React components, routes and trace model. Derive analysis from captures, preserve JSON and envelope metadata, and share semantic extraction for transaction and standalone spans. Never fetch captured URLs or execute captured HTML/source. Use editor protocol links rather than a server execution endpoint.

**Tech stack:** Existing React 19, TypeScript, Vite, Vitest, Tailwind. No added runtime dependencies.

## Global constraints

- Preserve capture/session lifecycle and receiver compatibility.
- No MCP changes; no merge or deployment.
- Unknown SDK values remain inspectable in JSON. Do not invent measurements or token counts.
- Quality gate: pnpm run tsc && pnpm run lint && pnpm run test before committing. Existing user-authorized unrelated failures remain separate.
- Accessible controls, responsive panes, dark/light themes; captured text stays inert.

## Review focus

- Binary attachment bytes and metadata survive SSE.
- Missing timestamps, empty profiles and legacy payloads degrade honestly.
- Filters/sorting do not mutate incoming data or silently hide selection.
- Analysis covers embedded and standalone spans without duplicate executions.
- Replay uses receiver ingestion, supports custom fixtures, and reports rejection.

### Task 1: Semantic event inspection

- [x] Preserve envelope/item headers and binary encoding; test SDK-shaped envelopes.
- [x] Add breadcrumbs/context/request/tags/modules, frame locals, editor links and Copy for AI.
- [x] Add AI prompts/responses/models/tokens/tools, feedback associations, attachments and SDK inventory.
- [x] Test representative sanitized payloads and unsupported/missing data.

### Task 2: Performance analysis

- [x] Query/resource grouping, sorting and trace/span drill-down.
- [x] Pageload Web Vitals summaries/page charts with metric units/thresholds.
- [x] Legacy profiles and continuous chunks: summaries, flame/treemap/sunburst, thread selection and trace links.
- [x] Cover analysis and interactions with fixtures.

### Task 3: Investigation controls

- [x] Integrate router/sidebar/command navigation.
- [x] Severity/logger filters, sorting and configurable columns.
- [x] Trace search, only-matches, branch collapse and adjustable tree width.
- [x] Integration tests for deep links and empty/filtered states.

### Task 4: Replay and validation

- [x] Local replay command, bundled sanitized scenarios, recursive custom fixtures.
- [x] Endpoint, interval/repeat, compression and deterministic failures.
- [x] Real receiver/viewer tests and documentation.
- [x] Focused tests, full gate, visual QA, fresh review, fixes, commit/push, PR description.

## Execution ledger

- Base d5e5863ee319412c20ea02892b8479d18d127dde; existing worktree clean.
- Ruling: reuse layout/dependencies; vscode:// links avoid arbitrary server-side editor execution.
- Ruling: all requested UI work stays in this PR; Electron and MCP excluded.

- Semantic inspection, performance views, navigation controls and replay are implemented.
- Tests: 306 viewer tests pass; receiver-backed replay exercises all views. Production viewer build passes.
- Full UTC quality gate: root typecheck/lint pass; all workspace suites pass except the two previously user-approved macOS CLI failures (musl installer detection and DerivedData scan timeout). CLI result: 11,400 pass, 2 fail, 37 skipped. No CLI source changed in this addition.
- Final review found five issues; all were fixed with red/green regressions. Scoped re-review is clean.
- Browser QA verified query readability, profile visualization/keyboard controls, AI conversation/tool content and binary image decoding.
- Decisions: reuse existing React/dependencies/layout; use explicit VS Code protocol links for absolute local source paths; retain original envelope JSON; exclude MCP/Electron as requested.
