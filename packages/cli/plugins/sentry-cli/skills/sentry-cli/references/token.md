---
name: sentry-cli-token
version: 0.48.0-dev.0
description: Manage org auth tokens
requires:
  bins: ["sentry"]
  auth: true
---

# Token Commands

Manage org auth tokens

### `sentry token list [<org>]`

List org auth tokens

**Arguments:**

| Argument | Description |
|----------|-------------|
| `[<org>]` | Organization slug (auto-detected if omitted) |

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Token ID |
| `name` | string | Token name |
| `scopes` | array | Scopes granted to the token |
| `tokenLastCharacters` | string \| null | Last 4 characters of the token |
| `dateCreated` | string | Creation timestamp |
| `dateLastUsed` | string \| null | Last time the token was used, if ever |
| `projectLastUsedId` | string \| null | ID of the project the token was last used for |
| `token` | string | Full token value (create response only) |

**Examples:**

```bash
# List tokens (auto-detect org)
sentry token list

# List tokens in a specific org
sentry token list my-org

# Output as JSON
sentry token list --json
```

### `sentry token create <org/name>`

Create an org auth token

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<org/name>` | [&lt;org&gt;/]&lt;name&gt; - Name of the new token |

**Flags:**
- `-n, --dry-run - Show what would happen without making changes`

**Examples:**

```bash
# Create a token (auto-detect org)
sentry token create github-actions

# Create a token in a specific org
sentry token create my-org/github-actions

# Output as JSON, including the token value
sentry token create my-org/github-actions --json
```

### `sentry token delete [<org>/]<token-id>`

Revoke an org auth token

**Destructive:** This command deletes data or makes changes that can't easily be undone. Use `--dry-run` to preview the changes first. Confirm with the user before running it.

**Arguments:**

| Argument | Description |
|----------|-------------|
| `[<org>/]<token-id>` | [&lt;org&gt;/]&lt;token-id&gt; - Token to revoke |

**Flags:**
- `-y, --yes - Skip confirmation prompt`
- `-f, --force - Force the operation without confirmation`
- `-n, --dry-run - Show what would happen without making changes`

**Examples:**

```bash
# Revoke a token (auto-detect org)
sentry token delete 12345

# Preview revoking a token
sentry token delete my-org/12345 --dry-run

# Revoke without the confirmation prompt
sentry token delete my-org/12345 --yes
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
