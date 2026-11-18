# Sentry Local

How `sentry local` captures an app's Sentry telemetry with no account: `run
--verify` reports whether the app's SDK sends events, a `--session` run keeps
its events queryable after the app exits, terminal output hides session
credentials, and stopping the daemon ends every session. No design doc states
its goals yet; the user docs are `docs/cli/local-control-plane.md` and the
`sentry local` page of the CLI docs.

## Claims

- `verify-receives` `sentry local run --verify` exits 0 once the wrapped app sends an event. Proof: `drive`.
- `verify-no-event` `sentry local run --verify` exits 64 with `Process exited before sending any events` when the app exits without sending one. Proof: `drive`.
- `session-retained` Events that an app sent under `local run --session` stay listed by `local event list` after the app exits. Proof: `drive`.
- `event-list-summary` Each `local event list --json` entry has `envelopeId`, `eventId`, `itemTypes`, and `type`, and an SDK error also has `level` and its message as `title`. Proof: `drive`.
- `capability-redacted` `local run --session` never prints the session's ingest, stream, or directory capability. Proof: `drive`.
- `missing-session-exit` A query for a session that does not exist exits 23, names the session, and suggests `sentry local session list`, with and without `--json`. Proof: `drive`.
- `stop-clears` After `local daemon stop`, a new daemon has none of the old sessions. Proof: `drive`.

## How to get to it

- `sentry local run -- <command>` and `sentry local serve` in a terminal, here from CLI source through `sentry-offline.mjs` and `local-session.mjs`.
- `--verify` and `--session <name>` on `local run`.
- `sentry local session|event|envelope` queries and `sentry local daemon start|status|stop`.
- The browser viewer at <https://local.sentry.dev/>; this map does not drive it.

## Driving it with local-session.mjs

Preconditions:

- Launch from `../SKILL.md` passes, and `$VERIFY_RUN` is set.
- The wrapped app is `scripts/local-app.mjs`. It sends one error, `verify-toolkit local error`, through the real Sentry Node SDK and prints `SDK_EVENT:<event id>` to stderr; `--none` sends nothing.

- **`verify-receives`: verify an app that sends.** Run `node .agents/skills/verify-toolkit/scripts/sentry-offline.mjs --out "$VERIFY_RUN/local-verify" -- local run --verify -- node "$PWD/.agents/skills/verify-toolkit/scripts/local-app.mjs"`. It prints `exit 0`. `stderr.txt` contains `SDK_EVENT:` and `Setup verified`.
- **`verify-no-event`: verify an app that sends nothing.** Run `node .agents/skills/verify-toolkit/scripts/sentry-offline.mjs --out "$VERIFY_RUN/local-verify-none" -- local run --verify -- node "$PWD/.agents/skills/verify-toolkit/scripts/local-app.mjs" --none`. It prints `exit 64`. `stderr.txt` contains `Process exited before sending any events`.
- **`session-retained`, `event-list-summary`, `capability-redacted`, `missing-session-exit`: capture a session and query it.** Run:

  ```bash
  node .agents/skills/verify-toolkit/scripts/local-session.mjs --out "$VERIFY_RUN/local-session" \
    --step 'local run --session web --port {port} -- {node} {app}' \
    --step 'local session view web --json' \
    --step 'local event list web --json' \
    --step 'local event list nosuch --json' \
    --step 'local event list nosuch'
  ```

  It prints `exit 0` for steps 1 to 3, `exit 23` for steps 4 and 5, and `teardown: sentry local daemon stop: exit 0`. Run `node .agents/skills/verify-toolkit/scripts/check-results.mjs local "$VERIFY_RUN/local-session"`. It prints `PASS` for `session-retained`, `event-list-summary`, and `capability-redacted`. For `missing-session-exit`, `stderr.txt` in `step-4` and `step-5` contains `Local session "nosuch" not found.` and `sentry local session list`.

- **`stop-clears`: stop the daemon and start a new one.** Run:

  ```bash
  node .agents/skills/verify-toolkit/scripts/local-session.mjs --out "$VERIFY_RUN/local-stop" \
    --step 'local run --session web --port {port} -- {node} {app}' \
    --step 'local daemon stop --json' \
    --step 'local daemon start --port {port} --json' \
    --step 'local event list web --json'
  ```

  Step 2's `stdout.txt` has `"stopped": true`, and step 4 prints `exit 23` with `Local session "web" not found.` in its `stderr.txt`.

## Gotchas

- The CLI runs with `packages/cli` as its working directory, so a command that `sentry-offline.mjs` wraps needs an absolute path. `local-session.mjs` replaces `{app}`, `{node}`, and `{port}` in each step for you; it splits each step on spaces.
- `{port}` is a free port that the script picks, so the run never meets a daemon already on 8969. Keep `--port {port}` on the step that starts the daemon. A query with no daemon running starts one on 8969, so after `local daemon stop`, start the next daemon with `local daemon start --port {port}`.
- `--verify` uses port 8969 when it is free and a free port when it is busy, so it needs no `--port`.
- `local event list --json` also lists the SDK's `session` envelope. Find the error by its `SDK_EVENT` ID, not by its position.
- `session view --json` prints the capabilities on purpose; only the `local run` output must hide them.

## Gaps

- `viewer-shows-session` The browser viewer shows a session's events from its stream URL. This skill has no browser driver.
- `wrangler-binding` `local run` passes the receiver's URL to `wrangler dev` as `--var SENTRY_SPOTLIGHT`. The offline drive has no Wrangler project or binary.
