

## Permissions

Sentry only lets a CLI login from `sentry auth login` manage org auth tokens.
Personal tokens, org auth tokens, and `SENTRY_AUTH_TOKEN` can't create, list,
or revoke them.

The login also needs the `org:tokens` scope, which isn't part of the CLI's
default login. The first `sentry token` command asks you to re-authorize and
adds it. Creating a token also needs `org:ci`, because a login can only give a
new token scopes it holds itself, and revoking one needs `org:write` (org
owners and managers).

Re-authorization only happens in interactive runs: with `--yes`, `--json`, or
`--dry-run` the CLI never starts the authorization flow, so run a
`sentry token` command once without those flags first.

New tokens always get the `org:ci` scope. Sentry returns a token's value only
when it's created, so save it right away.

Self-hosted Sentry needs a version that supports the `org:tokens` scope.
Older servers reject the authorization request with an unknown-scope error.
