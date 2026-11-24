# Sentry Local

`sentry local` shows a developer, or their coding agent, the Sentry telemetry
their app sends during development, on their own machine, with no Sentry
account.

## Intent

- No account and no login. Local works before a project exists, and events
  from an app with no DSN never reach a Sentry organization or use quota.
- No app changes where the SDK allows it. `local run` hands the app the
  receiver's address, so Node.js and Python servers send to it with no setup.
- Agents are first-class users. An agent can capture a run, query it after the
  app exits, and pick which event to open from a JSON summary, without viewing
  every event.
- Telemetry stays on the machine and is temporary. It lives in memory, is
  reachable only over loopback, and ends when the daemon stops.
- Existing Sentry SDK Spotlight transports work unchanged.

## Entry points

- `sentry local run`, which wraps an app, and `sentry local serve`, which
  starts a receiver and tails its events.
- `sentry local run --verify`, which checks that an app's SDK sends events.
- `--session <name>` on `run` and `serve`, and the `sentry local session`,
  `sentry local event`, and `sentry local envelope` commands that query a
  session.
- `sentry local daemon start|status|stop|restart`.
- The browser viewer at <https://local.sentry.dev/>, opened with `--open`.

## Rules

- No `sentry local` command needs a login.
- The daemon and receivers listen only on loopback addresses and answer only
  requests addressed to loopback.
- A session's ingest, stream, and directory URLs are credentials, and the
  terminal output of `local run` never prints them
  (`sentry-local#capability-redacted`).
- A closed session stays queryable for three hours, and every session ends
  when the daemon stops (`sentry-local#session-retained`,
  `sentry-local#stop-clears`).
- Each session or receiver keeps its most recent envelopes, 500 by default,
  and a user can set the limit from 1 to 50,000.
- A session or receiver stores and shows an error, transaction, or feedback
  once per event ID while it retains that event, so an SDK that sends to both
  Spotlight and a DSN does not show it twice. Replay segments, check-ins, logs,
  and spans are never dropped this way.
- A session name reads from its newest open session, or its newest session
  when none is open, because every `local run --session` creates a new one.
  Close, reset, and retention changes refuse a name that several open sessions
  share. A session ID always selects that session.
- A missing or evicted session, event, or envelope is a not-found error that
  names what is missing and the list command to run
  (`sentry-local#missing-session-exit`).
- `--verify` succeeds only when the app sends an event
  (`sentry-local#verify-receives`, `sentry-local#verify-no-event`).

## Gaps

None.
