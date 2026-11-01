

## Check-in lifecycle

`monitor run` sends an `in_progress` check-in when the wrapped command starts,
then an `ok` or `error` check-in (with duration) when it finishes, based on the
exit code. The wrapped command inherits stdio, has `SIGINT`/`SIGTERM`
forwarded, receives the `SENTRY_MONITOR_SLUG` environment variable, and its
exit code is preserved. Check-in delivery failures are non-fatal — the wrapped
command still runs and exits with its own code.
