---
name: sentry-cli-wizard
version: 0.52.0-dev.0
description: Set up the Sentry SDK in your project interactively
requires:
  bins: ["sentry"]
  auth: true
---

# Wizard Commands

Set up the Sentry SDK in your project interactively

### `sentry wizard`

Set up the Sentry SDK in your project interactively

**Flags:**
- `-i, --integration <value> - Integration to set up (skips the picker)`
- `-u, --url <value> - URL of your self-hosted Sentry instance`
- `--org <value> - Slug of the Sentry organization to use`
- `--project <value> - Slug of the Sentry project to use`
- `--saas - Use Sentry SaaS (sentry.io) without asking`
- `--spotlight - Set up Spotlight for local development, without a Sentry account`
- `--force-install - Install the SDK even when the package manager's checks fail`
- `--ignore-git-changes - Don't ask before changing a project with uncommitted changes`
- `--disable-telemetry - Don't send telemetry about this run to Sentry`
- `--debug - Print the wizard's debug output`
- `--promo-code <value> - Promo code to apply when signing up`

**Examples:**

```bash
# Pick an integration and set it up
sentry wizard

# Set up Next.js for a known org and project on sentry.io
sentry wizard -i nextjs --saas --org my-org --project my-project

# Set up Next.js for Spotlight, without a Sentry account
sentry wizard -i nextjs --spotlight
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
