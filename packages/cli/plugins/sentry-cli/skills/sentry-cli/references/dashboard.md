---
name: sentry-cli-dashboard
version: 0.48.0-dev.0
description: Manage Sentry dashboards
requires:
  bins: ["sentry"]
  auth: true
---

# Dashboard Commands

Manage Sentry dashboards

### `sentry dashboard list <org/title-filter...>`

List dashboards

**Flags:**
- `-w, --web - Open in browser`
- `-n, --limit <value> - Maximum number of dashboards to list - (default: "25")`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`
- `-c, --cursor <value> - Navigate pages: "next", "prev", "first" (or raw cursor string)`

**Examples:**

```bash
# List dashboards (organization auto-detected)
sentry dashboard list

# List dashboards in an explicit organization
sentry dashboard list my-org/

# Use the organization of an explicit project
sentry dashboard list my-org/my-project

# Filter by title glob
sentry dashboard list 'Backend*'

# Filter within an organization
sentry dashboard list my-org/ '*API*'

# Fetch the next page
sentry dashboard list -c next

# Fetch the previous page
sentry dashboard list -c prev

# Output JSON with the pagination envelope
sentry dashboard list --json

# Open the dashboard list in the browser
sentry dashboard list -w
```

### `sentry dashboard view <org/project/dashboard...>`

View a dashboard

**Flags:**
- `-w, --web - Open in browser`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`
- `-r, --refresh <value> - Auto-refresh interval in seconds (default: 60, min: 10)`
- `-t, --period <value> - Time range: "7d", "2024-01-01..2024-02-01", ">=2024-01-01"`
- `--renderer <value> - Graphics renderer (defaults to auto; falls back to auto when unavailable) - (default: "auto")`
- `--no-graphics-cap - Use the terminal-native graphics width (may fall back to ASCII for very large dashboards)`

**Examples:**

```bash
# View a dashboard by title
sentry dashboard view 'Frontend Performance'

# View a dashboard by ID
sentry dashboard view 12345

# View by ID in an explicit organization
sentry dashboard view my-org/12345

# Include project context in the same argument
sentry dashboard view my-org/my-project/12345

# Pass the organization separately, e.g. for titles that contain a slash
sentry dashboard view my-org/ "incidents/2026"

# Override the time period
sentry dashboard view 12345 --period 7d

# Render charts with sixel graphics
sentry dashboard view 12345 --renderer sixel

# Auto-refresh every 30 seconds
sentry dashboard view 'Backend Performance' --refresh 30

# Output as JSON
sentry dashboard view 12345 --json

# Open in the browser
sentry dashboard view 12345 -w
```

### `sentry dashboard create <org/project/title...>`

Create a dashboard

**Examples:**

```bash
# Create a dashboard (organization auto-detected)
sentry dashboard create 'Frontend Performance'

# Create a dashboard in an explicit organization
sentry dashboard create my-org/ 'My Dashboard'

# Use the organization of an explicit project
sentry dashboard create my-org/my-project 'My Dashboard'
```

### `sentry dashboard widget add <org/project/dashboard/title...>`

Add a widget to a dashboard

**Flags:**
- `-d, --display <value> - Display type (big_number, line, area, bar, table, stacked_area, top_n, text, categorical_bar, details, wheel, rage_and_dead_clicks, server_tree, agents_traces_table)`
- `--dataset <value> - Widget dataset (default: spans). Accepts canonical names and API synonyms: spans, error-events/errors, tracemetrics/metrics, logs, issue`
- `-q, --query <value>... - Aggregate expression (e.g. count, p95:span.duration)`
- `-w, --where <value> - Search conditions filter (e.g. is:unresolved)`
- `-g, --group-by <value>... - Group-by column (repeatable)`
- `-s, --sort <value> - Order by (prefix - for desc, e.g. -count)`
- `-n, --limit <value> - Result limit`
- `-x, --col <value> - Grid column position (0-based, 0–5)`
- `-y, --row <value> - Grid row position (0-based)`
- `--width <value> - Widget width in grid columns (1–6)`
- `--height <value> - Widget height in grid rows (min 1)`
- `-l, --layout <value> - Layout mode: sequential (append in order) or dense (fill gaps) - (default: "sequential")`

**Examples:**

