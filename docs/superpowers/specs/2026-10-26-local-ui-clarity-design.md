# Local UI clarity

The user approved all ten UI proposals and asked to include them in PR #1509.

## Intent

Make capture identity, lifecycle, action consequences, and inspection useful and understandable. Preserve the compact developer-tool layout and React/Radix stack.

## Approved behavior

1. A unified context header shows session/project, Capturing or Saved capture, receiver connectivity, and latest event time. Running becomes Capturing; Retained becomes Saved; Live Activity becomes Events.
2. Clear view affects this tab only. Delete captured events is a separate confirmed receiver mutation, available only under existing permissions. Stop capture retains history but rejects future ingestion. Disconnect viewer leaves capture intact. Desktop/mobile actions share explicit names and focus behavior.
3. Empty screens distinguish active, saved, unavailable, and filtered-empty states and provide the relevant next action.
4. First run leads with a copyable local-run command; connecting an existing receiver is secondary. Switch receiver preserves the current feed until its replacement succeeds.
5. Logs show message/attributes; exceptions show causes/frames; requests have compact summaries/related telemetry; raw-only items open in JSON.
6. Keyboard-selectable waterfall spans open their own timing, attributes, and raw payload with trace context and related errors/logs. Drill down within the inspector pane, avoiding another permanently narrow column.
7. Desktop event/trace list widths resize by pointer/keyboard within safe bounds; mobile stays stacked. Reserve monospace for code/IDs, allow descriptions to wrap, and reduce redundant boxed metadata.
8. Common debugging views stay prominent; secondary inspection is a collapsible Diagnostics group. Sessions & SDKs becomes SDK reports. Preserve /live and /sdks URLs.
9. Appearance is app-wide. History capacity names the capture and explains SDK-envelope units. Show Saved until separately when optional expiry metadata exists.
10. Label session-wide search, preserve Cmd/Ctrl+K, expose view-filter scope and active filters, and provide Clear filter.

## Constraints

- No new dependencies, deployment, or PR merge.
- Keep capability, origin, authority, stale-callback, replay, and finite-retention protections.
- Add optional expiresAt epoch-millisecond metadata; never invent or extend deadlines. Older receivers remain supported.
- Receiver/session changes clear stale filter/inspector context.
- Connected transport does not mean the application process is running.
- Raw span payloads and independent span error styling remain accurate.

## Approaches

Update the existing workspace and interactions. Cosmetic-only changes leave ambiguous state/action semantics intact. Replacing the UI framework adds migration risk without helping these flows. The user approved the ten proposals; the engineering choices above make them concrete within the existing architecture.

## Verification

Use failing-then-passing regression tests, full viewer/Local CLI tests, root typecheck/lint/tests, real process E2E, desktop/mobile visual checks, and independent final review. The earlier user-approved exception remains limited to the unrelated macOS musl-installer and DerivedData failures.
