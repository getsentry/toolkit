
## Examples

### List replays

```bash
# List recent replays for a project
sentry replay list my-org/frontend

# Search across all projects in an org
sentry replay list my-org/ --query "environment:production"

# Change the time window and sort
sentry replay list my-org/frontend --period 24h --sort errors

# Paginate through results
sentry replay list my-org/frontend -c next
sentry replay list my-org/frontend -c prev

# Output machine-readable data
sentry replay list my-org/frontend --json
```

### View a replay

```bash
# View a replay by ID using auto-detected org/project context
sentry replay view 346789a703f6454384f1de473b8b9fcc

# View a replay with an explicit org
sentry replay view my-org/346789a703f6454384f1de473b8b9fcc

# View a replay with explicit org/project context
sentry replay view my-org/frontend/346789a703f6454384f1de473b8b9fcc

# Open a replay in the browser
sentry replay view my-org/346789a703f6454384f1de473b8b9fcc --web

# View the replay linked to a trace
sentry replay view my-org/frontend/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

### Download a replay

```bash
# Download a replay as rrweb JSON to ./<replay-id>.rrweb.json
sentry replay download my-org/346789a703f6454384f1de473b8b9fcc

# Choose where the file goes
sentry replay download my-org/346789a703f6454384f1de473b8b9fcc --output ./replay.json

# Download from a replay URL
sentry replay download https://sentry.io/organizations/my-org/explore/replays/346789a703f6454384f1de473b8b9fcc/
```

The file is a flat, time-ordered array of rrweb events, ready for
[rrweb-player](https://github.com/rrweb-io/rrweb/tree/master/packages/rrweb-player)
or [rrvideo](https://github.com/rrweb-io/rrweb/tree/master/packages/rrvideo).
Sentry's custom events (breadcrumbs, performance spans) are kept.
