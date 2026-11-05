
## Alerts and monitors

An alert configures notifications. A monitor detects a problem and creates an
issue. They are separate resources: alert IDs are workflow IDs, and monitor IDs
are detector IDs. Legacy rule IDs are not interchangeable with either.

Use `sentry alert list <org>/` to find alerts, including alerts with no connected
monitors. Connect an alert to any monitor with `--monitor <id>` on create or edit.
Use `sentry monitor list <org>/` to find metric monitors.

## Native configuration

- `--enabled true|false` controls the alert's native `enabled` field.
- `--frequency` sets `config.frequency` in minutes; zero disables throttling.
- `--trigger` accepts trigger names, native conditions, or one complete trigger
  group. `--action` and `--filter` configure the first action-filter group.
- `--action-filter` accepts complete native groups and replaces all groups.
- `--config` replaces the alert's configuration object. Use `--frequency` to
  change only the frequency without dropping other settings.
- `--monitor` replaces monitor connections. Pass an empty string to disconnect
  all monitors.

Unspecified edit fields remain unchanged, including the enabled state and other
action-filter groups. `--dry-run --json` shows the exact native request body.

## Command migration

The previous `alert issues` and `alert metrics` groups are removed. Use
`sentry alert list|view|create|edit|delete` for notification alerts and
`sentry monitor list|view|create|edit|delete` for metric monitors. There is no
automatic error-monitor selection or issue-only filtering.
