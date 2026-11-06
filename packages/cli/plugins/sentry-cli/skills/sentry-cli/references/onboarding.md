---
name: sentry-cli-onboarding
version: 0.49.0-dev.0
description: Report agent onboarding progress to Sentry
requires:
  bins: ["sentry"]
  auth: true
---

# Onboarding Commands

Report agent onboarding progress to Sentry

### `sentry onboarding progress [<org>]`

Report agent onboarding progress

**Arguments:**

| Argument | Description |
|----------|-------------|
| `[<org>]` | Organization slug (optional if auto-detected) |

**Flags:**
- `--stage <value> - Onboarding stage to report progress for`
- `--status <value> - Current status of the stage`
- `--run-status <value> - Set only when the entire run has completed or failed`
- `--run-code <value> - 10-character onboarding run code (or set SENTRY_ONBOARDING_RUN_CODE)`
- `--note <value> - Short context to display with this update. Required when status is failed`
- `--project <value> - Comma-separated project slugs (create_project stage only)`
- `--issue <value> - Comma-separated issue IDs (receive_verification_error stage only)`

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `continueUpdates` | boolean | False when Sentry wants no further updates for this run. |

**Examples:**

```bash
# Report that the agent has connected
sentry onboarding progress my-org --run-code abcd12efg0 --stage connect_agent --status completed

# Report a project created with two slugs
sentry onboarding progress my-org --run-code abcd12efg0 --stage create_project --status completed --project web,api

# Report a failed stage with a note
sentry onboarding progress my-org --run-code abcd12efg0 --stage instrument_app --status failed --note "SDK initialization failed."

# Report the final stage and mark the run complete
sentry onboarding progress my-org --run-code abcd12efg0 --stage check_stack_trace_quality --status completed --run-status completed

# Output as JSON
sentry onboarding progress my-org --run-code abcd12efg0 --stage analyze_project --status active --json
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
