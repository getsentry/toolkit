---
name: sentry-cli-local
version: 0.48.0-dev.0
description: Sentry for local development
requires:
  bins: ["sentry"]
  auth: true
---

# Local Commands

Sentry for local development

### `sentry local daemon start`

Start the Local control-plane daemon

**Flags:**
- `--foreground - Run in the foreground`
- `--host <value> - Loopback host - (default: "localhost")`
- `--port <value> - Control-plane port - (default: "8969")`

### `sentry local daemon status`

Show Local control-plane status

### `sentry local daemon stop`

Stop the Local control-plane daemon

### `sentry local daemon restart`

Restart the Local control-plane daemon

### `sentry local envelope list <session...>`

List retained envelopes for a Local session

### `sentry local envelope view <session envelope...>`

View a raw Local envelope

### `sentry local event list <session...>`

List decoded events for a Local session

### `sentry local event view <session event...>`

View a decoded Local event

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
- `--max-envelopes <value> - Maximum envelopes retained by this receiver or session`
- `--session <value> - Create a daemon-owned telemetry session with this label`

**Examples:**

```bash
# Start the server and tail events
sentry local

# Use a custom port
sentry local --port 9000

# Only show errors and logs (filter out transactions)
sentry local -f error -f log

# Suppress per-envelope tail output
sentry local --quiet
```

### `sentry local session create <name...>`

Create a Local telemetry session

**Flags:**
- `--clientId <value> - Idempotency key for retried agent session creation`
- `--host <value> - Loopback host - (default: "localhost")`
- `--port <value> - Control-plane port - (default: "8969")`
- `--max-envelopes <value> - Maximum envelopes retained by this receiver or session - (default: "500")`

### `sentry local session retention <session...>`

View or change session envelope retention

**Flags:**
- `--max-envelopes <value> - Maximum envelopes retained by this receiver or session`

### `sentry local session list`

List Local telemetry sessions

### `sentry local session view <session...>`

View a Local telemetry session

### `sentry local session close <session...>`

Close a Local telemetry session

### `sentry local session reset <session...>`

Clear a Local telemetry session

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
- `--max-envelopes <value> - Maximum envelopes retained by this receiver or session`
- `--session <value> - Create a daemon-owned telemetry session with this label`

**Examples:**

```bash
# Run a Node.js dev server with the local server enabled
sentry local run -- npm run dev

# Run a Django dev server with the local server enabled
sentry local run -- python manage.py runserver
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
