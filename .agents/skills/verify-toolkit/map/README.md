# Toolkit verification map

This directory is the maintained source for verifying Sentry MCP and Sentry
CLI behavior. Read this index, then use the matching map file as the recipe.
The goals and rules that these claims prove are in `design/`.

## Baseline preconditions

- Launch from `../SKILL.md` has run on this checkout since the last change to
  MCP or CLI code.
- `VERIFY_RUN` names a fresh directory outside the checkout.
- The Doctor commands in `../SKILL.md` pass.
- Never drive a server, login, or config dir that this run did not create.

## Driving conventions

- Run every command from the repo root.
- Treat every command as literal. Keep tool names, arguments, and flags.
- `mcp-call.mjs` is the MCP client; `sentry-offline.mjs` is the terminal.
- One `--out` directory per bullet, under `$VERIFY_RUN`.

## Proof and skip reporting

- MCP proof is the `call-*.json` or `tools-list.json` file, plus the
  `checks.txt` line for the claim.
- CLI proof is `command.txt`, `stdout.txt`, `stderr.txt`, and
  `exit-code.txt`.
- Record the claim ID and the entry point with every artifact.
- Report an unreachable path with the command you ran and the unmet
  precondition. Do not report a claim as verified through a different entry
  point.

## Claim IDs

- A claim ID is lowercase kebab-case and unique in its file. Cite it as
  `<file>#<id>`, where `<file>` is the file name without `.md`.
- Tests, evals, and PRs cite claims by this ID.
- Do not rename or reuse an ID. When a behavior changes meaning, retire its
  ID and add a new one. Search the repo for citations first.

## Map entry contract

Each map file starts with an H1 title and one paragraph. Then it has exactly
five H2 sections, in this order: `Claims`, `How to get to it`,
`Driving it with <harness>` (starting with `Preconditions:`), `Gotchas`, and
`Gaps` (`None.` when empty). Each claim names one proof: `drive`, `test` with
the exact command, or `eval` with the exact command. Keep source structure
out of the map.

## Map files

- `mcp-tool-responses.md` covers what a tool result holds: structured and
  markdown results, suggested actions, side quests, and tool errors.
- `mcp-tool-surface.md` covers what `tools/list` and `initialize` give a
  client: every callable tool, safety hints, titles, one page, and
  instructions.
- `mcp-access.md` covers who can start `sentry mcp` and what a session
  reaches: login, skills, and org scope.
- `cli.md` covers CLI behavior with no login and with a token.
