

`sentry local` runs a local development server that captures Sentry SDK envelopes from your dev stack and surfaces errors, traces, and logs in real time — right in your terminal. No authentication required.

No DSN is required either. If your app has no DSN configured, events flow **only** to the local server — nothing reaches your Sentry organization and no production quota is used. If a DSN *is* set, the SDK sends to both Sentry and the local server.

If a server is already running on the port, the command attaches as an SSE consumer instead of starting a duplicate.

## Examples

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
```

## `sentry local run`

Runs a command with `SENTRY_SPOTLIGHT` injected into the environment. The Sentry SDK automatically detects this variable and sends envelopes to the local server. No code changes needed.

If nothing is listening on the port, a server is started in the background and shut down when your command exits. If something already is — the Spotlight desktop app's own sidecar, or a `sentry local serve` in another terminal — the command attaches to it as an SSE consumer, so events still tail to your terminal either way.

Env vars injected into the child process:

| Variable | Value |
|----------|-------|
| `SENTRY_SPOTLIGHT` | `http://localhost:<port>/stream` |
| `<PREFIX>SENTRY_SPOTLIGHT` | `http://localhost:<port>/stream` |
| `SENTRY_TRACES_SAMPLE_RATE` | `1` (unless already set) |
| `SENTRY_RELEASE` | `sentry-cli-local` (unless already set) |

The `<PREFIX>` variants cover every common framework client prefix so the spotlight URL is inlined into your browser bundle no matter which bundler you use: `PUBLIC_` (SvelteKit, Astro, Qwik), `NEXT_PUBLIC_` (Next.js), `VITE_` (Vite), `NUXT_PUBLIC_` (Nuxt), `REACT_APP_` (Create React App), `VUE_APP_` (Vue CLI), and `GATSBY_` (Gatsby).

**Server vs. client.** Server-side SDKs (`@sentry/node`, Python, and friends) read `SENTRY_SPOTLIGHT` automatically — no code changes needed.

**Cloudflare Workers.** Wrangler does not expose inherited process environment variables to Worker code. When `local run` detects `wrangler dev` together with a `wrangler.json`, `wrangler.jsonc`, or `wrangler.toml`, it automatically adds `--var SENTRY_SPOTLIGHT:http://localhost:<port>/stream`.

This creates an ephemeral Worker binding that `@sentry/cloudflare` reads from its `env` object, so you do not need `spotlight: true` in `withSentry()` and no project file is modified. An explicit `--var SENTRY_SPOTLIGHT:...` is preserved.

For browser/client events, the CLI exposes the spotlight URL under every framework client prefix above. Once the [browser SDK reads these variables automatically](https://github.com/getsentry/sentry-javascript/pull/18198), client-side capture will be zero-config too. **Until then**, reference the variable matching your framework in your client config:

```ts
// Next.js example — other frameworks use their own env access pattern
// (e.g. import.meta.env.VITE_SENTRY_SPOTLIGHT for Vite-based frameworks).
Sentry.init({ spotlight: process.env.NEXT_PUBLIC_SENTRY_SPOTLIGHT ?? false });
```

## Browser UI

Use `--open` to launch the Sentry Local UI ([local.sentry.dev](https://local.sentry.dev)) in your browser. The UI connects to the local receiver via the loopback stream endpoint and provides a visual workspace for browsing errors, traces, logs, and AI spans captured during the session.

```bash
# Start the server and open the UI
sentry local --open

# Run your app with the UI
sentry local run --open -- npm run dev
```

The `--open` flag requires a loopback `--host` (localhost, 127.0.0.1, or ::1). The UI is read-only — it reads the SSE stream but cannot ingest or clear data. Session data stays in memory for the duration of the server; nothing is sent to sentry.io unless a DSN is configured.

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
```

Errors show the exception type, message, and top stack frame. Transactions show the operation, duration, and span count. Logs show the severity level, message, and custom attributes.

Use `--filter` / `-f` to narrow the output to specific event types (repeatable):

```bash
sentry local -f error -f log    # only errors and logs
```

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

To watch only agent activity, filter to the `ai` item type:

```bash
sentry local -f ai          # only AI/agent spans
sentry local -f ai -f error # agent spans and errors
```

## JSON output

Use `--format json` (or `-F json`) for machine-readable NDJSON output, one JSON object per envelope item:

```bash
sentry local --format json
```

`local run` supports the same JSON, attribute, and filter options while it
starts your app and injects the receiver URL. For an agent-friendly stream
without SDK housekeeping envelopes, use:

```bash
sentry local run --format json \
  --filter error --filter transaction --filter log --filter ai \
  -- npm run dev
```

```json
{"type":"transaction","timestamp":1700000001,"op":"gen_ai","label":"chat anthropic/claude-4-sonnet","duration_ms":1200,"span_count":5,"source":"server"}
{"type":"error","timestamp":1700000002,"error_type":"RateLimitError","message":"API quota exceeded","source":"server"}
{"type":"log","timestamp":1700000003,"level":"info","message":"User logged in","attributes":{"user_id":1234},"source":"server"}
```

This is useful for AI coding agents and automation tools that need to consume Sentry events programmatically.

In JSON mode, event records are versioned NDJSON on standard output. Startup,
connection, and shutdown messages stay on standard error, so an agent can pipe
the evidence stream without parsing terminal status text. Records include
`schema_version`, `trace_id`, and, when supplied by the SDK, `event_id` and
`envelope_id` for exact correlation. In `local run --format json`, the wrapped
app's standard output is also forwarded to standard error, leaving standard
output exclusively for NDJSON observations.

## Agent-debugging fixture

The repository includes a small Hono server that produces a normal database
request, an agent/MCP trace, and an intentional failure. It sends only to the
local server unless you explicitly set `SENTRY_DSN`.

In one terminal, start the local receiver:

```bash
sentry local serve --format json --attributes
```

In another, run the fixture with Spotlight pointed at that receiver:

```bash
SENTRY_SPOTLIGHT=http://localhost:8969/stream \
  pnpm --filter sentry exec tsx test/fixtures/local-agent-server.ts
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
