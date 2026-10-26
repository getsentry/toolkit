

## Feedback issues

Modern User Feedback is stored as Feedback issues. `sentry feedback list`
always limits issue searches to `issue.category:feedback`; it does not use the
legacy User Reports API.

The unresolved inbox from the last 14 days is shown by default. Use `--status`
to select another mailbox (`resolved`, `spam`, or `all`) and `--period` to
expand the time range. Use `--json` for the standard paginated envelope.
Navigate pages in either direction with `--cursor next` and `--cursor prev`.

## Viewing Feedback

`@latest` selects the most recently active unresolved Feedback. `view` is the
default command, and `show` is an alias.

The detail view includes the complete message and, when available, its latest
event, linked error, Session Replays, and attachment metadata. If the supplied
ID belongs to another issue category, use `sentry issue view` instead.

## Updating Feedback

`resolve` accepts the same IDs and URLs as `view` and reads the current state
before selecting a Feedback item. It rejects other issue categories before
making changes. JSON output contains the updated Feedback issue from Sentry.

`unresolve` (alias `reopen`) marks Feedback as `unresolved`, reopening resolved
Feedback or returning spam to the inbox. It uses the same identifier resolution
and category check as `resolve`. Other issue categories are rejected before
making changes. JSON output contains the updated Feedback issue from Sentry.

`spam` checks that the target is Feedback before updating it. Sentry stores spam
with status `ignored`, which is also the value returned in JSON output. Use
`unresolve` to return it to the inbox; this sets the status to `unresolved`
regardless of its status before being marked as spam.
