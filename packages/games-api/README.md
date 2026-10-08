# @sentry/games-api

Standalone Cloudflare Worker (Hono) that serves the public Snake leaderboard
for `sentry games leaderboard`. It reads scores from Sentry with a read-only
token and caches the result with the Workers Cache API.

## Endpoint

`GET https://games.sentry.new/v1/snake/leaderboard`

Everything else returns `404 {"error":"Not found"}`.

## Deploy

```bash
pnpm --filter @sentry/games-api run deploy
cd packages/games-api && npx wrangler secret put SENTRY_GAMES_READ_TOKEN
```

The Worker runs on a custom domain because Cloudflare's Cache API is a no-op
on workers.dev.

## Token requirements

- A Sentry token with only the `org:read` scope.
- The token's user must be a member only of the team that owns the CLI
  project.
- Enable "Prevent storing IP addresses" on that project.
