---
name: sentry-cli-cli
version: 0.48.0-dev.0
description: CLI-related commands
requires:
  bins: ["sentry"]
  auth: true
---

# CLI Commands

CLI-related commands

### `sentry cli completion [<shell>]`

Print the shell completion script

**Examples:**

```bash
# Print completions for your current shell (auto-detected from $SHELL)
sentry cli completion

# Install zsh completions
sentry cli completion zsh > ~/.local/share/zsh/site-functions/_sentry

# Load bash completions into the current shell
eval "$(sentry cli completion bash)"

# Install fish completions
sentry cli completion fish > ~/.config/fish/completions/sentry.fish
```

### `sentry cli defaults <key value...>`

View and manage default settings

**Flags:**
- `--clear - Clear the specified default, or all defaults if no key is given`
- `-y, --yes - Skip confirmation prompt`
- `-f, --force - Force the operation without confirmation`

**Examples:**

```bash
# Show all current defaults
sentry cli defaults

# Same as above (aliases: ls, show)
sentry cli defaults list

# Set the default organization
sentry cli defaults org my-org

# Set the default project
sentry cli defaults project my-project

# Set the default Sentry URL (self-hosted)
sentry cli defaults url https://sentry.example.com

# Set custom HTTP headers (self-hosted, e.g. for IAP/proxies)
sentry cli defaults headers "X-IAP: token"

# Set a custom CA certificate (self-hosted, behind a TLS proxy)
sentry cli defaults ca-cert /path/to/ca.pem

# Disable telemetry
sentry cli defaults telemetry off

# Stop installing agent skills on upgrade
sentry cli defaults agent-skills off

# Disable inline terminal images
sentry cli defaults graphics off

# Hide Tip: hints in command output
sentry cli defaults tips off

# Clear a single default
sentry cli defaults org --clear

# Clear all defaults without prompting
sentry cli defaults --clear --yes
```

### `sentry cli feedback <message...>`

Send feedback about the CLI

**Examples:**

```bash
# Send positive feedback
sentry cli feedback i love this tool

# Report an issue
sentry cli feedback the issue view is confusing
```

### `sentry cli fix`

Diagnose and repair CLI database issues

**Flags:**
- `--dry-run - Show what would be fixed without making changes`

**Examples:**

```bash
# Fix database issues
sentry cli fix

# Fix root-owned files
sudo sentry cli fix

# Show what would be fixed without making changes
sentry cli fix --dry-run
```

### `sentry cli import`

Import settings from legacy .sentryclirc files

**Flags:**
- `-y, --yes - Skip confirmation prompt`
- `-n, --dry-run - Show what would happen without making changes`
- `--url <value> - Explicitly trust this URL (bypasses same-file trust check)`
- `--skip-validation - Skip token validation against the Sentry API`

**Examples:**

```bash
# Scan for .sentryclirc files and import interactively
sentry cli import

# Preview what would be imported
sentry cli import --dry-run

# Skip the confirmation prompt (CI-safe)
sentry cli import --yes

# Explicitly trust a self-hosted URL
sentry cli import --url https://sentry.example.com

# Skip API validation of the imported token
sentry cli import --skip-validation
```

### `sentry cli setup`

Configure shell integration

**Flags:**
- `--install - Install the binary from a temp location to the system path`
- `--method <value> - Installation method (curl, brew, npm, pnpm, bun, yarn)`
- `--channel <value> - Release channel to persist (stable or nightly)`
- `--no-modify-path - Skip PATH modification`
- `--no-completions - Skip shell completion installation`
- `--no-agent-skills - Skip agent skill installation for AI coding assistants`
- `--quiet - Suppress output (for scripted usage)`

**Examples:**

```bash
# Run full setup (PATH, completions, agent skills)
sentry cli setup

# Record the install method
sentry cli setup --method curl

# Place the binary and configure the shell
sentry cli setup --install

# Skip PATH modification
sentry cli setup --no-modify-path

# Skip shell completions
sentry cli setup --no-completions

# Skip agent skill installation
sentry cli setup --no-agent-skills
```

### `sentry cli uninstall`

Uninstall Sentry CLI

**Flags:**
- `--keep-config - Keep the config directory (~/.sentry) and auth tokens`
- `-y, --yes - Skip confirmation prompt`
- `-f, --force - Force the operation without confirmation`
- `-n, --dry-run - Show what would happen without making changes`

**Examples:**

```bash
# Show what would be removed
sentry cli uninstall --dry-run

# Uninstall, keeping the config directory
sentry cli uninstall --yes --keep-config

# Full uninstall with confirmation
sentry cli uninstall
```

### `sentry cli upgrade [<version>]`

Update the Sentry CLI to the latest version

**Flags:**
- `--check - Check for updates without installing`
- `--force - Force upgrade even if already on the latest version`
- `--offline - Upgrade using only cached version info and patches (no network)`
- `--no-agent-skills - Skip agent skill installation for AI coding assistants`
- `--method <value> - Installation method to use (curl, brew, npm, pnpm, bun, yarn)`

**Examples:**

```bash
# Update to the latest version on the persisted channel
sentry cli upgrade

# Check for updates without installing
sentry cli upgrade --check

# Switch to the nightly channel and update
sentry cli upgrade nightly

# Switch back to the stable channel and update
sentry cli upgrade stable

# Install a specific stable version
sentry cli upgrade 0.5.0

# Force re-download even if up to date
sentry cli upgrade --force

# Force using npm to upgrade
sentry cli upgrade --method npm

# Upgrade from cached patches (no network)
sentry cli upgrade --offline

# Skip reinstalling agent skills
sentry cli upgrade --no-agent-skills
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
