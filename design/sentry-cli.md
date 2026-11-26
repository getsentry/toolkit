# Sentry CLI

The `sentry` command lets a developer or a coding agent work with Sentry from
a terminal, with as little setup as the current project allows.

## Intent

- Zero config. The CLI finds the org and project from the arguments, then
  the saved defaults, then DSNs in the project, so most commands run with no
  target.
- Commands follow `gh` conventions, so a user who knows `gh` can guess them.
- Agents are first-class users. Every list and view command has JSON output
  and predictable behavior, and the CLI ships its own agent skill.
- The CLI is fast to start and to repeat, as a native binary with cached API
  responses.
- One login serves every command and `sentry mcp`.

## Entry points

- `sentry <group> <command>`, such as `sentry issue list`, `sentry issue view`,
  `sentry auth login`, and `sentry mcp`.
- Targets: `<org>/<project>`, `<org>/`, a project name, or a Sentry URL.
- `--json` on list and view commands, and `-w`/`--web` on view commands.
- The npm package `sentry`, release binaries, and the docs at
  <https://cli.sentry.dev/>. Releases also go out under the v3 names: npm
  `@sentry/cli`, PyPI `sentry-cli`, Homebrew `getsentry/tools/sentry-cli`, and
  `downloads.sentry-cdn.com/sentry-cli/`. Each installs the `sentry` command.

## Rules

- An explicit target always wins over saved defaults and DSN detection.
- A command that needs a login and has none exits non-zero with a message
  that says to run `sentry auth login`.
- The CLI never prints a token in full.
- Telemetry goes only to the Sentry CLI's own project, and
  `SENTRY_CLI_NO_TELEMETRY=1` or `DO_NOT_TRACK=1` turns it off.
- `-f` means `--fresh` in every command that can bypass the response cache,
  and a cached result's footer names the flag that refreshes that command.
- Live output is its own command, such as `sentry log tail`, not a mode flag
  on a list or view command. List and view commands return once.
- The library SDK returns an `AsyncIterable` for exactly the invocations that
  stream, in its typed methods and in `sdk.run()` alike.
- `help` works after any command path (`sentry auth help`), but the command
  never treats `help` as special while it could be a real value: a project,
  dashboard, or organization named `help` is still found. Only when the
  normal command cannot succeed, or finds nothing named `help`, does the CLI
  show that command's help, with a tip to use `--help`.

## Gaps

- `sentry dashboard view --refresh` keeps redrawing through a flag instead of
  its own command.
