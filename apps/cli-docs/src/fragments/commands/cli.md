

## Examples

### Check for updates

```bash
sentry cli upgrade --check
```

```
Installation method: curl
Current version: 0.4.0
Channel: stable
Latest version: 0.5.0

Run 'sentry cli upgrade' to update.
```

### Upgrade

```bash
# Upgrade to latest stable
sentry cli upgrade

# Upgrade to a specific version
sentry cli upgrade 0.5.0

# Force re-download
sentry cli upgrade --force
```

### Release Channels

```bash
# Switch to nightly builds
sentry cli upgrade nightly

# Switch back to stable
sentry cli upgrade stable
```

After switching, bare `sentry cli upgrade` will continue tracking that channel.

| Channel | Description |
|---------|-------------|
| `stable` | Latest stable release (default) |
| `nightly` | Built from `main`, updated on every commit |

### Installation Detection

The CLI detects how it was installed and uses the appropriate upgrade method:

| Method | Detection |
|--------|-----------|
| curl | Binary installed via cli.sentry.dev (XDG: `~/.local/bin`; legacy: `~/.sentry/bin`) |
| brew | Binary in a Homebrew Cellar (`brew install getsentry/tools/sentry`) |
| npm | Globally installed via `npm install -g sentry` |
| pnpm | Globally installed via `pnpm add -g sentry` |
| bun | Globally installed via `bun install -g sentry` |

Nightly builds are only available as standalone binaries (via the curl install method). Switching to nightly from a package manager install will automatically migrate to a standalone binary.

### View and manage defaults

```bash
# Show all current defaults
sentry cli defaults

# Set default organization
sentry cli defaults org my-org

# Set default project
sentry cli defaults project my-project

# Set default Sentry URL (self-hosted)
sentry cli defaults url https://sentry.example.com

# Set custom HTTP headers (self-hosted, e.g. for IAP/proxies)
sentry cli defaults headers "X-IAP: token"

# Set a custom CA certificate (self-hosted, behind a TLS proxy)
sentry cli defaults ca-cert /path/to/ca.pem

# Disable telemetry
sentry cli defaults telemetry off

# Clear a single default
sentry cli defaults org --clear

# Clear all defaults
sentry cli defaults --clear
```

### Import legacy settings

Import settings from `.sentryclirc` files used by the legacy `sentry-cli`:

```bash
# Auto-detect and import .sentryclirc
sentry cli import

# Preview what would be imported
sentry cli import --dry-run

# Skip confirmation prompt
sentry cli import --yes

# Explicitly trust a self-hosted URL
sentry cli import --url https://sentry.example.com

# Skip API validation of the imported token
sentry cli import --skip-validation
```

### Send feedback

```bash
# Send positive feedback
sentry cli feedback i love this tool

# Report an issue
sentry cli feedback the issue view is confusing
```

Feedback is sent via Sentry's telemetry system. If telemetry is disabled (`SENTRY_CLI_NO_TELEMETRY=1`), feedback cannot be sent.

### Fix configuration issues

```bash
sentry cli fix
```

### Print shell completions

```bash
# Print completions for your current shell (auto-detected from $SHELL)
sentry cli completion

# Generate for a specific shell
sentry cli completion zsh > ~/.local/share/zsh/site-functions/_sentry
eval "$(sentry cli completion bash)"
sentry cli completion fish > ~/.config/fish/completions/sentry.fish
```

### Configure shell integration

```bash
# Run full setup (PATH, completions, agent skills)
sentry cli setup

# Skip agent skill installation
sentry cli setup --no-agent-skills

# Skip PATH and completion modifications
sentry cli setup --no-modify-path --no-completions
```

### Uninstall

```bash
# Show what would be removed (dry run)
sentry cli uninstall --dry-run

# Uninstall, keeping config directory
sentry cli uninstall --yes --keep-config

# Full uninstall with confirmation
sentry cli uninstall
```
