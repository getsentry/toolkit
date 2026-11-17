# Sentry CLI

How the `sentry` command behaves in a terminal with no login and with an
environment token: commands that need a login stop with one clear message,
and `auth status` never prints the token in full. The goals are in
`design/sentry-cli.md`.

## Claims

- `no-login-exit` A command that needs a login, with none, exits 10 and says to run `sentry auth login`. Proof: `drive`.
- `token-masked` `sentry auth status` with `SENTRY_AUTH_TOKEN` reports the env token as active and never prints it in full. Proof: `drive`.

## How to get to it

- `sentry <group> <command>` in a terminal, here from CLI source through `sentry-offline.mjs`.
- `SENTRY_AUTH_TOKEN` in the environment, or a login from `sentry auth login`.

## Driving it with sentry-offline.mjs

Preconditions:

- Launch from `../SKILL.md` passes, and `$VERIFY_RUN` is set.

- **`no-login-exit`: list issues with no login.** Run `node .agents/skills/verify-toolkit/scripts/sentry-offline.mjs --out "$VERIFY_RUN/cli-no-login" -- issue list acme/`. It prints `exit 10`. `stderr.txt` contains `Not authenticated. Run 'sentry auth login' first.`
- **`token-masked`: check status with a token.** Run `node .agents/skills/verify-toolkit/scripts/sentry-offline.mjs --out "$VERIFY_RUN/cli-token" --token -- auth status`. It prints `exit 0` and no `PRINTED THE TOKEN`. `stdout.txt` contains `Authenticated via SENTRY_AUTH_TOKEN`, and its `Token` row shows a shortened token, such as `sntryu_v...line`.

## Gotchas

- The first CLI run on a fresh checkout generates files and prints that work. Run Launch's `ensure-generated` step first, or the output mixes with the proof.
- A short token prints as `****` and a long one as its first 8 and last 4 characters. Both pass; only the full token fails.
- `auth status` also reports `Could not verify credentials` offline. That line is expected and is not part of the claim.

## Gaps

- `json-output` List and view commands print JSON with `--json`. Proving it needs a Sentry host that answers.
