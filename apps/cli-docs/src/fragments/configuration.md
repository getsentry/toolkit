

## Configuration File (`.sentryclirc`)

The CLI supports a `.sentryclirc` config file using standard INI syntax. This is the same format used by the legacy `sentry-cli` tool, so existing config files are automatically picked up.

### How It Works

The CLI looks for `.sentryclirc` files by walking up from your current directory toward the filesystem root. If multiple files are found, values from the closest file take priority, with `~/.sentryclirc` serving as a global fallback.

```ini
[defaults]
org = my-org
project = my-project

[auth]
token = sntrys_...
```

### Supported Fields

| Section | Key | Description |
|---------|-----|-------------|
| `[defaults]` | `org` | Default organization slug |
| `[defaults]` | `project` | Default project slug |
| `[defaults]` | `url` | Sentry base URL (for self-hosted) |
| `[auth]` | `token` | Auth token (mapped to `SENTRY_AUTH_TOKEN`) |

### Monorepo Setup

In monorepos, place a `.sentryclirc` at the repo root with your org, then add per-package configs with just the project:

```
my-monorepo/
  .sentryclirc              # [defaults] org = my-company
  packages/
    frontend/
      .sentryclirc          # [defaults] project = frontend-web
    backend/
      .sentryclirc          # [defaults] project = backend-api
```

When you run a command from `packages/frontend/`, the CLI resolves `org = my-company` from the root and `project = frontend-web` from the closest file.

### Resolution Priority

When the CLI needs to determine your org and project, it checks these sources in order:

1. **Explicit CLI arguments** — `sentry issue list my-org/my-project`
2. **Environment variables** — `SENTRY_ORG` / `SENTRY_PROJECT`
3. **`.sentryclirc` config file** — walked up from CWD, merged with `~/.sentryclirc`
4. **Persistent defaults** — set via `sentry cli defaults`
5. **DSN auto-detection** — scans source code and `.env` files
6. **Directory name inference** — matches your directory name against project slugs

The first source that provides both org and project wins. For org-only commands, only the org is needed.

### Backward Compatibility

If you previously used the legacy `sentry-cli` and have a `~/.sentryclirc` file, the new CLI reads it automatically. The `[defaults]` and `[auth]` sections are fully compatible. The `[auth] token` value is mapped to the `SENTRY_AUTH_TOKEN` environment variable internally (only if the env var is not already set).

## Persistent Defaults

Use `sentry cli defaults` to set persistent defaults for organization, project, URL, and telemetry. These are stored in the CLI's local database and apply to all commands.

```bash
sentry cli defaults org my-org           # Set default organization
sentry cli defaults project my-project   # Set default project
sentry cli defaults url https://...      # Set Sentry URL (self-hosted)
sentry cli defaults telemetry off        # Disable telemetry
sentry cli defaults                      # Show all current defaults
sentry cli defaults org --clear          # Clear a specific default
```

See [`sentry cli defaults`](./commands/cli/#sentry-cli-defaults) for full usage.

## Global Options

These flags are accepted by every command. They are not shown in individual command `--help` output, but are always available.

### `--log-level <level>`

Set the log verbosity level. Accepts: `error`, `warn`, `log`, `info`, `debug`, `trace`.

```bash
sentry issue list --log-level debug
sentry --log-level=trace cli upgrade
```

Overrides `SENTRY_LOG_LEVEL` when both are set.

### `--verbose`

Shorthand for `--log-level debug`. Enables debug-level diagnostic output.

```bash
sentry issue list --verbose
```

:::note
The `sentry api` command also uses `--verbose` to show full HTTP request/response details. When used with `sentry api`, it serves both purposes (debug logging + HTTP output).
:::

## Credential Storage

We store credentials and caches in a SQLite database (`cli.db`) inside the config directory. The location follows the [XDG Base Directory specification](https://specifications.freedesktop.org/basedir/latest/): by default the CLI uses `$XDG_CONFIG_HOME/sentry` (i.e. `~/.config/sentry/` when `XDG_CONFIG_HOME` is unset), and you can override it with `SENTRY_CONFIG_DIR`. For backward compatibility, if a legacy `~/.sentry/` directory already exists it continues to be used. The database file and its WAL side-files are created with restricted permissions (mode 600) so that only the current user can read them. The database also caches:

- Organization and project defaults
- DSN resolution results
- Region URL mappings
- Project aliases (for monorepo support)

See [Credential Storage](./commands/auth/#credential-storage) in the auth command docs for more details.

## Binary Install Location

When installed via the install script, the CLI binary is placed in an XDG-aligned directory. `sentry cli setup` resolves the location in this order:

1. `SENTRY_INSTALL_DIR` — explicit override
2. `$XDG_BIN_HOME` — used when set to an absolute path, per the XDG spec
3. `~/.local/bin` or `~/bin` — when either already exists and is on your `PATH`
4. `~/.local/bin` — default fallback

Older installs placed the binary in `~/.sentry/bin`. Running `sentry cli setup` moves an existing `~/.sentry/bin` binary into the resolved install directory (updating your `PATH` and recorded install metadata to match) and migrates any legacy `~/.sentry` config data (`cli.db`, `config.json`) into the XDG config directory. Both migrations are skipped when a binary or config already exists at the target.

`sentry upgrade` runs `setup` on the new binary, so it migrates too — but conservatively, because upgrade never edits your `PATH`. A legacy `~/.sentry/bin` binary is relocated to the XDG install directory **only when that directory is already on your `PATH`**, so the moved binary stays discoverable. If the XDG directory isn't on `PATH`, upgrade leaves the binary in place (a mislocated binary that vanished from `PATH` would break the command); run `sentry cli setup` explicitly to relocate it and update `PATH`. Legacy config data is migrated on upgrade regardless.
