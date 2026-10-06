---
name: sentry-cli-alert
version: 0.48.0-dev.0
description: Manage Sentry alert rules
requires:
  bins: ["sentry"]
  auth: true
---

# Alert Commands

Manage Sentry alert rules

### `sentry alert issues list [<org/project>]`

List issue alert rules

**Flags:**
- `-w, --web - Open in browser`
- `-n, --limit <value> - Maximum number of issue alert rules to list - (default: "25")`
- `-q, --query <value> - Filter rules by name`
- `-c, --cursor <value> - Pagination cursor (use "next" for next page, "prev" for previous)`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`

**Examples:**

```bash
# List issue alert rules for a project
sentry alert issues list my-org/my-project

# Filter rules by name
sentry alert issues list my-org/my-project --query "spike"
```

### `sentry alert issues view <org/project/rule-id-or-name>`

View an issue alert rule

**Flags:**
- `-w, --web - Open issue alert rules page in browser`

**Examples:**

```bash
# View by ID
sentry alert issues view my-org/my-project/12345

# View by name
sentry alert issues view my-org/my-project/"Error Spike"
```

### `sentry alert issues create [<target>]`

Create an issue alert rule

**Flags:**
- `--name <value> - Rule name`
- `-c, --condition <value>... - Condition object JSON (repeatable, or pass one JSON array)`
- `-a, --action <value>... - Action object JSON (repeatable, or pass one JSON array)`
- `--frequency <value> - Frequency in minutes (default: 30) - (default: 30)`
- `--environment <value> - Environment filter`
- `--filter <value>... - Filter object JSON (repeatable, or pass one JSON array)`
- `-m, --filter-match <value> - Filter match mode: all or any`
- `--owner <value> - Owner (team:user style value accepted by Sentry API)`
- `-n, --dry-run - Show what would happen without making changes`

**Examples:**

```bash
# Create an issue alert rule with inline JSON condition/action
sentry alert issues create my-org/my-project \
  --name "Error Spike" \
  --condition '{"type":"first_seen_event","comparison":true,"conditionResult":true}' \
  --action '{"type":"email","data":{},"config":{"targetType":"team","targetIdentifier":"1"}}'
```

### `sentry alert issues delete <org/project/rule-id-or-name>`

Delete an issue alert rule

**Flags:**
- `-y, --yes - Skip confirmation prompt`
- `-f, --force - Force the operation without confirmation`
- `-n, --dry-run - Show what would happen without making changes`

**Examples:**

```bash
# Delete with preview
sentry alert issues delete my-org/my-project/12345 --dry-run
```

### `sentry alert issues edit <org/project/rule-id-or-name>`

Edit an issue alert rule

**Flags:**
- `--name <value> - New rule name`
- `--status <value> - Rule status: active or disabled`
- `-c, --condition <value>... - Condition object JSON (repeatable, or pass one JSON array)`
- `-a, --action <value>... - Action object JSON (repeatable, or pass one JSON array)`
- `--frequency <value> - Frequency in minutes`
- `--environment <value> - Environment value (pass empty string to clear)`
- `--filter <value>... - Filter object JSON (repeatable, or pass one JSON array)`
- `-m, --filter-match <value> - Filter match mode: all or any`
- `--owner <value> - Owner value (pass empty string to clear)`

**Examples:**

```bash
# Edit issue alert name/status
sentry alert issues edit my-org/my-project/12345 --name "Prod Error Spike" --status disabled
```

### `sentry alert metrics list [<target>]`

List metric alert rules

**Flags:**
- `-w, --web - Open in browser`
- `-n, --limit <value> - Maximum number of metric alert rules to list - (default: "25")`
- `-q, --query <value> - Filter rules by name`
- `-c, --cursor <value> - Pagination cursor (use "next" for next page, "prev" for previous)`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`

**Examples:**

```bash
# List metric alert rules for an organization
sentry alert metrics list my-org/
```

### `sentry alert metrics view <org/rule-id-or-name>`

View a metric alert rule

**Flags:**
- `-w, --web - Open metric alert rules page in browser`

**Examples:**

```bash
# View by ID
sentry alert metrics view my-org/67890

# View by name
sentry alert metrics view my-org/"P95 latency alert"
```

### `sentry alert metrics create <target>`

Create a metric alert rule

**Flags:**
- `--name <value> - Rule name`
- `--query <value> - Metric query filter string`
- `--aggregate <value> - Aggregate expression (for example count(), p95(span.duration))`
- `--dataset <value> - Dataset: errors (error-events), sessions, events, spans, metrics (transaction(s) routes to spans)`
- `--time-window <value> - Evaluation window in minutes`
- `-t, --trigger <value>... - Trigger object JSON (repeatable, or pass one JSON array)`
- `-p, --project <value>... - Project slug filter (repeatable or comma-separated)`
- `--environment <value> - Environment filter`
- `--owner <value> - Owner value accepted by Sentry API`
- `-n, --dry-run - Show what would happen without making changes`

**Examples:**

```bash
# Create an organization metric alert rule
sentry alert metrics create my-org \
  --name "P95 Latency" \
  --query "environment:prod" \
  --aggregate "p95(span.duration)" \
  --dataset spans \
  --time-window 5 \
  --trigger '{"alertThreshold":500,"actions":[{"id":"sentry.mail.actions.NotifyEmailAction","targetType":"Team","targetIdentifier":1}]}'
```

### `sentry alert metrics delete <org/rule-id-or-name>`

Delete a metric alert rule

**Flags:**
- `-y, --yes - Skip confirmation prompt`
- `-f, --force - Force the operation without confirmation`
- `-n, --dry-run - Show what would happen without making changes`

**Examples:**

```bash
# Delete without prompt
sentry alert metrics delete my-org/67890 --yes
```

### `sentry alert metrics edit <org/rule-id-or-name>`

Edit a metric alert rule

**Flags:**
- `--name <value> - New rule name`
- `--status <value> - active or disabled`
- `--query <value> - Metric query filter`
- `--aggregate <value> - Aggregate expression`
- `--dataset <value> - Dataset: errors (error-events), sessions, events, spans, metrics (transaction(s) routes to spans)`
- `--time-window <value> - Evaluation window in minutes`
- `-t, --trigger <value>... - Trigger object JSON (repeatable, or pass one JSON array)`
- `-p, --project <value>... - Project slug filter (repeatable or comma-separated)`
- `--environment <value> - Environment value (pass empty string to clear)`
- `--owner <value> - Owner value (pass empty string to clear)`

**Examples:**

```bash
# Edit metric alert query/window
sentry alert metrics edit my-org/67890 --query "environment:prod event.type:error" --time-window 15
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
