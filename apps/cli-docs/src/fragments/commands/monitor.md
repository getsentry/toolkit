
## Monitor types

`sentry monitor` groups Sentry Monitors by type. Metric, cron, and uptime are
monitor types, not alert types. `sentry monitor list` lists every user-facing
monitor type together, with a type column and native JSON. Like Sentry's Monitors
page, it excludes internal issue streams used only for alert project connections.
Choose a type for type-specific operations.

- `sentry monitor list` lists all monitor types, including uptime and other
  monitors without dedicated CLI mutation commands.
- `sentry monitor metric list|view|create|edit|delete` manages metric monitors.
- `sentry monitor cron list` lists cron monitors.
- `sentry monitor cron run` wraps a command with cron check-ins and can create or
  update the cron monitor when passed `--schedule`.

## Detection and notifications

A metric monitor evaluates a query and creates issues. An alert configures
notifications and can connect to one or more monitors. Use `sentry alert list
<org>/` to find alert IDs, then connect an existing alert with `--alert <id>`.
An alert ID is a workflow ID, not a legacy rule ID.

Create a monitor in exactly one project. Use `--critical` with optional
`--warning` and `--resolve` thresholds for static detection.

An empty query selects all events in the selected dataset. `--time-window` is
in minutes; the CLI sends seconds to the API. `--comparison gt` is the default;
use `lt` for thresholds that detect values below the configured threshold.
The resolution threshold defaults to the critical threshold.

## Native configuration

Use `--condition` with native `{type, comparison, conditionResult}` JSON instead
of the threshold shorthand for advanced detection. Do not combine it with
`--critical`, `--warning`, `--resolve`, or `--comparison`.

`--config` accepts native detection settings such as `detectionType` (`static`,
`percent`, or `dynamic`). Percent detection uses `comparisonDelta` in seconds.
Dynamic detection uses an `anomaly_detection` condition. Config edits merge
specified keys with existing settings; other edit fields are sent only when
specified. Renaming a monitor does not rewrite its query or detection mode.

The dataset names select these native signals:

| CLI dataset | Signal |
| --- | --- |
| `errors`, `events` | Error events |
| `spans` | Spans |
| `logs` | Logs |
| `tracemetrics` | Application metrics |
| `sessions`, `metrics` | Session crash rates |

`--enabled true|false` controls the monitor. `--alert` replaces connected alert
IDs; an empty string disconnects all alerts. `--dry-run --json` shows the exact
native request. JSON output retains `dataSources`, `conditionGroup`, `config`,
`workflowIds`, `projectId`, and `enabled` rather than a flattened alert-rule shape.

## Inspect notifications

The detail view includes connected alerts, their conditions, and their actions.
An alert that returns HTTP 403 or 404 appears in `workflowErrors`; its notification
configuration could not be inspected. This is current configuration, not a record
of alert firings or notification delivery.

## Cron monitors

Cron commands live under `sentry monitor cron`: use `list` to inspect cron
monitors and `run` to wrap a command with check-ins. The former `monitor run` is
now `sentry monitor cron run`. `sentry monitor list` is now cross-type; use
`sentry monitor cron list` to retain cron-only listing or
`sentry monitor metric list` for metric-only listing.
