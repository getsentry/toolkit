# MCP access

A person or team connects Sentry MCP once, with their own Sentry account, and
each session reaches only the Sentry data and tools that they chose.

## Intent

- Sentry decides what a user can do. Sentry MCP never widens that, and each
  session can narrow it further with skills and an org or project scope.
- Skills are how a user chooses what a session can do. A user who picks
  only read access gets a session that cannot change their issues, projects,
  or configuration.
- One login serves the CLI and the stdio server, so a developer signs in once
  with `sentry auth login`.
- An MCP client that passes a token in its server config gets that account,
  and a stored login never silently replaces it.
- On remote HTTP, the MCP client never holds the user's Sentry credentials.
- Stale or invalid access fails closed: the user signs in again instead of a
  session continuing on a credential that Sentry rejects.

## Entry points

- Stdio: `sentry mcp` (also published as `@sentry/mcp-server`), with a CLI
  login or `SENTRY_AUTH_TOKEN`.
- Remote HTTP: `https://mcp.sentry.dev/mcp`, `/mcp/<org>`, and
  `/mcp/<org>/<project>`, with Sentry OAuth and a skill choice on the consent
  screen.
- Remote HTTP with a `Sentry-Bearer` token, which the caller owns.
- Skills: `inspect`, `seer`, `triage`, and `project-management`, chosen with
  `--skills`, `--disable-skills`, `--all-skills`, `MCP_SKILLS`, or the consent
  screen.
- Scope: an `<org>/` or `<org>/<project>` target on `sentry mcp`, or a scoped
  remote URL.

## Rules

- A session lists and runs only the tools of its granted skills.
- `inspect` never changes issues, projects, teams, DSNs, alerts, or
  monitors. Those tools need `triage` or `project-management`. Every skill
  can still send feedback to the Sentry team and report onboarding status.
- A scoped session works only on its org or project, and a token minted for a
  scoped URL does not work on a broader one.
- Refreshing access never widens it.
- An org auth token is sent only to the Sentry host it was issued for.
- Without a login or a token, `sentry mcp` exits with a message that says to
  run `sentry auth login`. It does not start a session that fails every call.
- A scope that Sentry says does not exist stops `sentry mcp` at startup, with
  a message that names the missing part.

## Gaps

None.
