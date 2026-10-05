---
name: sentry-cli-auth
version: 0.47.0-dev.0
description: Authenticate with Sentry
requires:
  bins: ["sentry"]
  auth: true
---

# Auth Commands

Authenticate with Sentry

### `sentry auth login`

Authenticate with Sentry

**Flags:**
- `--token <value> - Authenticate using an API token instead of OAuth`
- `--timeout <value> - Timeout for OAuth flow in seconds (default: 900) - (default: "900")`
- `--force - Re-authenticate without prompting`
- `--url <value> - Sentry instance URL to authenticate against (e.g. https://sentry.example.com). Required for self-hosted; defaults to SaaS (https://sentry.io).`
- `--read-only - Request only read-only OAuth scopes (project:read, org:read, event:read, member:read, team:read). Useful for handing tokens to AI agents or CI jobs that should not be able to mutate Sentry state.`
- `-s, --scope <value>... - Request specific OAuth scopes (repeatable, comma-separated). E.g. --scope project:read --scope org:read. Overrides the default scope set.`

**Examples:**

```bash
sentry auth

sentry auth --token YOUR_SENTRY_API_TOKEN

sentry auth --read-only

sentry auth --scope project:read --scope org:read
sentry auth --scope project:read,event:read

sentry auth --url https://sentry.example.com
SENTRY_URL=https://sentry.example.com sentry auth

sentry auth --token YOUR_TOKEN --url https://sentry.example.com
```

### `sentry auth logout`

Log out of Sentry

**Examples:**

```bash
sentry auth logout
```

### `sentry auth refresh`

Refresh your OAuth access token

**Flags:**
- `--force - Force refresh even if the access token is still valid`
- `--read-only - Re-authenticate with read-only OAuth scopes (project:read, org:read, event:read, member:read, team:read)`
- `-s, --scope <value>... - Re-authenticate with specific OAuth scopes (repeatable, comma-separated). E.g. --scope project:read --scope org:read`

**Examples:**

```bash
sentry auth refresh

# Refresh with read-only scopes
sentry auth refresh --read-only

# Refresh with specific scopes
sentry auth refresh --scope project:read --scope org:read
```

### `sentry auth status`

View authentication status

**Flags:**
- `--show-token - Show the stored token (masked by default)`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`

**Examples:**

```bash
sentry auth status

# Show the raw token
sentry auth status --show-token

# View current user
sentry auth whoami
```

### `sentry auth token`

Print the stored authentication token

**Examples:**

```bash
sentry auth token
```

### `sentry auth whoami`

Show the currently authenticated identity

**Flags:**
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
