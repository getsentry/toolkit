---
name: sentry-cli-replay
version: 0.48.0-dev.0
description: Search and inspect Session Replays
requires:
  bins: ["sentry"]
  auth: true
---

# Replay Commands

Search and inspect Session Replays

### `sentry replay list <org/project>`

List recent Session Replays

**Flags:**
- `-n, --limit <value> - Number of replays (1-1000) - (default: "25")`
- `-q, --query <value> - Search query (Sentry replay search syntax)`
- `-e, --environment <value>... - Filter by environment (repeatable, comma-separated)`
- `-s, --sort <value> - Sort by: date, oldest, duration, errors, activity, or a raw replay sort field - (default: "date")`
- `-t, --period <value> - Time range: "7d", "2024-01-01..2024-02-01", ">=2024-01-01" - (default: "7d")`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`
- `-c, --cursor <value> - Navigate pages: "next", "prev", "first" (or raw cursor string)`

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `activity` | number \| null | Replay activity score |
| `browser` | object \| null | Browser metadata |
| `count_dead_clicks` | number \| null | Dead click count |
| `count_errors` | number \| null | Associated error count |
| `count_infos` | number \| null | Info event count |
| `count_rage_clicks` | number \| null | Rage click count |
| `count_segments` | number \| null | Recording segment count |
| `count_urls` | number \| null | Visited URL count |
| `count_warnings` | number \| null | Warning event count |
| `device` | object \| null | Device metadata |
| `dist` | string \| null | Distribution |
| `duration` | number \| null | Replay duration in seconds |
| `environment` | string \| null | Environment |
| `error_ids` | array | Linked error IDs |
| `finished_at` | string \| null | Replay finish timestamp |
| `has_viewed` | boolean \| null | Whether the current user has viewed the replay |
| `id` | string | Replay ID |
| `info_ids` | array | Linked info event IDs |
| `is_archived` | boolean \| null | Archived flag |
| `os` | object \| null | Operating system metadata |
| `ota_updates` | object \| null | OTA update metadata |
| `platform` | string \| null | Platform |
| `project_id` | string \| null | Numeric project ID |
| `releases` | array | Associated releases |
| `sdk` | object \| null | SDK metadata |
| `started_at` | string \| null | Replay start timestamp |
| `tags` | object | Replay tags |
| `trace_ids` | array | Linked trace IDs |
| `urls` | array | Visited URLs |
| `user` | object \| null | User metadata |
| `warning_ids` | array | Linked warning event IDs |

**Examples:**

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

### `sentry replay view <replay-id-or-url...>`

View a Session Replay

**Flags:**
- `-w, --web - Open in browser`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `activity` | array | Summarized replay activity |
| `browser` | object \| null | Browser metadata |
| `count_dead_clicks` | number \| null | Dead click count |
| `count_errors` | number \| null | Associated error count |
| `count_infos` | number \| null | Info event count |
| `count_rage_clicks` | number \| null | Rage click count |
| `count_segments` | number \| null | Recording segment count |
| `count_urls` | number \| null | Visited URL count |
| `count_warnings` | number \| null | Warning event count |
| `device` | object \| null | Device metadata |
| `dist` | string \| null | Distribution |
| `duration` | number \| null | Replay duration in seconds |
| `environment` | string \| null | Environment |
| `error_ids` | array | Linked error IDs |
| `finished_at` | string \| null | Replay finish timestamp |
| `has_viewed` | boolean \| null | Whether the current user has viewed the replay |
| `id` | string | Replay ID |
| `info_ids` | array | Linked info event IDs |
| `is_archived` | boolean \| null | Archived flag |
| `os` | object \| null | Operating system metadata |
| `ota_updates` | object \| null | OTA update metadata |
| `platform` | string \| null | Platform |
| `project_id` | string \| null | Numeric project ID |
| `releases` | array | Associated releases |
| `sdk` | object \| null | SDK metadata |
| `started_at` | string \| null | Replay start timestamp |
| `tags` | object | Replay tags |
| `trace_ids` | array | Linked trace IDs |
| `urls` | array | Visited URLs |
| `user` | object \| null | User metadata |
| `warning_ids` | array | Linked warning event IDs |
| `clicks` | array | Replay click summaries |
| `replay_type` | string \| null | Replay type |
| `org` | string | Organization slug |
| `relatedIssues` | array | Replay-related issues |
| `relatedTraces` | array | Replay-related traces |

**Examples:**

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

### `sentry replay download <replay-id-or-url...>`

Download a Session Replay as rrweb JSON

**Flags:**
- `-o, --output <value> - Output path (default: <replay-id>.rrweb.json in the current directory)`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`

**Examples:**

```bash
# Download a replay as rrweb JSON to ./<replay-id>.rrweb.json
sentry replay download my-org/346789a703f6454384f1de473b8b9fcc

# Choose where the file goes
sentry replay download my-org/346789a703f6454384f1de473b8b9fcc --output ./replay.json

# Download from a replay URL
sentry replay download https://sentry.io/organizations/my-org/explore/replays/346789a703f6454384f1de473b8b9fcc/
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
