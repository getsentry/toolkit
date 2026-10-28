---
name: sentry-cli-issue
version: 0.48.0-dev.0
description: Manage Sentry issues
requires:
  bins: ["sentry"]
  auth: true
---

# Issue Commands

Manage Sentry issues

### `sentry issue list [<org/project>]`

List issues in a project

**Arguments:**

| Argument | Description |
|----------|-------------|
| `[<org/project>]` | &lt;org&gt;/ (all projects), &lt;org&gt;/&lt;project&gt;, or &lt;project&gt; (search) |

**Flags:**
- `-q, --query <value> - Search query (Sentry syntax, implicit AND; same-key OR becomes an in-list)`
- `-n, --limit <value> - Maximum number of issues to list - (default: "25")`
- `-s, --sort <value> - Sort by: recommended, date, new, freq, user (default: recommended on sentry.io, else date)`
- `-t, --period <value> - Time range: "7d", "2024-01-01..2024-02-01", ">=2024-01-01" - (default: "90d")`
- `-c, --cursor <value> - Pagination cursor (use "next" for next page, "prev" for previous)`
- `--compact - Single-line rows for compact output (auto-detects if omitted)`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Numeric issue ID |
| `shortId` | string | Human-readable short ID (e.g. PROJ-ABC) |
| `title` | string | Issue title |
| `culprit` | string \| null | Culprit string |
| `count` | string | Total event count |
| `userCount` | number | Number of affected users |
| `firstSeen` | string \| null | First occurrence (ISO 8601) |
| `lastSeen` | string \| null | Most recent occurrence (ISO 8601) |
| `level` | string | Severity level |
| `status` | string | Issue status |
| `permalink` | string | URL to the issue in Sentry |
| `project` | object | Project info |
| `metadata` | object | Issue metadata |
| `assignedTo` | object \| null | Assigned user or team |
| `priority` | string | Triage priority |
| `platform` | string | Platform |
| `substatus` | string \| null | Issue substatus |
| `isUnhandled` | boolean | Whether the issue is unhandled |
| `seerFixabilityScore` | number \| null | Seer AI fixability score (0-1) |

**Examples:**

```bash
# List issues (project auto-detected)
sentry issue list

# List issues in a specific project
sentry issue list my-org/frontend

# Several projects in the same organization
sentry issue list my-org/frontend,backend,worker

# All projects in an organization
sentry issue list my-org/

# Search for a project across organizations
sentry issue list frontend

# Show only unresolved issues
sentry issue list my-org/frontend --query "is:unresolved"

# Sort by frequency
sentry issue list my-org/frontend --sort freq --limit 20

# Sort by Sentry's recommended relevance ranking
sentry issue list my-org/frontend --sort recommended

# Multiple filters (space-separated terms are combined with AND)
sentry issue list --query "is:unresolved level:error assigned:me"

# Negation and wildcards
sentry issue list --query "!browser:Chrome message:*timeout*"

# Match multiple values for one key
sentry issue list --query "browser:[Chrome,Firefox]"
```

### `sentry issue events <issue>`

List events for a specific issue

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<issue>` | Issue: @latest, @most_frequent, &lt;org&gt;/ID, &lt;org&gt;/&lt;project&gt;#ID, &lt;project&gt;-suffix, ID, or suffix |

**Flags:**
- `-n, --limit <value> - Number of events (1-1000) - (default: "25")`
- `-q, --query <value> - Search query (Sentry search syntax)`
- `--full - Include full event body (stacktraces)`
- `-t, --period <value> - Time range: "7d", "2024-01-01..2024-02-01", ">=2024-01-01" - (default: "7d")`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`
- `-c, --cursor <value> - Navigate pages: "next", "prev", "first" (or raw cursor string)`

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Internal event ID |
| `event.type` | string | Event type (error, default, transaction) |
| `groupID` | string \| null | Group (issue) ID |
| `eventID` | string | UUID-format event ID |
| `projectID` | string | Project ID |
| `message` | string | Event message |
| `title` | string | Event title |
| `location` | string \| null | Source location (file:line) |
| `culprit` | string \| null | Culprit function/module |
| `user` | object \| null | User context |
| `tags` | array | Event tags |
| `platform` | string \| null | Platform (python, javascript, etc.) |
| `dateCreated` | string | ISO 8601 creation timestamp |
| `crashFile` | string \| null | Crash file URL |
| `metadata` | object | Event metadata |

