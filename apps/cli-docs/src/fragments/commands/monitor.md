

## Examples

```bash
# Wrap a command with cron monitor check-ins (DSN-based)
SENTRY_DSN=https://examplePublicKey@o0.ingest.sentry.io/0 \
  sentry monitor run nightly-job -- python manage.py cron

# The -- separator is optional when the command has no flags
sentry monitor run nightly-job npm run task

# Create/update the monitor on the first check-in via --schedule (crontab)
sentry monitor run nightly-job -s "0 0 * * *" --max-runtime 30 --timezone UTC -- ./backup.sh

# List cron monitors in an org
sentry monitor list my-org/

# Paginate through monitors
sentry monitor list my-org/ -c next

# Output as JSON
sentry monitor list --json
```

## Check-in lifecycle

`monitor run` sends an `in_progress` check-in when the wrapped command starts,
then an `ok` or `error` check-in (with duration) when it finishes, based on the
exit code. The wrapped command inherits stdio, has `SIGINT`/`SIGTERM`
forwarded, receives the `SENTRY_MONITOR_SLUG` environment variable, and its
exit code is preserved. Check-in delivery failures are non-fatal — the wrapped
command still runs and exits with its own code.
