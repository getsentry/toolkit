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

**Examples:**

```bash
# List releases (project auto-detected)
sentry release list

# List all releases in an organization
sentry release list my-org/

# List releases for one project
sentry release list my-org/my-project

# Sort by crash-free sessions
sentry release list --sort cfs

# Filter by environment
sentry release list --environment production

# Show the last 7 days of health data
sentry release list --period 7d

# Output as JSON
sentry release list --json
```

### `sentry release view <org/version>`

View release details with health metrics

**Flags:**
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`

**Examples:**

```bash
# View release details
sentry release view 1.0.0

# View a release in an explicit organization
sentry release view my-org/1.0.0

# View a release whose version contains a package name
sentry release view "sentry-cli@0.24.0"

# Output as JSON
sentry release view 1.0.0 --json
```

### `sentry release create <org/version>`

Create a release

**Flags:**
- `-p, --project <value> - Associate with project(s), comma-separated`
- `--finalize - Immediately finalize the release (set dateReleased)`
- `--ref <value> - Git ref (branch or tag name)`
- `--url <value> - URL to the release source`
- `-n, --dry-run - Show what would happen without making changes`

**Examples:**

```bash
# Create a release
sentry release create 1.0.0

# Create a release in an explicit organization
sentry release create my-org/1.0.0

# Create and finalize a release
sentry release create 1.0.0 --finalize

# Create a release for specific projects
sentry release create 1.0.0 --project proj-a,proj-b

# Create a release from a proposed version
sentry release create $(sentry release propose-version)

# Set the release ref and URL
sentry release create 1.0.0 --ref main --url https://github.com/org/repo/releases/tag/1.0.0

# Preview without creating
sentry release create 1.0.0 --dry-run
```

### `sentry release finalize <org/version>`

Finalize a release

**Flags:**
- `--released <value> - Custom release timestamp (ISO 8601). Defaults to now.`
- `--url <value> - URL for the release`
- `-n, --dry-run - Show what would happen without making changes`

**Examples:**

```bash
# Finalize a release
sentry release finalize 1.0.0

# Finalize a release in an explicit organization
sentry release finalize my-org/1.0.0

# Set a custom release timestamp
sentry release finalize 1.0.0 --released 2025-01-01T00:00:00Z

# Preview without finalizing
sentry release finalize 1.0.0 --dry-run
```

### `sentry release delete <org/version>`

Delete a release

**Flags:**
- `-y, --yes - Skip confirmation prompt`
- `-f, --force - Force the operation without confirmation`
- `-n, --dry-run - Show what would happen without making changes`

**Examples:**

```bash
# Delete a release (prompts for confirmation)
sentry release delete my-org/1.0.0

# Skip confirmation
sentry release delete my-org/1.0.0 --yes

# Preview without deleting
sentry release delete my-org/1.0.0 --dry-run
```

### `sentry release archive <org/version>`

Archive a release

**Flags:**
- `-n, --dry-run - Show what would happen without making changes`

**Examples:**

```bash
# Archive a release (hide it from the default list, but keep it)
sentry release archive 1.0.0

# Archive a release in an explicit organization
sentry release archive my-org/1.0.0

# Preview without archiving
sentry release archive my-org/1.0.0 --dry-run
```

### `sentry release restore <org/version>`

Restore an archived release

**Flags:**
- `-n, --dry-run - Show what would happen without making changes`

**Examples:**

```bash
# Restore a previously archived release
sentry release restore 1.0.0

# Restore a release in an explicit organization
sentry release restore my-org/1.0.0

# Preview without restoring
sentry release restore 1.0.0 --dry-run
```

### `sentry release deploy <org/version> <environment> [<name>]`

Create a deploy for a release

**Flags:**
- `--url <value> - URL for the deploy`
- `--started <value> - Deploy start time (ISO 8601)`
- `--finished <value> - Deploy finish time (ISO 8601)`
- `-t, --time <value> - Deploy duration in seconds (sets started = now - time, finished = now)`
- `-n, --dry-run - Show what would happen without making changes`

**Examples:**

```bash
# Create a deploy
sentry release deploy 1.0.0 production

# Create a named deploy in an explicit organization
sentry release deploy my-org/1.0.0 staging "Deploy #42"

# Attach a deploy URL
sentry release deploy 1.0.0 production --url https://example.com

# Record a deploy duration in seconds
sentry release deploy 1.0.0 production --time 120

# Preview without creating
sentry release deploy 1.0.0 production --dry-run
```

### `sentry release deploys <org/version>`

List deploys for a release

**Examples:**

```bash
# List deploys for a release
sentry release deploys 1.0.0

# List deploys for a release in an explicit organization
sentry release deploys my-org/1.0.0

# Output as JSON
sentry release deploys 1.0.0 --json
```

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

**Examples:**

```bash
# Associate commits using the repository integration
sentry release set-commits 1.0.0 --auto

# Set commits from local git history
sentry release set-commits my-org/1.0.0 --local

# Read up to 50 local commits
sentry release set-commits 1.0.0 --local --initial-depth 50

# Only include commits that touch specific paths
sentry release set-commits 1.0.0 --path apps/mobile,packages/shared-ui

# Read local commits since a previous release tag
sentry release set-commits 1.0.0 --from v0.9.0

# Set an explicit commit range
sentry release set-commits 1.0.0 --commit owner/repo@abc123..def456

# Clear the release's commits
sentry release set-commits 1.0.0 --clear
```

### `sentry release propose-version`

Propose a release version

**Examples:**

```bash
# Propose a version from git HEAD
sentry release propose-version

# Output as JSON
sentry release propose-version --json
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
