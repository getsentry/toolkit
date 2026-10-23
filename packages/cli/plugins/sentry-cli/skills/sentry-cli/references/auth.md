---
name: sentry-cli-auth
version: 0.48.0-dev.0
description: Authenticate with Sentry
requires:
  bins: ["sentry"]
  auth: true
---

# Auth Commands

Authenticate with Sentry

### `sentry auth list`

List stored accounts

**Examples:**

```bash
# Show stored accounts (* marks the active one)
sentry auth list
```

### `sentry auth login [<email>]`

Authenticate with Sentry

**Flags:**
- `--token <value> - Authenticate using an API token instead of OAuth`
- `--timeout <value> - Timeout for OAuth flow in seconds (default: 900) - (default: "900")`
- `--force - Replace the stored login for this server without prompting, instead of adding another account`
- `--url <value> - Sentry instance URL to authenticate against (e.g. https://sentry.example.com). Required for self-hosted; defaults to SaaS (https://sentry.io).`
- `--read-only - Request only read-only OAuth scopes (project:read, org:read, event:read, member:read, team:read). Useful for handing tokens to AI agents or CI jobs that should not be able to mutate Sentry state.`
- `-s, --scope <value>... - Request specific OAuth scopes (repeatable, comma-separated). E.g. --scope project:read --scope org:read. Overrides the default scope set.`

**Examples:**

```bash
# Log in with OAuth (device flow)
sentry auth login

# Log in with an API token
sentry auth login --token YOUR_SENTRY_API_TOKEN

# Request only read-only scopes
sentry auth login --read-only

# Request specific scopes (repeatable or comma-separated)
sentry auth login --scope project:read --scope org:read

# Log in to a self-hosted instance
sentry auth login --url https://sentry.example.com

# Log in to a self-hosted instance with a token
sentry auth login --token YOUR_TOKEN --url https://sentry.example.com

# Add (or log in again to) a specific account without prompting
sentry auth login jane@example.com

# Add an account on a specific server
sentry auth login jane@example.com --url https://sentry.example.com

# Same as --url, using the account notation
sentry auth login jane@example.com:sentry.example.com
```

### `sentry auth logout <account...>`

Log out of Sentry

**Flags:**
- `--url <value> - Only match accounts on this server (disambiguates the same email on several servers)`

**Examples:**

```bash
# Log out of the active account (the most recently used other account becomes active)
sentry auth logout

# Log out of a specific account
sentry auth logout jane@example.com

# Log out of several accounts (space- or comma-separated)
sentry auth logout jane@example.com,jane@personal.dev

# Pick the account on one server when the same email is stored twice
sentry auth logout jane@example.com --url https://sentry.example.com

# Log out of every stored account
sentry auth logout all
```

### `sentry auth refresh`

Refresh your OAuth access token

**Flags:**
- `--force - Force refresh even if the access token is still valid`
- `--read-only - Re-authenticate with read-only OAuth scopes (project:read, org:read, event:read, member:read, team:read)`
- `-s, --scope <value>... - Re-authenticate with specific OAuth scopes (repeatable, comma-separated). E.g. --scope project:read --scope org:read`

**Examples:**

```bash
# Refresh the OAuth access token when it is close to expiring
sentry auth refresh

# Refresh even if the token is still valid
sentry auth refresh --force

# Re-authenticate with specific scopes
sentry auth refresh --scope project:read --scope org:read

# Re-authenticate with read-only scopes
sentry auth refresh --read-only

# Output the refresh result as JSON
sentry auth refresh --json
```

### `sentry auth status`

View authentication status

**Flags:**
- `--show-token - Show the stored token (masked by default)`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`

**Examples:**

```bash
# Check authentication status
sentry auth status

# Include the raw token
sentry auth status --show-token
```

### `sentry auth switch [<account>]`

Switch the active account

**Flags:**
- `--url <value> - Only consider accounts on this server (disambiguates the same email on several servers)`

**Examples:**

```bash
# Pick the active account from a searchable list
sentry auth switch

# Switch to a specific account
sentry auth switch jane@example.com

# Pick the account on one server when the same email is stored twice
sentry auth switch jane@example.com --url https://sentry.example.com
```

### `sentry auth token`

Print the stored authentication token

**Examples:**

```bash
# Print the stored auth token
sentry auth token
```

### `sentry auth whoami`

Show the currently authenticated identity

**Flags:**
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`

**Examples:**

```bash
# Show the current user
sentry auth whoami
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
