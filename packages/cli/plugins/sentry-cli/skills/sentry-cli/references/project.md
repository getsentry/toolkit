---
name: sentry-cli-project
version: 0.48.0-dev.0
description: Work with Sentry projects
requires:
  bins: ["sentry"]
  auth: true
---

# Project Commands

Work with Sentry projects

### `sentry project create [<org>/]<name>:<platform>...`

Create one or more projects

**Arguments:**

| Argument | Description |
|----------|-------------|
| `[<org>/]<name>:<platform>...` | One or more project name and platform pairs |

**Flags:**
- `-t, --team <value> - Team to create the project under`
- `-n, --dry-run - Show what would happen without making changes`

**Examples:**

```bash
# Create a project (every project is a name:platform pair)
sentry project create my-new-app:javascript-nextjs

# Create several projects with their own platforms
sentry project create web:javascript api:python-django worker:node

# Create under a specific organization and team
sentry project create my-org/my-new-app:python --team backend-team

# Preview without creating
sentry project create my-new-app:node --dry-run

# Output the created project as JSON
sentry project create my-app:go --json
```

### `sentry project delete <org/project>`

Delete a project

**Destructive:** This command deletes data or makes changes that can't easily be undone. Use `--dry-run` to preview the changes first. Confirm with the user before running it.

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<org/project>` | &lt;org&gt;/&lt;project&gt; or &lt;project&gt; (search across orgs) |

**Flags:**
- `-y, --yes - Skip confirmation prompt`
- `-f, --force - Force the operation without confirmation`
- `-n, --dry-run - Show what would happen without making changes`

**Examples:**

```bash
# Delete a project (prompts for confirmation)
sentry project delete my-org/old-project

# Delete without confirmation
sentry project delete my-org/old-project --yes

# Preview the deletion
sentry project delete my-org/old-project --dry-run
```

### `sentry project list [<org/project>]`

List projects

**Arguments:**

| Argument | Description |
|----------|-------------|
| `[<org/project>]` | &lt;org&gt;/ (all), &lt;org&gt;/&lt;name&gt; or &lt;name&gt; (a project, else matching names), or a name glob (&lt;org&gt;/web-*) |

**Flags:**
- `-n, --limit <value> - Maximum number of projects to list - (default: "25")`
- `-p, --platform <value> - Filter by platform (e.g., javascript, python)`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`
- `-c, --cursor <value> - Navigate pages: "next", "prev", "first" (or raw cursor string)`

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Project ID |
| `slug` | string | Project slug |
| `name` | string | Project name |
| `platform` | string \| null | Platform |
| `platforms` | array | Platforms seen in events |
| `dateCreated` | string | Creation date (ISO 8601) |
| `firstEvent` | string \| null | First event date (ISO 8601) |
| `status` | string | Project status |
| `isBookmarked` | boolean | Whether you bookmarked it |
| `isMember` | boolean | Whether you are a member |
| `hasAccess` | boolean | Whether you have access |
| `features` | array | Enabled features |
| `team` | object \| null | Owning team |
| `teams` | array | Teams with access |
| `environments` | array | Environments seen |
| `latestRelease` | object \| null | Latest release |
| `organization` | object | Organization (detail responses only) |
| `orgSlug` | string | Organization slug |

**Examples:**

```bash
# List projects (organization auto-detected)
sentry project list

# List all projects in an organization
sentry project list my-org/

# Several projects in the same organization
sentry project list my-org/frontend,backend

# Filter by platform
sentry project list my-org/ --platform javascript

# Only projects whose slug or name matches a glob
sentry project list 'my-org/web-*'

# Projects named like 'frontend' (fuzzy when nothing matches exactly)
sentry project list my-org/frontnd

# Find a project across organizations
sentry project list frontend

# Fetch the next page
sentry project list my-org/ -c next

# Show more results
sentry project list my-org/ --limit 50

# Output as JSON
sentry project list my-org/ --json
```

### `sentry project view [<org/project>]`

View details of a project

**Arguments:**

| Argument | Description |
|----------|-------------|
| `[<org/project>]` | &lt;org&gt;/&lt;project&gt; or &lt;project&gt; (search) |

**Flags:**
- `-w, --web - Open in browser`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Project ID |
| `slug` | string | Project slug |
| `name` | string | Project name |
| `platform` | string \| null | Platform |
| `platforms` | array | Platforms seen in events |
| `dateCreated` | string | Creation date (ISO 8601) |
| `firstEvent` | string \| null | First event date (ISO 8601) |
| `status` | string | Project status |
| `isBookmarked` | boolean | Whether you bookmarked it |
| `isMember` | boolean | Whether you are a member |
| `hasAccess` | boolean | Whether you have access |
| `features` | array | Enabled features |
| `team` | object \| null | Owning team |
| `teams` | array | Teams with access |
| `environments` | array | Environments seen |
| `latestRelease` | object \| null | Latest release |
| `organization` | object | Organization (detail responses only) |
| `dsn` | string \| null | Primary DSN |

**Examples:**

```bash
# View the auto-detected project
sentry project view

# View project details
sentry project view my-org/frontend

# Open the project in the browser
sentry project view my-org/frontend -w

# Find a project across organizations
sentry project view frontend
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
