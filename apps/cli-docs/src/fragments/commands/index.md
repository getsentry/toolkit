

## Global Options

All commands support the following global options:

- `--help` - Show help for the command
- `--version` - Show CLI version
- `--log-level <level>` - Set log verbosity (`error`, `warn`, `log`, `info`, `debug`, `trace`). Overrides `SENTRY_LOG_LEVEL`
- `--verbose` - Shorthand for `--log-level debug`

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
