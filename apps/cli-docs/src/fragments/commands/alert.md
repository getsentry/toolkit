

## Metric alert triggers

Triggers take `alertThreshold`, an optional `label` (`critical` or `warning`),
`resolveThreshold`, and `thresholdType` (`0` above, `1` below). Notification
actions are not part of triggers; pass `--workflow` with the ID of an existing
alert to notify.

## Inspect metric alert notifications

The detail view includes detection settings, threshold conditions, and linked
notification workflows with their filters, destinations, and enabled states.
Use `--json` to inspect native `config`, `conditionGroup`, `workflowIds`, and
complete `workflows` documents. Linked workflows that return 403 or 404 appear
in `workflowErrors`; their notifications could not be inspected. This is the
current configuration, not a record of alert firings or notification delivery.
