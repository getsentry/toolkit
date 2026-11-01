---
name: sentry-cli-feedback
version: 0.48.0-dev.0
description: Manage User Feedback
requires:
  bins: ["sentry"]
  auth: true
---

# Feedback Commands

Manage User Feedback

### `sentry feedback list [<org/project>]`

List and search User Feedback

**Arguments:**

| Argument | Description |
|----------|-------------|
| `[<org/project>]` | &lt;org&gt;/ (all projects), &lt;org&gt;/&lt;project&gt;, or &lt;project&gt; (search) |

**Flags:**
- `--status <value> - Mailbox: unresolved, resolved, spam, or all - (default: "unresolved")`
- `-n, --limit <value> - Number of feedback items (1-1000) - (default: "25")`
- `-q, --query <value> - Search query (Sentry issue search syntax)`
- `-t, --period <value> - Time range: "7d", "2024-01-01..2024-02-01", ">=2024-01-01" - (default: "14d")`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`
- `-c, --cursor <value> - Navigate pages: "next", "prev", "first" (or raw cursor string)`

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
| `metadata` | object | Feedback metadata |
| `assignedTo` | object \| null | Assigned user or team |
| `priority` | string | Triage priority |
| `platform` | string | Platform |
| `substatus` | string \| null | Issue substatus |
| `isUnhandled` | boolean | Whether the issue is unhandled |
| `seerFixabilityScore` | number \| null | Seer AI fixability score (0-1) |
| `issueCategory` | string | Issue category discriminator |
| `issueType` | string | Issue type discriminator |
| `hasSeen` | boolean | Whether the feedback has been read |
| `latestEventHasAttachments` | boolean | Whether the latest event has attachments |

**Examples:**

```bash
# List Feedback (organization auto-detected)
sentry feedback list

# List Feedback for one project
sentry feedback list my-org/frontend

# List Feedback across every project in an organization
sentry feedback list my-org/

# Search for a project across accessible organizations
sentry feedback list frontend

# Show resolved Feedback
sentry feedback list my-org/frontend --status resolved

# Show the spam mailbox
sentry feedback list my-org/frontend --status spam

# Show every status over the last 90 days
sentry feedback list my-org/frontend --status all --period 90d

# Search Feedback messages
sentry feedback list my-org/frontend --query "message:*checkout*"
```

### `sentry feedback view <feedback>`

View a User Feedback item

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<feedback>` | Feedback: @latest, numeric ID, short ID, &lt;org&gt;/SHORT-ID, or &lt;org&gt;/&lt;project&gt;/&lt;suffix&gt; |

**Flags:**
- `-w, --web - Open in browser`
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
| `metadata` | object | Feedback metadata |
| `assignedTo` | object \| null | Assigned user or team |
| `priority` | string | Triage priority |
| `platform` | string | Platform |
| `substatus` | string \| null | Issue substatus |
| `isUnhandled` | boolean | Whether the issue is unhandled |
| `seerFixabilityScore` | number \| null | Seer AI fixability score (0-1) |
| `issueCategory` | string | Issue category discriminator |
| `issueType` | string | Issue type discriminator |
| `hasSeen` | boolean | Whether the feedback has been read |
| `latestEventHasAttachments` | boolean | Whether the latest event has attachments |
| `org` | string \| null | Organization slug |
| `event` | unknown \| null | Latest feedback event |
| `replayIds` | array | Related Session Replay IDs |
| `attachments` | array | Attachments on the latest feedback event |

**Examples:**

```bash
# View the most recent unresolved Feedback
sentry feedback view @latest

# Most recent unresolved Feedback in an explicit organization
sentry feedback view my-org/@latest

# View by short ID
sentry feedback view FRONTEND-2SDJ

# View by numeric ID
sentry feedback view 5146636313

# View in an explicit organization
sentry feedback view my-org/FRONTEND-2SDJ

# `view` is the default command
sentry feedback my-org/FRONTEND-2SDJ

# Open the Feedback item in Sentry
sentry feedback view my-org/FRONTEND-2SDJ --web
```

### `sentry feedback resolve <feedback>`

