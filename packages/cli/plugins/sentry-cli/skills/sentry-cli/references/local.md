---
name: sentry-cli-local
version: 0.47.0-dev.0
description: Sentry for local development
requires:
  bins: ["sentry"]
  auth: true
---

# Local Commands

Sentry for local development

### `sentry local serve`

Start the local dev server and tail events

**Flags:**
- `-p, --port <value> - Port to listen on (default 8969) - (default: "8969")`
- `-H, --host <value> - Hostname to bind to (default localhost) - (default: "localhost")`
- `-q, --quiet - Suppress per-envelope tail output`
- `-f, --filter <value>... - Only show items of this type (repeatable: error, transaction, log, ai)`
- `-F, --format <value> - Output format: human (default) or json (NDJSON on stdout) - (default: "human")`
- `-a, --attributes - Show a grouped attribute table (user vs SDK) under each transaction`
- `--open - Open Sentry Local UI in the browser`

### `sentry local run <command...>`

Run a command with the local dev server enabled

**Flags:**
- `-p, --port <value> - Port for the local server (default 8969) - (default: "8969")`
- `--host <value> - Hostname for the local server (default localhost) - (default: "localhost")`
- `-f, --filter <value>... - Only show items of this type (repeatable: error, transaction, log, ai)`
- `-V, --verify - Verify SDK sends events, then exit`
- `-t, --timeout <value> - Kill the child after N seconds (0 = no timeout; defaults to 30 s in --verify mode) - (default: "0")`
- `-F, --format <value> - Output format: human (default) or json (NDJSON on stdout) - (default: "human")`
- `-a, --attributes - Include selected event attributes in output`
- `--open - Open Sentry Local UI in the browser`

**Examples:**

```bash
# Start the server and tail events (default)
sentry local

# Run your app with the local server auto-enabled
sentry local run -- npm run dev
sentry local run -- python manage.py runserver

# Use a custom port
sentry local --port 9000

# Only show errors and logs (filter out transactions)
sentry local -f error -f log

# Run quietly (suppress per-envelope tail output)
sentry local --quiet

# Start the server and open the UI
sentry local --open

# Run your app with the UI
sentry local run --open -- npm run dev

sentry local -f error -f log    # only errors and logs

sentry local -f ai          # only AI/agent spans
sentry local -f ai -f error # agent spans and errors

sentry local --format json

sentry local run --format json \
  --filter error --filter transaction --filter log --filter ai \
  -- npm run dev

sentry local serve --format json --attributes

SENTRY_SPOTLIGHT=http://localhost:8969/stream \
  pnpm --filter sentry exec tsx test/fixtures/local-agent-server.ts

curl http://127.0.0.1:3030/api/users/42
curl -X POST http://127.0.0.1:3030/api/agent/run \
  -H 'content-type: application/json' \
  -d '{"prompt":"Where is the rate limit configured?"}'
curl -i http://127.0.0.1:3030/api/broken
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
