

## Permissions

Removing an integration needs the `org:integrations` permission, which Sentry
grants to org owners and managers. If your CLI login predates that scope,
`sentry integration delete` asks you to re-authorize before removing anything.
This only happens in interactive runs: with `--yes` or `--json` the CLI never
starts the authorization flow, so run it once without those flags first.

Installing new integrations from the CLI is not supported yet.
