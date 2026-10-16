# Local daemon and browser viewer

`local run --session <name>` and `local serve --session <name>` capture into an
isolated session owned by a background, loopback-only daemon. The foreground
command retains its session when it exits. Closed sessions remain queryable for
three hours after the last activity; each retains 500 envelopes by default. All
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

`local run --verify` uses an ephemeral receiver and cannot be combined with
`--session` or `--open`. Invalid combinations are rejected before a receiver or
application is started. Omit `--verify` to capture into a retained daemon session.

`local session create <name> --json` returns distinct `ingestUrl`, `streamUrl`, and `directoryUrl`
capabilities for SDK ingestion, single-session streaming, and browser session discovery. The ingest capability lives in
the URL path so SDK transports that omit query parameters still deliver events.
Treat those URLs as credentials.
Use `--clientId <key>` to make session creation idempotent for retries. Once a
retained session expires, reusing its key creates a fresh session with new capabilities.
Names must be unique for name-based queries; ambiguous names return HTTP 409 with guidance
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
Both stop and restart wait for the previous daemon to release its state and ownership
before reporting success; a rejected stop or shutdown timeout reports an error while
preserving discovery.
A temporarily unreachable live daemon keeps its discovery state for retries.
A short ownership guard serializes claiming, stale recovery and release. If a
process dies during that critical section, startup preserves the guard and reports
its path; confirm the owning process has stopped before removing the guard and
retrying.
Startup waits through the listener retry window and preserves active startup locks.
Concurrent foreground and managed starts join the same daemon: session creation
waits for a live foreground owner to publish authenticated discovery, even if a
competing child exits before that owner finishes binding.
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

The Settings dialog also offers Light, Dark, and System appearance options.
The choice applies immediately and persists in the browser across reloads.
System follows the browser's `prefers-color-scheme` preference, including live
changes; the dialog shows its resolved Light or Dark appearance. An explicit
Light or Dark choice overrides it until System is selected again.
Settings also remains accessible from the connection landing without an active receiver.

On narrow screens, the event or trace list stacks above its inspector. Mobile
receiver actions open the same Settings and Add receiver dialogs as the sidebar.

### Receiver connections

**Add receiver** opens a modal over the current feed. Close it with its close
button, Escape, or an outside click; focus returns to its trigger. The background
is blocked while Add receiver or Settings is open. Both dialogs scroll within
the viewport. Adding a receiver checks its stream before replacing a healthy
feed. A failed or cancelled attempt keeps the existing connection and events.

**Past connections**, below the connection form, lists successful receivers for
this browser tab and survives reloads. Choose one to reconnect without pasting
its address, or use its remove button to forget the entry. Local entries use the
plain `/stream` address so reconnecting discovers available sessions without
saving session capabilities in the list. Remote URLs stay in tab session storage;
query credentials are omitted from their displayed labels. No history entry is
created for a failed connection.

Closing a session stops capture immediately: later ingestion receives HTTP 410,
including requests whose bodies finish after Close. Saved events remain readable
for three hours from the first Close; retries and attempted ingestion do not extend
that deadline. **Reload saved events** replays the archive without resuming capture.
The viewer keeps the workspace visible even when the archive is empty. Close is
guarded against duplicate requests and times out if the receiver does not respond.

**Disconnect receiver** returns to the connection screen without closing capture
or deleting receiver data. This tab stays disconnected after a reload; use Connect,
past connections, or an explicit connection link to resume. **Clear events** resets
local receiver data when permitted and resumes only an open session's feed. Closed
sessions stay closed and empty after a reset. Other connected viewers receive reset
and close notifications. The hosted viewer clears only its displayed data; reloading
saved events restores the daemon's archive.

### Switching sessions

Human-readable `local run` and `local serve` output prints a **View events at**
link with the receiver's actual port, for example:

```text
View events at https://local.sentry.dev/?url=http%3A%2F%2Flocalhost%3A8969%2Fstream
```

