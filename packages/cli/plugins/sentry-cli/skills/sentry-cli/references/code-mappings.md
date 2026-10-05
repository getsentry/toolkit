---
name: sentry-cli-code-mappings
version: 0.47.0-dev.0
description: Manage code mappings for stack trace linking
requires:
  bins: ["sentry"]
  auth: true
---

# Code-mappings Commands

Manage code mappings for stack trace linking

### `sentry code-mappings upload <path>`

Upload code mappings for stack trace linking

**Flags:**
- `--repo <value> - Repository name (e.g., owner/repo). Auto-detected from git remote if omitted.`
- `--default-branch <value> - Default branch name. Auto-detected from git remote HEAD if omitted.`

**Examples:**

```bash
# Upload code mappings from a JSON file
sentry code-mappings upload mappings.json

# Specify repository explicitly
sentry code-mappings upload mappings.json --repo owner/repo

# Specify repository and default branch
sentry code-mappings upload mappings.json --repo owner/repo --default-branch develop

# Output as JSON
sentry code-mappings upload mappings.json --json
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
