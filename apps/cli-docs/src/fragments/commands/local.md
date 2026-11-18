

`sentry local` runs a local development server that captures Sentry SDK envelopes from your dev stack and surfaces errors, traces, and logs in real time — right in your terminal. No authentication required.

Most apps don't need a DSN either. If your app has no DSN configured, events flow **only** to the local server — nothing reaches your Sentry organization and no production quota is used. If a DSN *is* set, the SDK sends to both Sentry and the local server. A few features need a DSN to work; see [SDK setup](#sdk-setup).

If a server is already running on the port, the command attaches as an SSE consumer instead of starting a duplicate.

## `sentry local run`

Runs a command with `SENTRY_SPOTLIGHT` set to the local server's URL. Node.js and Python SDKs read it and send envelopes to the local server with no code changes. Other runtimes need a line of setup; see [SDK setup](#sdk-setup).

If nothing is listening on the port, a server is started in the background and shut down when your command exits. If something already is — the Spotlight desktop app's own sidecar, or a `sentry local serve` in another terminal — the command attaches to it as an SSE consumer, so events still tail to your terminal either way.

With no command, `local run` picks one from the project, in this order:

1. `package.json` scripts: `dev`, `develop`, `serve`, then `start`
2. `manage.py`: `python manage.py runserver` (Django)
3. `app.py`, then `main.py`: a top-level `app = FastAPI(...)` runs with `python -m uvicorn <module>:app --reload`, and a top-level `app = Flask(...)` with `python -m flask --app <module>:app run`, using the variable the app is assigned to. A top-level `app` or `application` built another way, such as `app = create_app()`, uses the framework that `pyproject.toml` or `requirements.txt` declares. A file with an `if __name__ == "__main__":` block, or with no app, runs as `python <file>`
4. `wsgi.py`: a Flask app runs with `python -m flask --app wsgi:app run`, and a file with an `if __name__ == "__main__":` block as `python wsgi.py`
5. `FLASK_APP` set, in a directory with `app.py`, `main.py`, `wsgi.py`, `pyproject.toml`, or `requirements.txt`: `python -m flask run`
6. `go.mod`: `go run .`
7. `docker-compose.yml` or `compose.yml`: `docker compose up`

Python commands use the project's virtualenv even when it is not activated: `VIRTUAL_ENV`, then `.venv/`, then `venv/`. Without one, they use `python`, or `python3` when only that is on your `PATH`. The `flask --app` option needs Flask 2.2 or later; with an older Flask, pass the command after `--`. Pass a command after `--` to skip detection.

Env vars injected into the child process:

| Variable | Value |
|----------|-------|
| `SENTRY_SPOTLIGHT` | `http://localhost:<port>/stream` |
| `<PREFIX>SENTRY_SPOTLIGHT` | `http://localhost:<port>/stream` |
| `SENTRY_TRACES_SAMPLE_RATE` | `1` (unless already set) |
| `SENTRY_RELEASE` | `sentry-cli-local` (unless already set) |

The `<PREFIX>` variants put the URL where your bundler can inline it into browser code: `PUBLIC_` (SvelteKit, Astro, Qwik), `NEXT_PUBLIC_` (Next.js), `VITE_` (Vite), `NUXT_PUBLIC_` (Nuxt), `REACT_APP_` (Create React App), `VUE_APP_` (Vue CLI), and `GATSBY_` (Gatsby). The browser SDK does not read them on its own yet.

When `local run` sees `wrangler dev` and a `wrangler.json`, `wrangler.jsonc`, or `wrangler.toml`, it also adds `--var SENTRY_SPOTLIGHT:<url>`, because Wrangler does not pass process env vars to Worker code. An explicit `--var SENTRY_SPOTLIGHT:...` is kept. No project file is changed.

## SDK setup

**Node.js and Python servers.** Nothing to do. They read `SENTRY_SPOTLIGHT`.

**Browser apps** (Next.js, Vite, and other bundlers). Pass the prefixed variable to the Spotlight integration in your client config:

```ts
// Next.js: instrumentation-client.ts
const spotlight = process.env.NEXT_PUBLIC_SENTRY_SPOTLIGHT;
// Vite: const spotlight = import.meta.env.VITE_SENTRY_SPOTLIGHT;

Sentry.init({
  dsn: "...",
  integrations: spotlight
    ? [Sentry.spotlightBrowserIntegration({ sidecarUrl: spotlight })]
    : [],
});
```