**Examples:**

```bash
# List recent events for an issue
sentry issue events FRONT-ABC

# List events for the most recent issue
sentry issue events @latest --limit 50

# Filter events by search query
sentry issue events FRONT-ABC --query "browser:Chrome"

# Show full event details
sentry issue events FRONT-ABC --full

# Limit results and filter by time period
sentry issue events FRONT-ABC --limit 50 --period 24h

# Fetch the next page
sentry issue events FRONT-ABC -c next

# Output as JSON
sentry issue events FRONT-ABC --json
```

### `sentry issue explain <issue...>`

Analyze one or more issues using Seer AI

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<issue...>` | One or more issue IDs |

**Flags:**
- `--force - Force new analysis even if one exists`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`

**Examples:**

```bash
# Analyze the root cause of an issue (may take a few minutes for new issues)
sentry issue explain 123456789

# Explain the most recent issue
sentry issue explain @latest

# Explain the most frequently occurring issue
sentry issue explain @most_frequent

# Use a short ID with an organization prefix
sentry issue explain my-org/MYPROJECT-ABC

# Analyze multiple issues in one invocation
sentry issue explain FRONT-ABC BACK-2

# Force a fresh analysis
sentry issue explain 123456789 --force

# Output root causes as JSON
sentry issue explain 123456789 --json
```

### `sentry issue plan <issue>`

Generate a solution plan using Seer AI

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<issue>` | Issue: @latest, @most_frequent, &lt;org&gt;/ID, &lt;org&gt;/&lt;project&gt;#ID, &lt;project&gt;-suffix, ID, or suffix |

**Flags:**
- `--force - Force new plan even if one exists`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`

**Examples:**

```bash
# Generate a fix plan (runs explain first if needed)
sentry issue plan 123456789

# Generate a fix plan for the most recent issue
sentry issue plan @latest

# Use a short ID with an organization prefix
sentry issue plan my-org/MYPROJECT-ABC

# Force a fresh plan even if one already exists
sentry issue plan 123456789 --force
```

### `sentry issue view <issue...>`

View details of one or more issues

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<issue...>` | One or more issue IDs |

**Flags:**
- `-w, --web - Open in browser`
- `--force - Allow --web to open more than 5 issues`
- `--spans <value> - Span tree depth limit (number, "all" for unlimited, "no" to disable) - (default: "3")`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Numeric issue ID |
| `shortId` | string | Human-readable short ID (e.g. PROJ-ABC) |
| `title` | string | Issue title |
| `culprit` | string \| null | Culprit string |
| `count` | string | Total event count |
| `userCount` | number | Number of affected users |
| `firstSeen` | string \| null | First occurrence (ISO 8601) |
| `lastSeen` | string \| null | Most recent occurrence (ISO 8601) |
| `level` | string | Severity level |
| `status` | string | Issue status |
| `permalink` | string | URL to the issue in Sentry |
| `project` | object | Project info |
| `metadata` | object | Issue metadata |
| `assignedTo` | object \| null | Assigned user or team |
| `priority` | string | Triage priority |
| `platform` | string | Platform |
| `substatus` | string \| null | Issue substatus |
| `isUnhandled` | boolean | Whether the issue is unhandled |
| `seerFixabilityScore` | number \| null | Seer AI fixability score (0-1) |
| `event` | unknown \| null | Latest event for the issue (full detail). Select named fields with `--fields event.id,event.title` to avoid pulling the whole payload; the `request` entry may include live session data. |
| `org` | string \| null | Organization slug |
| `replayIds` | array | Related Session Replay IDs |
| `trace` | object \| null | Trace context from the latest event's span tree |

**Examples:**

```bash
# View an issue
sentry issue view FRONT-ABC

