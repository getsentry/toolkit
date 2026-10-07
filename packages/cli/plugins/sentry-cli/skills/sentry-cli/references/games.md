---
name: sentry-cli-games
version: 0.48.0-dev.0
description: Terminal games
requires:
  bins: ["sentry"]
  auth: true
---

# Games Commands

Terminal games

### `sentry games leaderboard`

Show the top Snake scores from the last 30 days

**Examples:**

```bash
sentry games leaderboard
```

### `sentry games snake`

Play Snake in your terminal

**Examples:**

```bash
sentry games snake
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
