

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
| `<org>/<project>` | That project in that organization |
| `<org>/<project>,<project>` | Several projects in the same organization (commands that accept several projects) |
| `<org>/` | The whole organization |
| `<name>` | A project named `<name>` in any accessible organization. If no project matches, commands that accept an organization use the organization named `<name>`. When both exist, the project wins: add the trailing slash (`<name>/`) to select the organization |
<!-- GENERATED:END target-syntax -->

## JSON Output

Most list and view commands support `--json` flag for JSON output, making it easy to integrate with other tools:

```bash
sentry org list --json | jq '.[] | .slug'
```

## Opening in Browser

View commands support `-w` or `--web` flag to open the resource in your browser:

```bash
sentry issue view PROJ-123 -w
```