# View the most recent issue
sentry issue view @latest

# View several issues (space-separated, not commas)
sentry issue view FRONT-ABC BACK-2

# Select an organization explicitly
sentry issue view my-org/FRONT-ABC

# Use a GitHub-style identifier (the "#" replaces the final slash)
sentry issue view my-org/my-project#FRONT-ABC

# Open issues in the browser (up to 5 tabs by default)
sentry issue view FRONT-ABC BACK-2 -w

# Allow more than 5 browser tabs
sentry issue view FRONT-ABC BACK-2 API-3 WEB-4 IOS-5 OPS-6 -w --force

# Full JSON (issue fields + latest event + trace/replay context)
sentry issue view FRONT-ABC --json

# Select top-level fields to keep output small
sentry issue view FRONT-ABC --json --fields shortId,title,culprit,count,userCount,permalink

# Select fields from the latest event instead of the whole event
sentry issue view FRONT-ABC --json --fields event.id,event.title,event.dateCreated

# Extract the request URL and method from the latest event
sentry issue view FRONT-ABC --json | jq '.event.entries[] | select(.type == "request") | .data | {url, method}'

# Extract the exception type and value from the latest event
sentry issue view FRONT-ABC --json | jq '.event.entries[] | select(.type == "exception") | .data.values[0] | {type, value}'
```

### `sentry issue resolve <issue>`

Mark an issue as resolved

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<issue>` | Issue: @latest, @most_frequent, &lt;org&gt;/ID, &lt;org&gt;/&lt;project&gt;#ID, &lt;project&gt;-suffix, ID, or suffix |

**Flags:**
- `-i, --in <value> - Resolve in a release, next release, or commit ('<version>' | '@next' | '@commit' | '@commit:<repo>@<sha>')`

**Examples:**

```bash
# Resolve immediately (no regression tracking)
sentry issue resolve CLI-G5

# Resolve in a specific release (newer releases flag regressions)
sentry issue resolve CLI-G5 --in 0.26.1

# Monorepo-style release versions work too
sentry issue resolve CLI-G5 --in spotlight@1.2.3

# Resolve in the next release
sentry issue resolve CLI-G5 --in @next

# Resolve in the current git HEAD (auto-detects the Sentry repo from your origin remote)
sentry issue resolve CLI-G5 --in @commit

# Resolve in an explicit commit and repo (no git inspection)
sentry issue resolve CLI-G5 --in @commit:getsentry/cli@abc123def

# Resolve an issue in an explicit organization
sentry issue resolve my-org/CLI-G5
```

### `sentry issue unresolve <issue>`

Reopen a resolved issue

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<issue>` | Issue: @latest, @most_frequent, &lt;org&gt;/ID, &lt;org&gt;/&lt;project&gt;#ID, &lt;project&gt;-suffix, ID, or suffix |

**Examples:**

```bash
# Reopen a resolved issue
sentry issue unresolve CLI-G5

# `reopen` is an alias for `unresolve`
sentry issue reopen CLI-G5

# Reopen an issue in an explicit organization
sentry issue unresolve my-org/CLI-G5
```

### `sentry issue archive <issue>`

Archive (ignore) an issue

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<issue>` | Issue: @latest, @most_frequent, &lt;org&gt;/ID, &lt;org&gt;/&lt;project&gt;#ID, &lt;project&gt;-suffix, ID, or suffix |

**Flags:**
- `-u, --until <value> - Condition for unarchival: forever, auto, 30m, 10x, 10u, 10x/5m, etc.`

**Examples:**

```bash
# Archive forever (fully silenced)
sentry issue archive CLI-G5

# Unarchive when Sentry detects a spike in event frequency
sentry issue archive CLI-G5 --until auto

# Archive for 1 hour
sentry issue archive CLI-G5 --until 1h

# Archive for 7 days
sentry issue archive CLI-G5 --until 7d

# Archive until a specific date
sentry issue archive CLI-G5 --until 2026-12-31

# Unarchive after 100 more events
sentry issue archive CLI-G5 --until 100x

# Unarchive after 10 more users are affected
sentry issue archive CLI-G5 --until 10u

# Unarchive after 100 events within 1 hour
sentry issue archive CLI-G5 --until 100x/1h

# Unarchive after 10 users within 1 day
sentry issue archive CLI-G5 --until 10u/1d

# Use the verbose condition form
sentry issue archive CLI-G5 --until 10events/2hours

# `ignore` is an alias for `archive`
sentry issue ignore CLI-G5 --until auto
```

