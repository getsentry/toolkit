

## Examples

### Create an issue alert rule

```bash
# Create an issue alert rule with inline JSON condition/action
sentry alert issues create my-org/my-project \
  --name "Error Spike" \
  --condition '{"type":"first_seen_event","comparison":true,"conditionResult":true}' \
  --action '{"type":"email","data":{},"config":{"targetType":"team","targetIdentifier":"1"}}'
```

### List issue alert rules

```bash
# List issue alert rules for a project
sentry alert issues list my-org/my-project

# Filter rules by name
sentry alert issues list my-org/my-project --query "spike"
```

### View an issue alert rule

```bash
# View by ID
sentry alert issues view my-org/my-project/12345

# View by name
sentry alert issues view my-org/my-project/"Error Spike"
```

### Edit an issue alert rule

```bash
# Edit issue alert name/status
sentry alert issues edit my-org/my-project/12345 --name "Prod Error Spike" --status disabled
```

### Delete an issue alert rule

```bash
# Delete with preview
sentry alert issues delete my-org/my-project/12345 --dry-run
```

### Create a metric alert rule

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

### List metric alert rules

```bash
# List metric alert rules for an organization
sentry alert metrics list my-org/
```

### View a metric alert rule

```bash
# View by ID
sentry alert metrics view my-org/67890

# View by name
sentry alert metrics view my-org/"P95 latency alert"
```

### Edit a metric alert rule

```bash
# Edit metric alert query/window
sentry alert metrics edit my-org/67890 --query "environment:prod event.type:error" --time-window 15
```

### Delete a metric alert rule

```bash
# Delete without prompt
sentry alert metrics delete my-org/67890 --yes
```
