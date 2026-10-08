---
name: sentry-cli-build
version: 0.48.0-dev.0
description: Manage mobile build artifacts
requires:
  bins: ["sentry"]
  auth: true
---

# Build Commands

Manage mobile build artifacts

### `sentry build upload <path...>`

Upload builds to a project

**Flags:**
- `--build-configuration <value> - Build configuration for the upload (defaults to the current version)`
- `--release-notes <value> - Release notes for the build`
- `--install-group <value>... - Install group(s) for this build (repeatable); builds sharing a group show updates for each other`
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

### `sentry build download <build-id>`

Download a build artifact

**Flags:**
- `-o, --output <value> - Output path (default: preprod_artifact_<build-id>.<ext> in the current directory)`

**Examples:**

```bash
# Upload an Android build (APK or AAB) for size analysis
sentry build upload ./app-release.apk

# Upload an iOS build (XCArchive directory or IPA)
sentry build upload ./MyApp.xcarchive
sentry build upload ./MyApp.ipa

# Upload with a build configuration and release notes
sentry build upload ./app.aab --build-configuration Release --release-notes "Nightly"

# Tag a build with install groups (repeatable)
sentry build upload ./app.aab --install-group qa --install-group beta

# Attach explicit git metadata (otherwise auto-collected in CI)
sentry build upload ./app.aab --head-sha "$GIT_SHA" --pr-number 42 --base-ref main

# Download a build artifact by ID
sentry build download 1234567890

# Download to a specific path
sentry build download 1234567890 --output ./app.ipa

# Output the result as JSON
sentry build download 1234567890 --json
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
