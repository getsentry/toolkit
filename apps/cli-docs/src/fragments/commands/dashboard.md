

## Examples

### List dashboards

```bash
# List all dashboards
sentry dashboard list

# Filter by name pattern
sentry dashboard list "Backend*"

# Open dashboard list in browser
sentry dashboard list -w
```

```
ID      TITLE                   WIDGETS  CREATED
12345   General                 4        2024-01-15
12346   Frontend Performance    6        2024-02-20
12347   Backend Errors          3        2024-03-10
```

### View a dashboard

```bash
# View by title
sentry dashboard view 'Frontend Performance'

# View by ID
sentry dashboard view 12345

# Auto-refresh every 30 seconds
sentry dashboard view "Backend Performance" --refresh 30

# Open in browser
sentry dashboard view 12345 -w
```

```
Dashboard: Frontend Performance (ID: 12345)
URL: https://my-org.sentry.io/dashboard/12345/

Widgets:
  #0  Error Count          big_number   count()
  #1  Errors Over Time     line         count()
  #2  Errors by Browser    bar          count() group by browser.name
  #3  Top Endpoints        table        count(), p95(span.duration) group by transaction
```

### Create a dashboard

```bash
sentry dashboard create 'Frontend Performance'
```

```
Created dashboard: Frontend Performance (ID: 12348)
URL: https://my-org.sentry.io/dashboard/12348/
```

### Add widgets

```bash
# Simple counter widget
sentry dashboard widget add 'My Dashboard' "Error Count" \
  --display big_number --query count

# Line chart with group-by
sentry dashboard widget add 'My Dashboard' "Errors by Browser" \
  --display line --query count --group-by browser.name

# Table with multiple aggregates, sorted descending
sentry dashboard widget add 'My Dashboard' "Top Endpoints" \
  --display table \
  --query count --query p95:span.duration \
  --group-by transaction \
  --sort -count --limit 10

# With search filter
sentry dashboard widget add 'My Dashboard' "Slow Requests" \
  --display bar --query p95:span.duration \
  --where "span.op:http.client" \
  --group-by span.description
```

### Edit widgets

```bash
# Change display type
sentry dashboard widget edit 12345 --title 'Error Count' --display bar

# Rename a widget
sentry dashboard widget edit 'My Dashboard' --index 0 --new-title 'Total Errors'

# Change the query
sentry dashboard widget edit 12345 --title 'Error Rate' --query p95:span.duration
```

### Delete widgets

```bash
# Delete by title
sentry dashboard widget delete 'My Dashboard' --title 'Error Count'

# Delete by index
sentry dashboard widget delete 12345 --index 2
```

### View revision history

```bash
# List revisions by dashboard title
sentry dashboard revisions 'Frontend Performance'

# List revisions by dashboard ID
sentry dashboard revisions 12345

# With explicit org
sentry dashboard revisions my-org 12345
```

### Restore a previous revision

```bash
# Restore by dashboard title and revision number
sentry dashboard restore 'Frontend Performance' --revision 3

# Restore by dashboard ID
sentry dashboard restore 12345 --revision 1

# With explicit org
sentry dashboard restore my-org 12345 --revision 1
```

:::tip
Use `sentry dashboard revisions` to find the revision number before restoring.
:::

## Query Shorthand

The `--query` flag supports shorthand for aggregate functions:

| Input | Expands to |
|-------|-----------|
| `count` | `count()` |
| `p95:span.duration` | `p95(span.duration)` |
| `avg:span.duration` | `avg(span.duration)` |
| `count()` | `count()` (passthrough) |

## Sort Shorthand

| Input | Meaning |
|-------|---------|
| `count` | Sort by `count()` ascending |
| `-count` | Sort by `count()` descending |
