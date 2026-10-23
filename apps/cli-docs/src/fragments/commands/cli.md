

## Release Channels

`sentry cli upgrade nightly` and `sentry cli upgrade stable` switch channels.
After switching, bare `sentry cli upgrade` will continue tracking that channel.

| Channel | Description |
|---------|-------------|
| `stable` | Latest stable release (default) |
| `nightly` | Built from `main`, updated on every commit |

## Installation Detection

The CLI detects how it was installed and uses the appropriate upgrade method:

| Method | Detection |
|--------|-----------|
| curl | Binary installed via cli.sentry.dev (XDG: `~/.local/bin`; legacy: `~/.sentry/bin`) |
| brew | Binary in a Homebrew Cellar (`brew install getsentry/tools/sentry`) |
| npm | Globally installed via `npm install -g sentry` |
| pnpm | Globally installed via `pnpm add -g sentry` |
| bun | Globally installed via `bun add -g sentry` |
| yarn | Globally installed via `yarn global add sentry` |

Nightly builds are only available as standalone binaries (via the curl install method). Switching to nightly from a Homebrew or package manager install will automatically migrate to a standalone binary.

## Feedback

Feedback is sent via Sentry's telemetry system. If telemetry is disabled (`SENTRY_CLI_NO_TELEMETRY=1`, `DO_NOT_TRACK=1`, or `sentry cli defaults telemetry off`), feedback cannot be sent.

## Shell integration

For zsh, setup initializes completion when needed and registers Sentry even if
another tool has already initialized it. Running setup again repairs completion
configuration from older installs. Restart your shell or source your `.zshrc`
after setup to load the changes.
