---
name: verify-toolkit
description: Prove Sentry MCP and Sentry CLI behavior in this repo by running the real stdio server and the `sentry` CLI from source, offline, and capturing MCP and terminal evidence. Use to verify a change to MCP tools, tool responses, skills, scopes, stdio auth, CLI auth, or `sentry local`, or to check a claim from `map/`. For QA against a live Sentry org or a real agent client, use the `mcp-qa` skill instead.
---

# Verify Toolkit

The primary surface is the Sentry MCP server over stdio, driven as an MCP
client drives it: `initialize`, `tools/list`, `tools/call`. The secondary
surface is the `sentry` CLI in a terminal, including `sentry local`. Two
servers are available:

- **mock**: the eval server (`packages/mcp-server-evals/src/bin/start-mock-stdio.ts`).
  Real stdio transport and tool handlers, every skill, experimental mode, and
  the Sentry API answered by the MSW fixtures in `packages/mcp-server-mocks`.
  Use it for tool calls and responses.
- **cli**: `sentry mcp` from CLI source, with a fake token, an empty config
  dir, and an unreachable Sentry host (`http://127.0.0.1:9`). Use it for what
  the real entry point lists: skills, scopes, auth, and server metadata. Its
  tool calls fail, because no Sentry answers.

Nothing here reaches a live Sentry org. Live data, real logins, real agent
clients, and the Cloudflare `/mcp` server are `mcp-qa` territory
(`.agents/skills/mcp-qa/SKILL.md`).

## Launch

From the repo root, once per checkout or after changing MCP or CLI code:

```bash
pnpm install --frozen-lockfile
env -u SENTRY_AUTH_TOKEN pnpm run build
(cd packages/cli && node script/ensure-generated.mjs)
```

Ready means: `pnpm run build` exits 0, and `ensure-generated` exits 0 and
leaves `packages/cli/src/generated/command-api.json` as valid JSON. Each
drive starts its own server process and stops it when it finishes, so there
is no long-running server and nothing to tear down. Runs are isolated: each
gets its own temporary home and CLI config dir, and two runs can go side by side.

Set a run directory for evidence, outside the checkout:

```bash
export VERIFY_RUN="${TMPDIR:-/tmp}/verify-toolkit/$(date +%Y%m%d-%H%M%S)"
```

## Doctor

```bash
node .agents/skills/verify-toolkit/scripts/mcp-call.mjs --out "$VERIFY_RUN/doctor-mock"
node .agents/skills/verify-toolkit/scripts/mcp-call.mjs --server cli --out "$VERIFY_RUN/doctor-cli"
```

Both print `connected: Sentry MCP (...), N tools` and exit 0. If either
fails, read `server-stderr.txt` in its directory, then rerun Launch.

## Drive

`scripts/mcp-call.mjs` starts a server, lists tools, runs each `--call`, and
writes `initialize.json`, `tools-list.json`, `call-<n>-<tool>.json` (request
and raw `CallToolResult`), and `server-stderr.txt` to `--out`. Listing first
makes the MCP SDK validate every structured result against the tool's
`outputSchema`, as a real client does; a mismatch fails the run.

```bash
node .agents/skills/verify-toolkit/scripts/mcp-call.mjs --out DIR \
  [--server mock|cli] [--no-token | --token TOKEN] [--server-arg ARG]... \
  [--call TOOL 'JSON_ARGS']...
```

- `--server-arg` passes one argument to `sentry mcp`, such as
  `--server-arg --skills --server-arg inspect` or `--server-arg acme/`.
- `--no-token` starts `sentry mcp` with no token and no login. `--token TOKEN`
  sets `SENTRY_AUTH_TOKEN` to `TOKEN` instead of the fake token.
- Mock fixtures use the org `sentry-mcp-evals`, project `cloudflare-mcp`,
  issue `CLOUDFLARE-MCP-41`, and trace `a4d1aae7216b47ff8117cf4e09ce9d0a`.

`scripts/check-results.mjs` checks evidence against map claims, prints one
`PASS` or `FAIL` line per claim, appends them to `checks.txt` in the same
directory, and exits 1 on any failure:

```bash
node .agents/skills/verify-toolkit/scripts/check-results.mjs responses DIR
node .agents/skills/verify-toolkit/scripts/check-results.mjs surface DIR
node .agents/skills/verify-toolkit/scripts/check-results.mjs read-only DIR
node .agents/skills/verify-toolkit/scripts/check-results.mjs scoped DIR
node .agents/skills/verify-toolkit/scripts/check-results.mjs subset WIDE_DIR DIR
node .agents/skills/verify-toolkit/scripts/check-results.mjs local DIR
```

`scripts/mcp-apps-host.mjs` acts as an MCP Apps host for
`render_sentry_chart` on the mock server: it reads the tool's `ui://` view,
mounts it in headless Chromium through the ext-apps `AppBridge`, and writes
screenshots, `host-log.json`, and `checks.txt` to `--out`:

```bash
node .agents/skills/verify-toolkit/scripts/mcp-apps-host.mjs --out DIR
```

`scripts/sentry-offline.mjs` runs one CLI command with the same offline env,
and writes `command.txt`, `stdout.txt`, `stderr.txt`, and `exit-code.txt`:

```bash
node .agents/skills/verify-toolkit/scripts/sentry-offline.mjs --out DIR [--token] -- auth status
```

`--token` sets `SENTRY_AUTH_TOKEN` to a fake token. The script prints
`PRINTED THE TOKEN` if that token appears in the output.

`scripts/local-session.mjs` runs several `sentry local` commands against one
Local daemon in one offline config dir, then runs `local daemon stop`. Each
step writes the same four files to `step-<n>` under `--out`, and the stop
writes them to `teardown`:

```bash
node .agents/skills/verify-toolkit/scripts/local-session.mjs --out DIR \
  --step 'local run --session web --port {port} -- {node} {app}' \
  --step 'local event list web --json'
```

It replaces `{port}` with a free port, `{node}` with the Node binary, and
`{app}` with `scripts/local-app.mjs`, an app that sends one error through the
real Sentry Node SDK. `check-results.mjs local DIR` checks its evidence.

## Evidence

Everything goes under `$VERIFY_RUN`, one directory per drive, named for the
claim it proves. Proof standards:

- Drive the real entry point: MCP JSON-RPC over stdio, or the `sentry`
  command. Never call handlers or internal helpers.
- Keep the raw MCP result, not only an agent's answer.
- Keep the action and the result: the request sits next to the result in
  each `call-*.json`, and the command next to its output for the CLI.
- The only mock is the Sentry API, an external HTTP boundary. Do not mock
  the server, the transport, or the CLI.
- Offline `sentry mcp` makes network attempts, such as a scope check at
  startup. They go to `127.0.0.1:9` and fail; check `server-stderr.txt` and
  do not assume a skipped network call. The scripts turn off the CLI's
  telemetry and its update check.
- Cite the claim ID (`<file>#<id>`) with each artifact you report.

## Cleanup

Each script stops the process it started and removes its temporary config
dir. `local-session.mjs` also stops the Local daemon its steps started, and
kills that daemon's PID if it outlives `local daemon stop`. If you stop a script early, kill only the PID of the server it started.
Never kill by process name: a developer's own `sentry mcp` may be running.
Do not delete `$VERIFY_RUN`; it is the evidence.

## Map

`map/README.md` lists the map files and the entry contract. Cite a claim as
`<file>#<id>`, such as `mcp-tool-responses#structured-text-match`. The goals
behind the claims are in `design/`.
