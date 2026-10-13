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
be unique for name-based queries; use the session ID when a name is ambiguous.

The daemon stores its discovery token under `SENTRY_CONFIG_DIR` in an owner-only
state file. It binds only to localhost, 127.0.0.1, or ::1 and uses a nonzero port.
A second daemon cannot replace the running daemon for that config directory.
Restart preserves its configured host and port and clears all in-memory data.

## Browser viewer

The independently served viewer lives in `apps/local`. Run
`pnpm --filter local dev` to serve it on localhost:5173. With that viewer running,
`local run --session web --open -- npm run dev` opens its scoped stream. Production
CLI builds use <https://local.sentry.dev/>; publishing the migrated app requires
that hosting project to use Toolkit and `apps/local` as its root directory.

A loopback-served viewer can reset and close its scoped session. The hosted viewer
can read the stream and clear its own displayed feed; it cannot mutate retained
receiver data. Remote HTTPS streams stay read-only.

## Verification

`pnpm --filter sentry test:e2e` builds the npm bundle and runs the CLI process
suite. `test/e2e/local.test.ts` covers concurrent startup, session isolation,
capability checks, retained queries, scoped browser controls, wrapped applications,
real Sentry Node SDK ingestion, restart, and singleton ownership. The Local workflow repeats these tests against
npm and native binaries on Linux, macOS, and Windows.

`pnpm --filter local test` includes viewer tests with a real receiver and SSE
connection, as well as scoped reset/close integration coverage.
