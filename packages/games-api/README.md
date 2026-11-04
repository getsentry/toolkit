# @sentry/games-api

Cloudflare Worker (Hono) that serves the public Snake leaderboard for
`sentry games leaderboard`.

The leaderboard is a working example of Sentry application metrics: the CLI
emits a metric with the SDK, and the Worker reads it back through the Events
API. It has no database of its own.

## How a score reaches the leaderboard

```
sentry games snake                 Sentry (org sentry, CLI project)      this Worker                  sentry games leaderboard
──────────────────                 ────────────────────────────────      ───────────                  ────────────────────────
game over
  → reportSnakeScore(score)  ───►  `snake.score` distribution metric ◄── GET /api/0/organizations/   ◄── GET /v1/snake/leaderboard
    (only when telemetry is on)    tagged with `handle`                  sentry/events/ (read token)       prints RANK, PLAYER, SCORE
                                                                         → top 10, cached for 5 min
```

1. **Write.** When a run ends, `packages/cli/src/lib/games/score.ts` sends one
   `snake.score` metric through the CLI's own Sentry SDK. It carries only the
   random player handle from `packages/cli/src/lib/games/player.ts`.
   `scrubAnonymousMetric` in `packages/cli/src/lib/telemetry.ts` drops every
   other attribute. Nothing is sent when telemetry is off.
2. **Read.** `src/leaderboard.ts` queries the `tracemetrics` dataset for the
   highest score per handle over 30 days, validates every row, and keeps the
   top 10. The Workers Cache API holds the result for 5 minutes, and a rate
   limiter allows 30 requests per minute per IP.
3. **Show.** `packages/cli/src/commands/games/leaderboard.ts` fetches
   `GET /v1/snake/leaderboard`, validates it again, and marks your own row.

## Endpoint

`GET https://games.sentry.new/v1/snake/leaderboard`

```json
{
  "period": "30d",
  "entries": [{ "rank": 1, "handle": "brave-otter-4242", "score": 57 }]
}
```

Every other path returns `404 {"error":"Not found"}`. Errors are `429`
(rate limited), `502` (Sentry query failed), and `503` (no token or limiter
failure).

## Changing the leaderboard

| Change                       | Where                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| Window, size, cache lifetime | Constants at the top of `src/leaderboard.ts` (`LEADERBOARD_PERIOD`, `LEADERBOARD_SIZE`, ...)  |
| Handle format or score limit | Both `src/leaderboard.ts` and `packages/cli/src/lib/games/{player,score}.ts`; they must match |
| Metric name or attributes    | `score.ts`, `scrubAnonymousMetric` in `telemetry.ts`, and the query in `src/leaderboard.ts`   |
| Table the CLI prints         | `packages/cli/src/commands/games/leaderboard.ts`                                              |
| A new game                   | A new metric in the CLI and a new route in `src/index.ts`                                     |

## Develop and deploy

```bash
pnpm --filter @sentry/games-api run test
pnpm --filter @sentry/games-api run dev     # then SENTRY_GAMES_API_URL=http://localhost:8787
pnpm --filter @sentry/games-api run deploy
cd packages/games-api && npx wrangler secret put SENTRY_GAMES_READ_TOKEN
```

The Worker runs on a custom domain because the Cache API is a no-op on
workers.dev.

## Token requirements

- A Sentry token with only the `org:read` scope.
- The token's user must be a member only of the team that owns the CLI
  project.
- Enable "Prevent storing IP addresses" on that project.
