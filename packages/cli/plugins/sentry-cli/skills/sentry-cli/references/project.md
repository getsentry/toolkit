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

**Flags:**
- `-n, --limit <value> - Maximum number of projects to list - (default: "25")`
- `-p, --platform <value> - Filter by platform (e.g., javascript, python)`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`
- `-c, --cursor <value> - Navigate pages: "next", "prev", "first" (or raw cursor string)`

**Examples:**

```bash
# List all projects in an organization
sentry project list my-org/

# Several projects in the same organization
sentry project list my-org/frontend,backend

# Filter by platform
sentry project list my-org/ --platform javascript
```

### `sentry project view [<org/project>]`

View details of a project

**Flags:**
- `-w, --web - Open in browser`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`

**Examples:**

```bash
# View project details
sentry project view my-org/frontend

# Open the project in the browser
sentry project view my-org/frontend -w
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
