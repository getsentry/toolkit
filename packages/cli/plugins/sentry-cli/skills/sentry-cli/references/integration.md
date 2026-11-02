---
name: sentry-cli-integration
version: 0.48.0-dev.0
description: Work with Sentry integrations
requires:
  bins: ["sentry"]
  auth: true
---

# Integration Commands

Work with Sentry integrations

### `sentry integration list [<org/project>]`

List installed integrations

**Arguments:**

| Argument | Description |
|----------|-------------|
| `[<org/project>]` | &lt;org&gt;/ (all), &lt;org&gt;/&lt;name&gt; or &lt;name&gt; (a project, else matching names), or a name glob (&lt;org&gt;/web-*) |

**Flags:**
- `-n, --limit <value> - Maximum number of integrations to list - (default: "25")`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`
- `-c, --cursor <value> - Navigate pages: "next", "prev", "first" (or raw cursor string)`

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Integration ID |
| `name` | string | Integration name (e.g. GitHub org) |
| `domainName` | string \| null | External domain (e.g. github.com/getsentry) |
| `provider` | object | Provider |
| `status` | string | Integration status |
| `organizationIntegrationStatus` | string | Status of the install in this organization |
| `externalId` | string | Provider-side installation ID |

**Examples:**

```bash
# List installed integrations (auto-detect org)
sentry integration list

# List integrations in a specific org
sentry integration list my-org/

# Fetch the next page
sentry integration list my-org/ -c next

# Only integrations whose name or provider matches a glob
sentry integration list 'my-org/git*'

# Integrations named like 'GitHub' (fuzzy when nothing matches exactly)
sentry integration list my-org/githb

# Output as JSON
sentry integration list --json
```

### `sentry integration delete [<org>/]<integration-id>`

Remove an installed integration

**Destructive:** This command deletes data or makes changes that can't easily be undone. Use `--dry-run` to preview the changes first. Confirm with the user before running it.

**Arguments:**

| Argument | Description |
|----------|-------------|
| `[<org>/]<integration-id>` | [&lt;org&gt;/]&lt;integration-id&gt; - Integration to remove |

**Flags:**
- `-y, --yes - Skip confirmation prompt`
- `-f, --force - Force the operation without confirmation`
- `-n, --dry-run - Show what would happen without making changes`

**Examples:**

```bash
# Remove an integration (auto-detect org)
sentry integration delete 12345

# Preview removing an integration
sentry integration delete my-org/12345 --dry-run

# Remove without the confirmation prompt
sentry integration delete my-org/12345 --yes
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
