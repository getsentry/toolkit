---
name: sentry-cli-release
version: 0.48.0-dev.0
description: Work with Sentry releases
requires:
  bins: ["sentry"]
  auth: true
---

# Release Commands

Work with Sentry releases

### `sentry release list [<org/project>]`

List releases with adoption and health metrics

**Flags:**
- `-n, --limit <value> - Maximum number of releases to list - (default: "25")`
- `-s, --sort <value> - Sort: date, sessions, users, crash_free_sessions (cfs), crash_free_users (cfu) - (default: "date")`
- `-e, --environment <value>... - Filter by environment (repeatable, comma-separated)`
- `-t, --period <value> - Health stats period (e.g., 24h, 7d, 14d, 90d) - (default: "90d")`
- `--status <value> - Filter by status: open (default) or archived - (default: "open")`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`
- `-c, --cursor <value> - Navigate pages: "next", "prev", "first" (or raw cursor string)`

### `sentry release view <org/version>`

View release details with health metrics

**Flags:**
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`

### `sentry release create <org/version>`

Create a release

**Flags:**
- `-p, --project <value> - Associate with project(s), comma-separated`
- `--finalize - Immediately finalize the release (set dateReleased)`
- `--ref <value> - Git ref (branch or tag name)`
- `--url <value> - URL to the release source`
- `-n, --dry-run - Show what would happen without making changes`

### `sentry release finalize <org/version>`

Finalize a release

**Flags:**
- `--released <value> - Custom release timestamp (ISO 8601). Defaults to now.`
- `--url <value> - URL for the release`
- `-n, --dry-run - Show what would happen without making changes`

### `sentry release delete <org/version>`

Delete a release

**Flags:**
- `-y, --yes - Skip confirmation prompt`
- `-f, --force - Force the operation without confirmation`
- `-n, --dry-run - Show what would happen without making changes`

### `sentry release archive <org/version>`

Archive a release

**Flags:**
- `-n, --dry-run - Show what would happen without making changes`

### `sentry release restore <org/version>`

Restore an archived release

**Flags:**
- `-n, --dry-run - Show what would happen without making changes`

### `sentry release deploy <org/version> <environment> [<name>]`

Create a deploy for a release

**Flags:**
- `--url <value> - URL for the deploy`
- `--started <value> - Deploy start time (ISO 8601)`
- `--finished <value> - Deploy finish time (ISO 8601)`
- `-t, --time <value> - Deploy duration in seconds (sets started = now - time, finished = now)`
- `-n, --dry-run - Show what would happen without making changes`

### `sentry release deploys <org/version>`

List deploys for a release

### `sentry release set-commits <org/version>`

Set commits for a release

**Flags:**
- `--auto - Auto-discover commits via repository integration (needs local git checkout)`
- `--local - Read commits from local git history`
- `--clear - Clear all commits from the release`
- `--commit <value> - Explicit commit as REPO@SHA or REPO@PREV..SHA (comma-separated)`
- `--path <value> - Filter commits to these paths (comma-separated). Implies --local.`
- `--from <value> - Read the local range <ref>..HEAD (e.g. previous release tag). Implies --local.`
- `--initial-depth <value> - Number of commits to read with --local - (default: "20")`

### `sentry release propose-version`

Propose a release version

**Examples:**

```bash
# List releases (auto-detect org)
sentry release list

# List releases in a specific org
sentry release list my-org/

# View release details
sentry release view 1.0.0
sentry release view my-org/1.0.0

# Create and finalize a release
sentry release create 1.0.0 --finalize

# Create a release, then finalize separately
sentry release create 1.0.0
sentry release set-commits 1.0.0 --auto
sentry release finalize 1.0.0

# Set commits from local git history
sentry release set-commits 1.0.0 --local

# Create a deploy
sentry release deploy 1.0.0 production
sentry release deploy 1.0.0 staging "Deploy #42"

# Propose a version from git HEAD
sentry release create $(sentry release propose-version)

# List deploys for a release
sentry release deploys 1.0.0
sentry release deploys my-org/1.0.0

# Archive a release (hide it from the default list, but keep it)
sentry release archive 1.0.0
sentry release archive my-org/1.0.0 --dry-run   # Preview without archiving

# Restore a previously archived release
sentry release restore 1.0.0
sentry release restore my-org/1.0.0

# Delete a release
sentry release delete my-org/1.0.0
sentry release delete my-org/1.0.0 --yes        # Skip confirmation
sentry release delete my-org/1.0.0 --dry-run    # Preview without deleting

# Output as JSON
sentry release list --json
sentry release view 1.0.0 --json

# Full release workflow with explicit org
sentry release create my-org/1.0.0 --project my-project
sentry release set-commits my-org/1.0.0 --auto
sentry release finalize my-org/1.0.0
sentry release deploy my-org/1.0.0 production
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
