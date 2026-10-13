# Local daemon and browser viewer

`local run --session <name>` and `local serve --session <name>` capture into an
isolated session owned by a background, loopback-only daemon. The foreground
command retains its session when it exits. Closed sessions remain queryable for
three hours after the last activity; each retains at most 500 envelopes. All
telemetry disappears when the daemon stops.

```sh
sentry local run --session web -- npm run dev
sentry local session list --json
sentry local event list web --json
sentry local event view web <event-id> --json
sentry local envelope list web --json
sentry local session reset web
sentry local session close web
sentry local daemon status
sentry local daemon stop
```

`local session create <name> --json` returns distinct `ingestUrl` and `streamUrl`
capabilities for SDK ingestion and viewer reads. The ingest capability lives in
the URL path so SDK transports that omit query parameters still deliver events.
Treat those URLs as credentials.
Use `--clientId <key>` to make session creation idempotent for retries. Names must
be unique for name-based queries; ambiguous names return HTTP 409 with guidance
to use the session ID.
Session lookup commands accept names quoted or as separate words. For `event view` and
`envelope view`, the final argument is the telemetry ID; preceding arguments
form the session name. Event lookup uses the Sentry event ID from the envelope
header, event/transaction item header, or payload, in that order; envelopes
without an event ID retain their generated envelope ID as the lookup key.

The daemon stores its discovery token under `SENTRY_CONFIG_DIR` in an owner-only
state file. It binds only to localhost, 127.0.0.1, or ::1 and uses a nonzero port.
A second daemon cannot replace the running daemon for that config directory.
Restart preserves its configured host and port and clears all in-memory data.
It waits for the previous daemon to release its state and ownership; a rejected
stop or shutdown timeout reports an error while preserving discovery.
A temporarily unreachable live daemon keeps its discovery state for retries.
A short ownership guard serializes claiming, stale recovery and release. If a
process dies during that critical section, startup preserves the guard and reports
its path; confirm the owning process has stopped before removing the guard and
retrying.
Startup waits through the listener retry window and preserves active startup locks.
Incomplete owner files receive a five-second grace period. Once safely reclaimed,
ownership is claimed under the same guard, including on the final retry.

When a managed daemon owns the requested port, plain `local run` and `local serve`
require `--session <name>` or a different `--port`; they cannot use its protected
receiver as a legacy `/stream` endpoint.

## Envelope retention

Each session or plain receiver retains 500 envelopes by default. Set a limit from
1 to 50,000 with `--max-envelopes` on `local session create`, `local run`, or
`local serve`, for example:

```sh
sentry local run --session web --max-envelopes 1000 -- npm run dev
sentry local session retention web --max-envelopes 2000
sentry local session retention web --json
```

Increasing the limit preserves existing envelopes, their IDs, and active streams;
previously evicted envelopes cannot be recovered. Lowering below the retained count
is rejected without changing any data. Clear envelopes first to reduce that limit.
Changing capacity does not reset the session's three-hour lifecycle retention.
An explicit limit also configures an existing plain receiver; ordinary attachment
preserves its current setting. Older receivers that cannot apply the flag report an
error. Retrying session creation with the same client ID preserves its original settings.

The viewer follows the receiver's envelope limit and retains every decoded item
inside each retained envelope. Its Retention limit control can update a locally
served receiver or scoped session at runtime without replacing the connection.
Hosted viewers display the setting but cannot change it. CLI changes also update
connected viewers.

## Browser viewer

The independently served viewer lives in `apps/local`. Run
`pnpm --filter local dev` to serve it on localhost:5173. With that viewer running,
`local run --session web --open -- npm run dev` opens its scoped stream. Production
CLI builds use <https://local.sentry.dev/>; publishing the migrated app requires
that hosting project to use Toolkit and `apps/local` as its root directory.

A loopback-served viewer can reset and close its scoped session. The hosted viewer
can read the stream and clear its own displayed feed; it cannot mutate retained
receiver data. Remote HTTPS streams stay read-only.

Search and view navigation remain available for retained telemetry after a
receiver disconnects or a session closes, including raw-only envelopes. A trace
search with no matches explains how to change or clear the filter. Closing an
empty session returns to the receiver picker. Waterfall failure styling uses
each span's own level, HTTP status, and SDK span status; a failed transaction does not mark healthy child
spans as failures. The AI workspace matches AI namespaces (`ai`, `gen_ai`,
`llm`), including dotted origins, rather than substrings of ordinary operations.

## Verification

`pnpm --filter sentry test:e2e` builds the npm bundle and runs the CLI process
suite. `test/e2e/local.test.ts` covers concurrent startup, session isolation,
capability checks, retained queries, scoped browser controls, wrapped applications,
real Sentry Node SDK ingestion, restart, and singleton ownership. The Local workflow repeats these tests against
npm and native binaries on Linux, macOS, and Windows.

`pnpm --filter local test` includes viewer tests with a real receiver and SSE
connection, as well as scoped reset/close integration coverage.
