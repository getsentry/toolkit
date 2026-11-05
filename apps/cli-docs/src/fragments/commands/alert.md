
## Alerts and monitors

Alerts configure notifications triggered by issues or activity on an issue.
Monitors detect problems and create issues; metric, cron, and uptime are monitor
types. Alerts and monitors are separate resources: alert IDs are workflow IDs,
and monitor IDs are detector IDs.

Use `sentry alert list <org>/` to find alerts, including alerts with no connected
monitors. Connect an alert to any monitor with `--monitor <id>` on create or edit.
Use `sentry monitor list <org>/` to find monitors across all types, or
`sentry monitor metric list <org>/` for metric monitors only.

Use `--project <slug>` on alert create or edit to select issues and issue activity
in a project. Like Sentry's alert form, this connects the project's issue stream;
it does not create a monitor or restrict the alert to error events. Project
selection replaces monitor connections, so do not combine it with `--monitor`.

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
`sentry monitor metric list|view|create|edit|delete` for metric monitors. There is
no implicit project/monitor selection or issue-only filtering on lists.

When migrating issue-alert commands, use `--trigger` instead of `--condition`.
Metric-alert `--workflow` becomes `--alert` on `monitor metric`; put the project
in the `<org>/<project>` target instead of `--project`. Use threshold flags
(`--critical`, `--warning`, `--resolve`, `--comparison`) or native `--condition`
JSON instead of the old metric `--trigger` shape.

The immediately preceding CLI already used workflow IDs for `alert issues`
and detector IDs for `alert metrics`; those IDs remain usable in their new
commands. IDs from the older legacy rule APIs are not interchangeable.

Alert lists now target one organization with explicit `--project` filters rather
than aggregating projects across organizations. `--query` uses native server
search rather than a client-side name substring filter. To preserve the former
30-minute notification frequency on creation, pass `--frequency 30` explicitly.