Session create/view and daemon start/status summaries include the same link.
It opens the hosted viewer and connects to the plain receiver address, so named
sessions appear in the picker automatically. The public `url` query accepts only
credential-free loopback `/stream` addresses; session capabilities still use the
existing fragment connection flow. The viewer consumes the query at startup so
reloading keeps the selected session. JSON and NDJSON output stay unchanged.

Connect to the daemon's plain `http://127.0.0.1:8969/stream` endpoint (using its
actual host and port) to discover running sessions automatically. The viewer
selects the first running session and fills the Session picker. If no sessions
exist yet, it waits and discovers them as they start. This works in the local
development viewer and on <https://local.sentry.dev/>. Alternatively, run either
command with `--session <name> --open` to start on that specific session.
The picker lists running and retained sessions from that daemon, including sessions
created after the viewer opens. It refreshes every five seconds; Refresh sessions
updates it immediately. Labels include the working directory and a short session ID
to distinguish runs with the same name. Picking a session replaces only the viewer's
feed, searches, and selection; the daemon retains every session's captured data.
Switching back replays its retained envelopes. Retention follows the selected session.
A failed refresh leaves the current feed readable. Expired sessions leave the list;
the viewer keeps already displayed telemetry and does not silently switch runs.

The daemon-wide `/stream` emits discovery metadata to loopback viewers and the
trusted hosted Local origins. Other browser origins cannot read it. Discovery
uses a separate `directoryUrl` capability, also returned by session create and
session view. `--open` passes it alongside the initial stream in the URL fragment,
which is removed after startup and is never sent to the hosting server. The directory
is kept only in tab session storage, so reloads can retain the picker. The capability
allows discovery of all sessions and their stream capabilities on this daemon; treat
it as a credential. It does not grant ingestion or the CLI control API, and expires
when the daemon stops. By themselves, existing scoped stream links do not grant sibling discovery.
An older CLI/daemon or a plain receiver can still connect without a picker; reopen
with an updated CLI and daemon to enable discovery. An already-running older daemon
needs a restart after upgrading; restarting clears its in-memory telemetry. One picker
covers one daemon, not receivers on other ports or computers.

Open Settings with the sidebar gear (or Session settings in the mobile receiver
menu) to view retention for the selected session. A locally served viewer can
change the limit at runtime with validation; increases preserve captured data,
and lowering it below the retained count is rejected until enough data is cleared.
Retention is read-only in the hosted viewer; use the CLI to change it there.
The sidebar keeps Add receiver on its own row, with Settings at the left and
Clear, Close, and Disconnect icons at the right beneath it. Icon tooltips also work with keyboard focus.

A loopback-served viewer can reset and close its scoped session. The hosted viewer
can read the stream and clear its own displayed feed; it cannot mutate retained
receiver data. Remote HTTPS streams stay read-only.

Exception event titles use the current SDK exception type and message, including
when the event carries a request transaction name. Overview shows the current
exception, its causes, and stack frames with function names, source locations, and
captured source lines. Frames appear most recent first; the JSON tab preserves the
complete original payload.

Switching or reconnecting a receiver isolates pending actions and stream callbacks
from earlier connections, including when returning to the same receiver URL.

Search and view navigation remain available for retained telemetry after a
receiver disconnects or a session closes, including raw-only envelopes. A trace
search with no matches explains how to change or clear the filter. Closing an
empty session keeps the workspace visible; Disconnect returns to the receiver picker. Waterfall failure styling uses
each span's own level, HTTP status, and SDK span status; a failed transaction does not mark healthy child
spans as failures. The AI workspace matches AI namespaces (`ai`, `gen_ai`,
`llm`), including dotted origins, rather than substrings of ordinary operations.

## Verification

`pnpm --filter sentry test:e2e` builds the npm bundle and runs the CLI process
suite. `test/e2e/local.test.ts` covers concurrent startup, session isolation,
capability checks, hosted-origin session discovery and isolated stream switching, retained queries, scoped browser controls, wrapped applications,
real Sentry Node SDK ingestion, restart, and singleton ownership. The Local workflow repeats these tests against
npm and native binaries on Linux, macOS, and Windows.

`pnpm --filter local test` includes viewer tests with a real receiver and SSE
connection, as well as scoped reset/close integration coverage.