Mark User Feedback as resolved

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<feedback>` | Feedback: @latest, numeric ID, short ID, &lt;org&gt;/SHORT-ID, or &lt;org&gt;/&lt;project&gt;/&lt;suffix&gt; |

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
| `metadata` | object | Feedback metadata |
| `assignedTo` | object \| null | Assigned user or team |
| `priority` | string | Triage priority |
| `platform` | string | Platform |
| `substatus` | string \| null | Issue substatus |
| `isUnhandled` | boolean | Whether the issue is unhandled |
| `seerFixabilityScore` | number \| null | Seer AI fixability score (0-1) |
| `issueCategory` | string | Issue category discriminator |
| `issueType` | string | Issue type discriminator |
| `hasSeen` | boolean | Whether the feedback has been read |
| `latestEventHasAttachments` | boolean | Whether the latest event has attachments |

**Examples:**

```bash
# Resolve a Feedback item (organization auto-detected)
sentry feedback resolve FRONTEND-2SDJ

# Resolve a Feedback item in an explicit organization
sentry feedback resolve my-org/FRONTEND-2SDJ

# Resolve the most recently active unresolved Feedback
sentry feedback resolve my-org/@latest

# Return selected fields from the updated Feedback
sentry feedback resolve my-org/FRONTEND-2SDJ --json --fields id,shortId,status
```

### `sentry feedback unresolve <feedback>`

Return User Feedback to the inbox

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<feedback>` | Feedback: @latest, numeric ID, short ID, &lt;org&gt;/SHORT-ID, or &lt;org&gt;/&lt;project&gt;/&lt;suffix&gt; |

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
| `metadata` | object | Feedback metadata |
| `assignedTo` | object \| null | Assigned user or team |
| `priority` | string | Triage priority |
| `platform` | string | Platform |
| `substatus` | string \| null | Issue substatus |
| `isUnhandled` | boolean | Whether the issue is unhandled |
| `seerFixabilityScore` | number \| null | Seer AI fixability score (0-1) |
| `issueCategory` | string | Issue category discriminator |
| `issueType` | string | Issue type discriminator |
| `hasSeen` | boolean | Whether the feedback has been read |
| `latestEventHasAttachments` | boolean | Whether the latest event has attachments |

**Examples:**

```bash
# Reopen a Feedback item, or return it from spam to the inbox
sentry feedback unresolve FRONTEND-2SDJ

# Reopen by numeric ID
sentry feedback unresolve 5146636313

# `reopen` is an alias for `unresolve`
sentry feedback reopen FRONTEND-2SDJ

# Specify an organization explicitly
sentry feedback unresolve my-org/FRONTEND-2SDJ

# Return selected fields from the updated Feedback
sentry feedback unresolve FRONTEND-2SDJ --json --fields id,shortId,status
```

### `sentry feedback spam <feedback>`

Mark User Feedback as spam

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<feedback>` | Feedback: @latest, numeric ID, short ID, &lt;org&gt;/SHORT-ID, or &lt;org&gt;/&lt;project&gt;/&lt;suffix&gt; |

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
| `metadata` | object | Feedback metadata |
| `assignedTo` | object \| null | Assigned user or team |
| `priority` | string | Triage priority |
| `platform` | string | Platform |
| `substatus` | string \| null | Issue substatus |
| `isUnhandled` | boolean | Whether the issue is unhandled |
| `seerFixabilityScore` | number \| null | Seer AI fixability score (0-1) |
| `issueCategory` | string | Issue category discriminator |
| `issueType` | string | Issue type discriminator |
| `hasSeen` | boolean | Whether the feedback has been read |
| `latestEventHasAttachments` | boolean | Whether the latest event has attachments |

**Examples:**

```bash
# Move a Feedback item to the spam mailbox
sentry feedback spam FRONTEND-2SDJ

# Mark as spam by numeric ID
sentry feedback spam 5146636313

# Specify an organization explicitly
sentry feedback spam my-org/FRONTEND-2SDJ

# Return selected fields from the updated Feedback
sentry feedback spam FRONTEND-2SDJ --json --fields id,shortId,status
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