```bash
# Add a counter widget
sentry dashboard widget add 'My Dashboard' "Error Count" --display big_number --query count

# Use a dashboard ID in an explicit organization
sentry dashboard widget add my-org/12345 "Error Count" --display big_number --query count

# Line chart with group-by
sentry dashboard widget add 'My Dashboard' "Errors by Browser" --display line --query count --group-by browser.name

# Table with multiple aggregates, sorted descending
sentry dashboard widget add 'My Dashboard' "Top Endpoints" --display table --query count --query p95:span.duration --group-by transaction --sort -count --limit 10

# Bar chart with a search filter
sentry dashboard widget add 'My Dashboard' "Slow Requests" --display bar --query p95:span.duration --where "span.op:http.client" --group-by span.description
```

### `sentry dashboard widget edit <org/project/dashboard...>`

Edit a widget in a dashboard

**Flags:**
- `-i, --index <value> - Widget index (0-based)`
- `-t, --title <value> - Widget title to match`
- `--new-title <value> - New widget title`
- `-d, --display <value> - Display type (big_number, line, area, bar, table, stacked_area, top_n, text, categorical_bar, details, wheel, rage_and_dead_clicks, server_tree, agents_traces_table)`
- `--dataset <value> - Widget dataset (default: spans). Accepts canonical names and API synonyms: spans, error-events/errors, tracemetrics/metrics, logs, issue`
- `-q, --query <value>... - Aggregate expression (e.g. count, p95:span.duration)`
- `-w, --where <value> - Search conditions filter (e.g. is:unresolved)`
- `-g, --group-by <value>... - Group-by column (repeatable)`
- `-s, --sort <value> - Order by (prefix - for desc, e.g. -count)`
- `-n, --limit <value> - Result limit`
- `-x, --col <value> - Grid column position (0-based, 0–5)`
- `-y, --row <value> - Grid row position (0-based)`
- `--width <value> - Widget width in grid columns (1–6)`
- `--height <value> - Widget height in grid rows (min 1)`

**Examples:**

```bash
# Change a widget's display type
sentry dashboard widget edit 12345 --title 'Error Rate' --display bar

# Change the query of a widget selected by index
sentry dashboard widget edit 'My Dashboard' --index 0 --query p95:span.duration

# Rename a widget
sentry dashboard widget edit 12345 --title 'Old Name' --new-title 'New Name'

# Move and resize a widget
sentry dashboard widget edit 12345 --index 0 --col 0 --row 0 --width 6 --height 2
```

### `sentry dashboard widget delete <org/project/dashboard...>`

Delete a widget from a dashboard

**Destructive:** This command deletes data or makes changes that can't easily be undone. Use `--dry-run` to preview the changes first. Confirm with the user before running it.

**Flags:**
- `-i, --index <value> - Widget index (0-based)`
- `-t, --title <value> - Widget title to match`
- `-y, --yes - Skip confirmation prompt`
- `-f, --force - Force the operation without confirmation`
- `-n, --dry-run - Show what would happen without making changes`

**Examples:**

```bash
# Delete a widget by title
sentry dashboard widget delete 'My Dashboard' --title 'Error Rate'

# Delete a widget by index
sentry dashboard widget delete 12345 --index 0

# Preview the deletion
sentry dashboard widget delete 12345 --index 0 --dry-run
```

### `sentry dashboard revisions <org/dashboard...>`

List dashboard revisions

**Flags:**
- `-n, --limit <value> - Maximum number of revisions to list - (default: "25")`
- `-c, --cursor <value> - Navigate pages: "next", "prev", "first" (or raw cursor string)`

**Examples:**

```bash
# List revisions by dashboard title
sentry dashboard revisions 'Frontend Performance'

# List revisions by dashboard ID
sentry dashboard revisions 12345

# Pass the organization explicitly
sentry dashboard revisions my-org/ 12345

# Fetch the next page
sentry dashboard revisions my-org/ 12345 -c next

# Output as JSON
sentry dashboard revisions my-org/ 12345 --json
```

### `sentry dashboard restore <org/dashboard...>`

Restore a dashboard revision

**Flags:**
- `-r, --revision <value> - Revision ID to restore`

**Examples:**

```bash
# Restore by dashboard title and revision number
sentry dashboard restore 'Frontend Performance' --revision 3

# Restore by dashboard ID
sentry dashboard restore 12345 --revision 42

# Pass the organization explicitly
sentry dashboard restore my-org/ 12345 --revision 42

# Output the restored dashboard as JSON
sentry dashboard restore 12345 --revision 42 --json
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
