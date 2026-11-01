

## Sending from a file

Prefix relative file paths with `./` to distinguish them from a project target.
`--raw` sends the file without re-parsing and also accepts pre-built envelopes.

## DSN authentication

`sentry event send` authenticates with ingest via a **DSN**, not a user token.
An explicit DSN, `SENTRY_DSN`, and project auto-detection do not require login.
Passing `<project>` or `<org>/<project>` does: the CLI uses your session to
resolve the project and fetch its active DSN, then sends to ingest. If a project
has multiple active DSNs, pass the desired DSN explicitly.

The DSN is resolved in priority order:

1. A leading `<dsn>`, `<project>`, or `<org>/<project>` positional
2. `SENTRY_DSN` environment variable
3. Auto-detection from the current project (`.env`, source code, env files)

## Selecting an event from an issue

Copy a full event ID from `sentry issue events PROJ-ABC` and pass it after the
issue short ID to open that event. The issue resolves the project; omitting the
event ID selects the latest event. Invalid event IDs return an error instead of
selecting the latest event.

## Attachments

`sentry event view --json` lists an event's attachment metadata. Download an
attachment with `sentry api` and the attachment's `?download=1` URL.

## Finding Event IDs

Event IDs can be found:

1. In the Sentry UI when viewing an issue's events
2. In the output of `sentry issue view` commands
3. In error reports sent to Sentry (as `event_id`)

## Backward compatibility

The old sentry-cli top-level command `sentry send-event` is available as a
hidden alias for `sentry event send`.
