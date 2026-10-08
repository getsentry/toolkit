## Examples

### Play Snake

```bash
sentry games snake
```

Steer with the arrow keys, pause with `p`, retry with `r`, and quit with `esc`
or `q`. The game needs an interactive terminal and is not available when an AI
agent runs the CLI.


### Show the leaderboard

```bash
sentry games leaderboard
```

Shows the top Snake scores from the last 30 days (a rolling window). Your own
row is marked `(you)`. Use `--json` for machine-readable output.

## Anonymous scores

When a Snake game ends, the CLI sends one score and a random player handle such
as `brave-otter-4242`. The handle is generated on your machine and is not linked
to your account, name, email, organization, or installation. The score is sent
in its own trace, apart from the CLI's other telemetry.

Scores are sent only when telemetry is on. To opt out, set
`SENTRY_CLI_NO_TELEMETRY=1` or `DO_NOT_TRACK=1`, or run
`sentry cli defaults telemetry off`.
