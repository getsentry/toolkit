

## Log IDs

Copy the full ID from the `ID` column in `sentry log list` or `sentry trace logs`
into `sentry log view`. An abbreviated prefix can match multiple logs and cannot
be expanded into a unique full ID by itself.

Log IDs can be found:

1. In the output of `sentry log list` (the ID column)
2. In the Sentry UI when viewing log entries
3. In the `sentry.item_id` field of JSON output

Log ID lookups automatically narrow the search when a usable timestamp can be
determined from each ID. Otherwise, they use a 90-day lookup window. If a partial
scan leaves IDs missing, the CLI retries those IDs once with the highest
available scan accuracy.

## JSON Output

Use `--json` for machine-readable output:

```bash
sentry log list --json | jq '.data[] | select(.severity == "error")'
```

In streaming mode with `--json`, each log entry is output as a separate JSON object (newline-delimited JSON), making it suitable for piping to other tools.
