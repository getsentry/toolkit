# MCP access

Who can start `sentry mcp`, and what a session reaches: it refuses to start
with no login, skills narrow the tool list, `inspect` changes no Sentry data,
and an org scope removes the org choice from every tool. The goals are in
`design/mcp-access.md`.

## Claims

- `no-login-exits` With no token and no login, `sentry mcp` exits before the MCP handshake and says to run `sentry auth login`. Proof: `drive`.
- `skills-narrow` `--skills inspect` lists a strict subset of the default session's tools. Proof: `drive`.
- `inspect-read-only` An `inspect` session lists no tool that changes data, except feedback and onboarding status. Proof: `drive`.
- `scope-hides-org` An `<org>/` scope lists no `find_organizations`, and no tool takes `organizationSlug`. Proof: `drive`.
- `remote-scoped-url` A remote token minted for one org's URL gets 403 on another org's URL. Proof: `test` with `pnpm --filter @sentry/mcp-cloudflare exec vitest run src/server/lib/mcp-handler.test.ts -t "returns 403 when the token is org-scoped but the MCP URL uses a different organization"`.

## How to get to it

- `sentry mcp`, with `SENTRY_AUTH_TOKEN` or a CLI login.
- `--skills`, `--disable-skills`, `--all-skills`, `MCP_SKILLS`, and `MCP_DISABLE_SKILLS`.
- An `<org>/` or `<org>/<project>` target, or `--org` and `--project`.
- Remote HTTP at `/mcp`, `/mcp/<org>`, and `/mcp/<org>/<project>` with OAuth.

## Driving it with mcp-call.mjs

Preconditions:

- Launch and Doctor from `../SKILL.md` pass, and `$VERIFY_RUN` is set.

- **`no-login-exits`: start with nothing.** Run `node .agents/skills/verify-toolkit/scripts/mcp-call.mjs --server cli --no-token --out "$VERIFY_RUN/access-no-login"`. It exits 1 with `mcp-call failed: MCP error -32000: Connection closed`, and `server-stderr.txt` contains `Not authenticated. Run 'sentry auth login' first.`
- **`skills-narrow`, `inspect-read-only`: compare skills.** Run `node .agents/skills/verify-toolkit/scripts/mcp-call.mjs --server cli --out "$VERIFY_RUN/access-default"` and `node .agents/skills/verify-toolkit/scripts/mcp-call.mjs --server cli --server-arg --skills --server-arg inspect --out "$VERIFY_RUN/access-inspect"`. Run `node .agents/skills/verify-toolkit/scripts/check-results.mjs subset "$VERIFY_RUN/access-default" "$VERIFY_RUN/access-inspect"` and `node .agents/skills/verify-toolkit/scripts/check-results.mjs read-only "$VERIFY_RUN/access-inspect"`. Both print `PASS`, and the subset line names removed tools such as `update_issue`.
- **`scope-hides-org`: scope to an org.** Run `node .agents/skills/verify-toolkit/scripts/mcp-call.mjs --server cli --server-arg acme/ --out "$VERIFY_RUN/access-scoped"` and `node .agents/skills/verify-toolkit/scripts/check-results.mjs scoped "$VERIFY_RUN/access-scoped"`. It prints `PASS`.

## Gotchas

- The scope check at startup cannot reach the offline host, so `sentry mcp acme/` starts as if the org exists. That is the documented behavior for a network failure, not proof that `acme` exists.
- `--no-token` also needs the empty home and config dir that the script makes: the CLI reads a token from `~/.sentryclirc`. The script also sets the token variables to empty, because `pnpm run cli` loads `packages/cli/.env.local` for any variable that is not set. Never point `HOME` or `SENTRY_CONFIG_DIR` at a real login for this drive.

## Gaps

- `scope-not-found-exits` A scope that Sentry answers 404 for stops `sentry mcp` with exit code 23 and names the missing part. The offline drive has no Sentry host that answers.
- `token-host-scoped` An org auth token is sent only to the host it was issued for. The offline drive has no second host to send it to.