**Cloudflare Workers.** `@sentry/cloudflare` ignores the `SENTRY_SPOTLIGHT` binding in the build that Wrangler bundles. Send through `tunnel` instead, with a DSN set. A placeholder DSN works, because the tunnel sends everything to the local server:

```ts
export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN ?? (env.SENTRY_SPOTLIGHT ? "https://local@localhost/0" : undefined),
    tunnel: env.SENTRY_SPOTLIGHT,
    // Local capture still works through tunnel. This only stops a second
    // copy of each event when a bundler picks the SDK's dev build.
    spotlight: false,
  }),
  app,
);
```

While `local run` is active, `tunnel` sends Worker events only to the local server, even with a real DSN.

**Features that need a DSN.** Without one, the browser SDK drops session replays and does not add trace headers to its requests, so browser and server traces do not link. The Python SDK drops logs still buffered when the process exits. To get these, set a placeholder DSN such as `https://local@localhost/0` while you run under `local run`. In the browser, send through `tunnel` instead of the integration, so nothing goes to the placeholder and nothing arrives twice:

```ts
Sentry.init({
  dsn: spotlight ? "https://local@localhost/0" : "...",
  tunnel: spotlight,
});
```

**Not supported yet.** The Next.js edge runtime (`@sentry/vercel-edge`) has no Spotlight support. Edge errors still arrive through the Node.js server, but edge messages and logs do not.

## Browser UI

