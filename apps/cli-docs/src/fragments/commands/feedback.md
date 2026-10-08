## Examples

### List User Feedback

Modern User Feedback is stored as Feedback issues. The command always limits
issue searches to `issue.category:feedback`; it does not use the legacy User
Reports API.

```bash
# Auto-detect the organization from the current project
sentry feedback list

# List Feedback for one project
sentry feedback list my-org/frontend

# List Feedback across every project in an organization
sentry feedback list my-org/

# Search for a project across accessible organizations
sentry feedback list frontend
```

The unresolved inbox from the last 14 days is shown by default. Select another
mailbox or expand the time range with flags:

```bash
sentry feedback list my-org/frontend --status resolved
sentry feedback list my-org/frontend --status spam
sentry feedback list my-org/frontend --status all --period 90d
sentry feedback list my-org/frontend --query "message:*checkout*"
```

Use `--json` for the standard paginated envelope. Navigate pages in either
direction with `--cursor next` and `--cursor prev`.

### View User Feedback

```bash
# Most recent unresolved Feedback, with detected or explicit organization
sentry feedback view @latest
sentry feedback view my-org/@latest

# Short ID or numeric ID
sentry feedback view FRONTEND-2SDJ
sentry feedback view 5146636313

# Explicit organization
sentry feedback view my-org/FRONTEND-2SDJ

# `view` is the default command; `show` is an alias
sentry feedback my-org/FRONTEND-2SDJ
sentry feedback show my-org/FRONTEND-2SDJ

# Open the Feedback item in Sentry
sentry feedback view my-org/FRONTEND-2SDJ --web
```

`@latest` selects the most recently active unresolved Feedback.

The detail view includes the complete message and, when available, its latest
event, linked error, Session Replays, and attachment metadata. If the supplied
ID belongs to another issue category, use `sentry issue view` instead.

### Resolve User Feedback

```bash
# Resolve a Feedback item immediately
sentry feedback resolve my-org/FRONTEND-2SDJ

# Resolve the most recently active unresolved Feedback
sentry feedback resolve my-org/@latest

# Return the updated Feedback, or select specific fields
sentry feedback resolve my-org/FRONTEND-2SDJ --json --fields id,shortId,status
```

`resolve` accepts the same IDs and URLs as `view` and reads the current state
before selecting a Feedback item. It rejects other issue categories before
making changes. JSON output contains the updated Feedback issue from Sentry.

### Reopen User Feedback

```bash
# Find resolved Feedback
sentry feedback list --status resolved

# Reopen a Feedback item using its short ID or numeric ID
sentry feedback unresolve FRONTEND-2SDJ
sentry feedback unresolve 5146636313

# `reopen` is an alias for `unresolve`
sentry feedback reopen FRONTEND-2SDJ

# Specify an organization explicitly when needed
sentry feedback unresolve my-org/FRONTEND-2SDJ

# Return selected fields from the updated Feedback
sentry feedback unresolve FRONTEND-2SDJ --json --fields id,shortId,status
```

`unresolve` marks Feedback as `unresolved`, reopening resolved Feedback or
returning spam to the inbox. It uses the same identifier resolution and category
check as `resolve`. Other issue categories are rejected before making changes.
JSON output contains the updated Feedback issue from Sentry.

### Mark User Feedback as spam

```bash
# Move a Feedback item to the spam mailbox
sentry feedback spam FRONTEND-2SDJ
sentry feedback spam 5146636313

# Specify an organization explicitly when needed
sentry feedback spam my-org/FRONTEND-2SDJ

# Return selected fields from the updated Feedback
sentry feedback spam FRONTEND-2SDJ --json --fields id,shortId,status
```

To return spam to the unresolved inbox:

```bash
# Find spam and return a Feedback item to the unresolved inbox
sentry feedback list --status spam
sentry feedback unresolve FRONTEND-2SDJ
```

`spam` checks that the target is Feedback before updating it. Sentry stores spam
with status `ignored`, which is also the value returned in JSON output. Use
`unresolve` to return it to the inbox; this sets the status to `unresolved`
regardless of its status before being marked as spam.
