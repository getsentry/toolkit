# Local UI Clarity Implementation Plan

> **For agentic workers:** Use scoped ownership/interfaces below, TDD, and independent final review. The primary agent integrates and publishes.

**Goal:** Include all ten approved improvements in PR #1509.
**Architecture:** Extend optional lifecycle metadata and focused React/Radix components while preserving the receiver/session state machine.
**Tech Stack:** TypeScript, React, Radix, Tailwind, Vitest, Hono.
**Spec:** [Local UI clarity](../specs/2026-10-26-local-ui-clarity-design.md)

## Global Constraints

- No new dependencies, deployment, or PR merge.
- Preserve routes, older receivers, security boundaries, stale-callback isolation, raw data, and finite replay.
- Run the root quality gate before committing; only the three explicitly approved baseline failures may remain.

## Review Focus

- Receiver switches during dialogs/requests must not apply stale state.
- Hosted/remote viewers must not gain reset/close privileges.
- Missing/invalid/expired metadata must not invent a deadline.
- Duplicate span IDs, keyboard use, mobile, and browser history must preserve inspector context.
- Clear view and filtered/saved-empty states must not imply receiver data was deleted.

### Task 1: Lifecycle metadata

**Files:** CLI viewer-protocol/session-store/control-plane and tests; viewer session-directory/parser tests.
**Interfaces:** LocalSessionEvent and ViewerSession add optional expiresAt?: number in epoch milliseconds. Directory and retained lifecycle/replay/reset metadata carry the existing frozen deadline.

- [x] Write/run failing propagation and parser compatibility tests.
- [x] Implement optional metadata without changing capabilities or expiry.
- [x] Verify focused CLI/parser suites, types, and lint.

### Task 2: Connections, actions, and settings

**Files:** connection-landing, receiver-dialog, receiver-controls, local-settings, retention-settings, session-switcher and tests.
**Interfaces:** SessionSwitcher adds onCurrentSessionChange?: (session: ViewerSession | undefined) => void and showState?: boolean. ReceiverControls preserves callbacks and adds onDeleteCapturedEvents?: (trigger: HTMLButtonElement) => void. LocalSettings adds captureLabel?: string and expiresAt?: number.

- [x] Write/run failing tests for names, onboarding, scope, permissions, and focus.
- [x] Implement Capturing/Saved, Switch receiver, Clear view, Stop capture, Disconnect viewer, and a confirmed-deletion trigger.
- [x] Preserve probing/history; distinguish global appearance, capture capacity, and expiry.
- [x] Verify focused suites, types, and lint.

### Task 3: Inspectors and layout

**Files:** new event-detail, span-detail, resizable-workspace components/tests; trace-model, trace-waterfall, trace-workspace and tests.
**Interfaces:** EventDetail({item, trace?, onSelectSpan?, onSelectRelatedItem?}). TraceSpan retains its own payload. TraceWaterfall adds selectedSpanId? and onSelectSpan?: (spanId: string) => void. TraceWorkspace adds selectedSpanId?, onSelectSpan?: (traceId: string, spanId: string) => void, onClearSpan?: () => void, onSelectRelatedItem?: (item: LocalFeedItem) => void. ResizableWorkspace({list, children, storageKey, listLabel, initialWidth?}).

- [x] Write/run failing inspector, payload, keyboard, and resize tests.
- [x] Extract EventDetail from App without editing App; parent removes old implementation.
- [x] Add useful type-specific detail and span drill-down with trace context/related telemetry.
- [x] Add bounded accessible desktop split panes and mobile stacking.
- [x] Verify focused suites, types, and lint.

### Task 4: Workspace integration

**Files:** App, presentation, workspace navigation/query, command dialog, app tests.
**Interfaces:** Query state adds span, selectSpan(traceId, spanId), clearSpan(). Existing routes stay valid.

- [x] Write/run failing tests for clear/delete scope, lifecycle empties, filters, span navigation, and switching isolation.
- [x] Integrate context header, action confirmations, purposeful inspectors and resize.
- [x] Integrate diagnostics, labelled search, clear-filter controls, and mobile parity.
- [x] Update existing label expectations and verify the complete viewer suite.

### Task 5: Review/publication

- [x] Update Local docs and take desktop/mobile screenshots.
- [x] Run full viewer/Local CLI/root quality gates and real process E2E.
- [x] Independent review; reproduce/fix actionable findings.
- [x] Commit/push to codex/local-session-switcher; refresh PR description/screenshots.
- [ ] Verify final-head CI/feedback and report any external advisory failure accurately.

## Verification results

- Root typecheck and lint pass.
- Known approved local gate exceptions: macOS musl installer detection,
  DerivedData additive scan timeout, and the unrelated issue-link response-cache
  race under coverage. The cache race also reproduces on the pre-UI commit;
  it remains separate from this PR at the user's request.
- Latest viewer suite: 278 tests pass.
- Real Local CLI process E2E: 27 passed.
- Viewer regressions cover lifecycle deadlines, confirmed deletion, hosted
  permissions, filters, span URL/history, resizing, and repeated parent refreshes.
- Visual QA used isolated synthetic captures at desktop and 390×844 mobile sizes;
  inspected request/log/span views, waterfall, scoped settings, and delete/cancel.
- Review fixes: stale cleared-view guidance, connection-link URL restoration,
  duplicate request-summary sibling keys, and accessible summary values.
- Final automated-review fixes preserve the tab's remote receiver on reload,
  prevent reload during a pending deletion, retain filters during span drill-down,
  and avoid stale selected-span styling on fallback traces.
