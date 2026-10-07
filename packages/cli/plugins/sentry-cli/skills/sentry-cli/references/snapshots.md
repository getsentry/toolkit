---
name: sentry-cli-snapshots
version: 0.48.0-dev.0
description: Manage and compare snapshots
requires:
  bins: ["sentry"]
  auth: true
---

# Snapshots Commands

Manage and compare snapshots

### `sentry snapshots diff <base-dir> <head-dir>`

Compare two directories of snapshot images

**Flags:**
- `-o, --output <value> - Directory for diff mask images (default: ./diff-output/)`
- `--threshold <value> - Pixel color difference threshold (0.0-1.0) - (default: "0.01")`
- `--no-antialiasing - Disable antialiasing detection`
- `--fail-on-diff - Exit non-zero if any diffs (changed/added/removed/errored) are found`
- `--selective - Treat images missing from head as skipped instead of removed`

### `sentry snapshots download`

Download baseline snapshot images

**Flags:**
- `--app-id <value> - App identifier (e.g. my-app) to resolve the latest baseline; mutually exclusive with --snapshot-id`
- `--snapshot-id <value> - Direct snapshot artifact ID; mutually exclusive with --app-id`
- `--branch <value> - Git branch filter (only with --app-id)`
- `-o, --output <value> - Directory for extracted images (default: ./snapshots-base/)`

### `sentry snapshots upload <path>`

Upload snapshots to a project

**Flags:**
- `--app-id <value> - The application identifier`
- `--diff-threshold <value> - Only report an image as changed when its difference exceeds this fraction (0.0–1.0, e.g. 0.01 = 1%)`
- `--selective - This upload contains only a subset of images (removals/renames won't be detected on PRs)`
- `--all-image-file-names <value> - Comma-separated list of all image names in the full suite (for selective uploads; implies --selective)`
- `--all-image-file-names-file <value> - Path to a file listing all image names, one per line (for selective uploads; implies --selective)`
- `--head-sha <value> - VCS commit SHA (defaults to the current commit)`
- `--base-sha <value> - VCS base commit SHA (defaults to the merge-base with the base ref)`
- `--vcs-provider <value> - VCS provider (defaults to the current remote's provider)`
- `--head-repo-name <value> - Head repository name, e.g. owner/repo (defaults to the current)`
- `--base-repo-name <value> - Base repository name, e.g. owner/repo (for forks)`
- `--head-ref <value> - Head branch/reference (defaults to the current branch)`
- `--base-ref <value> - Base branch/reference (defaults to the merge-base tracking ref)`
- `--pr-number <value> - Pull request number (auto-detected in pull_request GitHub Actions runs)`
- `--force-git-metadata - Force collecting git metadata even outside CI (conflicts with --no-git-metadata)`
- `--no-git-metadata - Disable automatic git metadata collection`

**Examples:**

```bash
# Upload a folder of screenshots as a snapshot for an app
sentry snapshots upload ./screenshots --app-id com.example.app

# Upload only a subset of images (removals/renames not inferred on PRs)
sentry snapshots upload ./screenshots --app-id my-app --selective

# Only flag images that differ by more than 1%
sentry snapshots upload ./screenshots --app-id my-app --diff-threshold 0.01

# Compare two directories of snapshot images locally
sentry snapshots diff ./baseline ./head

# Fail (non-zero exit) if any images changed, with a custom threshold
sentry snapshots diff ./baseline ./head --fail-on-diff --threshold 0.02

# Download a specific baseline snapshot by ID
sentry snapshots download --snapshot-id 1234567890

# Download the latest baseline for an app, filtered by branch
sentry snapshots download --app-id my-app --branch main

# Extract images to a specific directory
sentry snapshots download --app-id my-app --output ./baseline/
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
