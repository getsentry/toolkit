---
name: sentry-cli-sourcemap
version: 0.47.0-dev.0
description: Manage sourcemaps
requires:
  bins: ["sentry"]
  auth: true
---

# Sourcemap Commands

Manage sourcemaps

### `sentry sourcemap inject <directory>`

Inject debug IDs into JavaScript files and sourcemaps

**Flags:**
- `--ext <value> - Comma-separated file extensions to process (default: .js,.cjs,.mjs)`
- `--ignore <value> - Comma-separated glob patterns to exclude (gitignore-style)`
- `--ignore-file <value> - Path to a file with gitignore-style patterns to exclude`
- `--dry-run - Show what would be modified without writing`
- `--allow-empty - Exit successfully when no JS + sourcemap pairs are found (default: error out to catch silent build misconfigurations)`

**Examples:**

```bash
# Inject debug IDs into all JS files in dist/
sentry sourcemap inject ./dist

# Preview changes without writing
sentry sourcemap inject ./dist --dry-run

# Only process specific extensions
sentry sourcemap inject ./build --ext .js,.mjs
```

### `sentry sourcemap upload <directory>`

Upload sourcemaps to Sentry

**Flags:**
- `--release <value> - Release version to associate with the upload`
- `--dist <value> - Distribution identifier to disambiguate builds within a release`
- `--url-prefix <value> - URL prefix for uploaded files (default: ~/) - (default: "~/")`
- `--ext <value> - Comma-separated file extensions to process (default: .js,.cjs,.mjs)`
- `--ignore <value> - Comma-separated glob patterns to exclude (gitignore-style)`
- `--ignore-file <value> - Path to a file with gitignore-style patterns to exclude`
- `--strip-prefix <value> - Strip a prefix from uploaded file paths (e.g. 'build/')`
- `--strip-common-prefix - Automatically strip the longest common path prefix from all files`
- `--no-rewrite - Upload files as-is without injecting debug IDs`
- `--allow-empty - Exit successfully when no JS + sourcemap pairs are found (default: error out to catch silent build misconfigurations)`

**Examples:**

```bash
# Upload sourcemaps from dist/
sentry sourcemap upload ./dist

# Associate with a release
sentry sourcemap upload ./dist --release 1.0.0

# Set a custom URL prefix
sentry sourcemap upload ./dist --url-prefix '~/static/js/'

sentry sourcemap upload ./dist --allow-empty
```

### `sentry sourcemap resolve <directory>`

Resolve and report sourcemap linkage for JavaScript files

**Flags:**
- `--ext <value> - Comma-separated file extensions to process (default: .js,.cjs,.mjs)`
- `--ignore <value> - Comma-separated glob patterns to exclude (gitignore-style)`
- `--ignore-file <value> - Path to a file with gitignore-style patterns to exclude`

**Examples:**

```bash
# Report how each JS file's sourcemap resolves and whether a debug ID
# has been injected (read-only — never modifies files)
sentry sourcemap resolve ./dist

# Machine-readable output
sentry sourcemap resolve ./dist --json
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
