

## Metric alert triggers

Triggers take `alertThreshold`, an optional `label` (`critical` or `warning`),
`resolveThreshold`, and `thresholdType` (`0` above, `1` below). Notification
actions are not part of triggers; pass `--workflow` with the ID of an existing
alert to notify.
