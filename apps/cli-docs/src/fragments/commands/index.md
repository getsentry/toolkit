

## Global Options

All commands support the following global options:

- `--help` - Show help for the command
- `--version` - Show CLI version
- `--log-level <level>` - Set log verbosity (`error`, `warn`, `log`, `info`, `debug`, `trace`). Overrides `SENTRY_LOG_LEVEL`
- `--verbose` - Shorthand for `--log-level debug`

## Targeting Organizations and Projects

Many commands take an optional `<org>/<project>` target as their first positional argument, or as a prefix of an ID (e.g. `my-org/my-project/<trace-id>`).

<!-- GENERATED:START target-syntax -->
| Target | Meaning |
|--------|---------|
| _(omitted)_ | Auto-detect the org and project from config, DSNs, or the directory name |
| `https://<org>.sentry.io/...` | A Sentry web URL. Selects the org and project in the URL, or the whole organization when it names no project |
| `<org>/<project>` | That project in that organization |
| `<org>/<project>,<project>` | Several projects in the same organization (commands that accept several projects) |
| `<org>/<Project Name>` | A project in that organization whose display name matches. A target with a space is a name, not a slug |
| `<org>/` | The whole organization |
| `<name>` | A project named `<name>` in any accessible organization. If no project matches, commands that accept an organization use the organization named `<name>`. When both exist, the project wins: add the trailing slash (`<name>/`) to select the organization |
| `/<name>` | Same as `<name>` |
| `<Project Name>` | A project whose display name matches, in any accessible organization |
<!-- GENERATED:END target-syntax -->

## JSON Output

Most list and view commands support `--json` flag for JSON output, making it easy to integrate with other tools:

<!-- allow-commands: global flag shown on a representative command -->
```bash
sentry org list --json | jq '.[] | .slug'
```

## Opening in Browser

View commands support `-w` or `--web` flag to open the resource in your browser:

<!-- allow-commands: global flag shown on a representative command -->
```bash
sentry issue view PROJ-123 -w
```