Use `--open` with `sentry local` or `sentry local run` to launch the Sentry Local UI ([local.sentry.dev](https://local.sentry.dev)) in your browser. The UI connects to the local receiver via the loopback stream endpoint and provides a visual workspace for browsing errors, traces, logs, and AI spans captured during the session.

The `--open` flag requires a loopback `--host` (localhost, 127.0.0.1, or ::1). The hosted UI reads the SSE stream without changing retained receiver data. A loopback-served viewer can clear a receiver and reset or close a scoped daemon session. Session data stays in memory for the duration of the server; nothing is sent to sentry.io unless a DSN is configured.

## Endpoints

| Method | Path                            | Description                                        |
|--------|---------------------------------|----------------------------------------------------|
| `POST` | `/stream`                       | Envelope ingest                                    |
| `POST` | `/api/{projectId}/envelope/`    | Sentry SDK ingest path                             |
| `GET`  | `/stream`                       | Server-Sent Events feed of incoming envelopes      |
| `GET`  | `/health`                       | Liveness check (returns `OK`)                      |

## Tail output

By default, incoming envelopes are pretty-printed to the terminal:

```
14:32:01 [ERROR]   [SERVER]  TypeError: x is not a function [app.ts:42:5] [handleRequest]
14:32:02 [TRACE]   [BROWSER] [http.client] GET /api/users [245ms] [3 spans]
14:32:03 [INFO]    [SERVER]  User logged in [user_id=1234] [region=us]
14:32:04 [WARNING] [BROWSER] Cart is empty [page.tsx:24:19] [onClick]
```

Errors show their level, the exception type, message, and the newest stack frame from your app. Messages, such as `captureMessage` calls and Python `logging` records, show their level and text, plus the logger name when there is one. Transactions show the operation, duration, and span count. Logs show the severity level, message, and custom attributes. Attributes the SDK adds itself (`sentry.`, `http.`, `url.`, `db.`, `server.`, `code.`, `thread.`, and similar prefixes) are hidden; add `--attributes` (`-a`) to list them under each log line.

The source tag comes from the event's platform and runtime, so a Next.js or SvelteKit app shows `[BROWSER]` for client events and `[SERVER]` for server events. Logs and spans don't carry that, so they're tagged `[BROWSER]` when they show signs of the browser SDK (a `pageload`, `navigation`, `ui.*` or `resource.*` span, a browser instrumentation origin, `browser.*` attributes, or a session replay ID) and from the SDK name otherwise. A browser log sent while no replay is recording has none of these, so it is tagged from the SDK name.

A session replay prints one line when it starts, with its short ID and first page, such as `[REPLAY]  [BROWSER] replay 4d1c5b0e http://localhost:3000/`. The segments it sends every few seconds after that don't print anything.

Use `--filter` / `-f` to narrow the output to specific event types. The flag is
repeatable, so `-f error -f log` shows only errors and logs. The `error` filter
covers every event item, so it includes messages too.

Use `--quiet` to suppress tail output entirely if you only need the SSE stream.

## Agent tracing

`sentry local` shows rich output for AI agent spans when your SDK instruments with [OpenTelemetry semantic attributes](https://opentelemetry.io/docs/specs/semconv/gen-ai/):

```
14:32:01 [TRACE]   [SERVER]  [gen_ai] chat anthropic/claude-4-sonnet [1200ms] [5 spans]
14:32:02 [TRACE]   [SERVER]  [mcp] tools/call search_files [320ms]
14:32:03 [TRACE]   [SERVER]  [db] SELECT users [postgresql] [12ms]
14:32:04 [ERROR]   [SERVER]  RateLimitError: API quota exceeded [api_client.py:42]
```

GenAI operations show the model name, MCP tool calls show the tool being invoked, and database queries show the system and query summary. This works automatically when your Sentry SDK is configured with AI/LLM integrations.

To watch only agent activity, filter to the `ai` item type with `-f ai`, and add
`-f error` to keep errors alongside agent spans.

## JSON output

Use `--format json` (or `-F json`) for machine-readable NDJSON output, one JSON object per envelope item.

`local run` supports the same JSON, attribute, and filter options while it
starts your app and injects the receiver URL. For an agent-friendly stream
without SDK housekeeping envelopes, filter to `error`, `transaction`, `log`, and
`ai` items. Each JSON line looks like this:

```json
{"type":"transaction","timestamp":1700000001,"op":"gen_ai","label":"chat anthropic/claude-4-sonnet","duration_ms":1200,"span_count":5,"source":"server"}
{"type":"error","timestamp":1700000002,"level":"error","error_type":"RateLimitError","message":"API quota exceeded","source":"server"}
{"type":"log","timestamp":1700000003,"level":"info","message":"User logged in","attributes":{"user_id":1234},"source":"server"}
{"type":"message","timestamp":1700000004,"level":"warning","message":"Cart is empty","logger":"shop.cart","source":"server"}
```

This is useful for AI coding agents and automation tools that need to consume Sentry events programmatically.

Events with an exception type are `"type":"error"` records. Events without one,
such as `captureMessage` calls and Python `logging` records, are
`"type":"message"`. `-f error` returns both, so a script that keeps errors with
`jq 'select(.type=="error")'` should also keep `"message"` if it wants them.

In JSON mode, event records are versioned NDJSON on standard output. Startup,
connection, and shutdown messages stay on standard error, so an agent can pipe
the evidence stream without parsing terminal status text. Records include
`schema_version`, `trace_id`, and, when supplied by the SDK, `event_id` and
`envelope_id` for exact correlation. `timestamp` is always epoch seconds, even
when the SDK sends ISO 8601 strings. In `local run --format json`, the wrapped
app's standard output is also forwarded to standard error, leaving standard
output exclusively for NDJSON observations.

## Agent-debugging fixture

The repository includes a small Hono server that produces a normal database
request, an agent/MCP trace, and an intentional failure. It sends only to the
local server unless you explicitly set `SENTRY_DSN`.

In one terminal, start the local receiver:

<!-- allow-commands: step of a multi-terminal fixture walkthrough -->
```bash
sentry local serve --format json --attributes
```

In another, run the fixture with Spotlight pointed at that receiver:

```bash
SENTRY_SPOTLIGHT=http://localhost:8969/stream \
  pnpm --filter sentry run ts test/fixtures/local-agent-server.ts
```

Then exercise each telemetry shape:

```bash
curl http://127.0.0.1:3030/api/users/42
curl -X POST http://127.0.0.1:3030/api/agent/run \
  -H 'content-type: application/json' \
  -d '{"prompt":"Where is the rate limit configured?"}'
curl -i http://127.0.0.1:3030/api/broken
```

The final request intentionally returns HTTP 500. The fixture is for local
experimentation only; do not run it with production credentials.

## Daemon-owned sessions

Use `--session <name>` to capture into the shared loopback daemon and retain data
after your foreground command exits. Sessions keep up to 500 envelopes by default
(`--max-envelopes` accepts 1 to 50,000) for three hours after closing and
subsequent ingestion. Session commands start the daemon when it isn't running;
`sentry local daemon start` starts it ahead of time. Stopping or restarting the
daemon (`sentry local daemon restart`) clears all sessions. A running
`sentry local run --session` then warns that its session stopped capturing. Your
app keeps running, so restart the command to capture again.

The `sentry local run` examples above walk through a full session lifecycle:
capture, inspect sessions, events, and envelopes, then reset, close, and stop
the daemon. `sentry local serve --session worker` captures into a session the
same way without wrapping a command.

`sentry local session create <name> --json` returns separate SDK ingest and
viewer read capability URLs. Keep these URLs private. `--clientId <key>` makes
retried session creation idempotent. Use the session ID when multiple sessions
share a label.