### `sentry issue merge <issue...>`

Merge 2+ issues into a single canonical group

**Destructive:** This command deletes data or makes changes that can't easily be undone. Confirm with the user before running it.

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<issue...>` | Issue IDs to merge (2 or more required) |

**Flags:**
- `-i, --into <value> - Prefer this issue as the canonical parent (included in the merge if not already listed)`

**Examples:**

```bash
# Let Sentry pick the parent (typically the largest by event count)
sentry issue merge CLI-K9 CLI-15H CLI-15N

# Pin the canonical parent explicitly
sentry issue merge CLI-K9 CLI-15H CLI-15N --into CLI-K9

# Use organization-qualified IDs
sentry issue merge my-org/CLI-K9 my-org/CLI-15H --into my-org/CLI-K9

# Use project-alias IDs
sentry issue merge cli-k9 cli-15h --into cli-k9
```

### `sentry issue link <issue> <url>`

Link an existing external issue

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<issue>` | Issue: @latest, @most_frequent, &lt;org&gt;/ID, &lt;org&gt;/&lt;project&gt;#ID, &lt;project&gt;-suffix, ID, or suffix |
| `<url>` | URL of an existing tracker issue or GitHub pull request |

**Flags:**
- `--integration <value> - Native integration ID, when multiple installations match`
- `--app <value> - Sentry App slug (automatically detected for Linear URLs)`
- `-n, --dry-run - Show what would happen without making changes`
- `--field <value>... - Additional Sentry App link form field (name=value, repeatable)`

**Examples:**

```bash
# Link a GitHub issue
sentry issue link FRONT-123 https://github.com/example/app/issues/42

# Link a GitHub pull request
sentry issue link FRONT-123 https://github.com/example/app/pull/43

# Link a Jira issue in an explicit organization
sentry issue link my-org/FRONT-123 https://example.atlassian.net/browse/APP-42

# Link a Linear issue
sentry issue link FRONT-123 https://linear.app/example/issue/APP-42/fix-error

# Prepare the link without submitting it
sentry issue link my-org/FRONT-123 https://github.com/example/app/issues/42 --dry-run

# Output the result as JSON
sentry issue link my-org/FRONT-123 https://github.com/example/app/issues/42 --json
```

### `sentry issue unlink <issue> <url>`

Unlink an external issue

**Destructive:** This command deletes data or makes changes that can't easily be undone. Use `--dry-run` to preview the changes first. Confirm with the user before running it.

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<issue>` | Issue: @latest, @most_frequent, &lt;org&gt;/ID, &lt;org&gt;/&lt;project&gt;#ID, &lt;project&gt;-suffix, ID, or suffix |
| `<url>` | URL of an existing tracker issue or GitHub pull request |

**Flags:**
- `--integration <value> - Native integration ID, when multiple installations match`
- `--app <value> - Sentry App slug (automatically detected for Linear URLs)`
- `-y, --yes - Skip confirmation prompt`
- `-f, --force - Force the operation without confirmation`
- `-n, --dry-run - Show what would happen without making changes`

**Examples:**

```bash
# Unlink a GitHub issue (prompts for confirmation)
sentry issue unlink FRONT-123 https://github.com/example/app/issues/42

# Unlink a GitHub pull request without prompting
sentry issue unlink FRONT-123 https://github.com/example/app/pull/43 --yes

# Unlink a Jira issue in an explicit organization
sentry issue unlink my-org/FRONT-123 https://example.atlassian.net/browse/APP-42 --yes

# Check whether a link exists without removing it
sentry issue unlink FRONT-123 https://linear.app/example/issue/APP-42/fix-error --dry-run
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
