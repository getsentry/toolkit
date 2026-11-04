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
   limiter allows 30 requests per minute per IP. The limiter fails open.
3. **Show.** `packages/cli/src/lib/games/leaderboard-api.ts` fetches
   `GET /v1/snake/leaderboard` and validates it again.
   `packages/cli/src/commands/games/leaderboard.ts` marks your own row.

## Endpoint

`GET https://games.sentry.new/v1/snake/leaderboard`

```json
{
  "period": "30d",
  "entries": [{ "rank": 1, "handle": "brave-otter-4242", "score": 57 }]
}
```

Every other path returns `404 {"error":"Not found"}`. Errors are `429`
(rate limited), `502` (Sentry query failed), and `503` (no token). The Worker
reports `502` and `503` causes to Sentry when `SENTRY_DSN` is set. These
reports do not include the client IP, headers, cookies, bodies, or query
strings.

## Changing the leaderboard

| Change                       | Where                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| Window, size, cache lifetime | Constants at the top of `src/leaderboard.ts` (`LEADERBOARD_PERIOD`, `LEADERBOARD_SIZE`, ...) |
| Handle format or score limit | `packages/toolkit-core/src/games.ts`, which the CLI and the Worker share                     |
| Metric name or attributes    | `packages/toolkit-core/src/games.ts`, and `scrubAnonymousMetric` in `telemetry.ts`           |
| Table the CLI prints         | `packages/cli/src/commands/games/leaderboard.ts`                                             |
| A new game                   | A new metric in the CLI and a new route in `src/app.ts`                                      |

## Develop

```bash
pnpm --filter @sentry/games-api run test
pnpm --filter @sentry/games-api run dev     # then SENTRY_GAMES_API_URL=http://localhost:8787
```

The Worker runs on a custom domain because the Cache API is a no-op on
workers.dev.

## Deployment ownership

The CLI team owns this Worker. It runs as `sentry-games-api` on the
**Sentry Internal** Cloudflare account, which also holds the `sentry.new`
zone.

The `Deploy Games API` GitHub Actions workflow deploys it after a successful
`Test` push run for the current `main` commit. It uses the `production`
environment with its own secrets, because the MCP Workers use a different
Cloudflare account:

- `GAMES_API_CLOUDFLARE_API_TOKEN`: a Cloudflare API token for the Sentry
  Internal account with **Workers Scripts: Edit** and, for the custom domain,
  **Workers Routes: Edit** on the `sentry.new` zone.
- `GAMES_API_CLOUDFLARE_ACCOUNT_ID`: the Sentry Internal account ID.

The workflow keeps runtime variables and secrets (`--keep-vars`) and then
requests the public endpoint until it returns `200`. Set the runtime secrets
once with Wrangler:

```bash
cd apps/games-api
CLOUDFLARE_ACCOUNT_ID=<Sentry Internal account ID> npx wrangler secret put SENTRY_GAMES_READ_TOKEN
CLOUDFLARE_ACCOUNT_ID=<Sentry Internal account ID> npx wrangler secret put SENTRY_DSN
```

## Token requirements

- A Sentry token with only the `org:read` scope.
- The token's user must be a member only of the team that owns the CLI
  project.
- Enable "Prevent storing IP addresses" on that project.
