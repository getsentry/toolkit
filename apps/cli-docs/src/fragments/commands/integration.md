

## Examples

```bash
# List installed integrations (auto-detect org)
sentry integration list

# List integrations in a specific org with pagination
sentry integration list my-org/ -c next

# Preview removing an integration
sentry integration delete my-org/12345 --dry-run

# Remove an integration without the confirmation prompt
sentry integration delete my-org/12345 --yes
```

Removing an integration requires the `org:integrations` or `org:admin` scope.
The default `sentry auth login` scopes do not include it; re-authenticate with
`sentry auth refresh --scope ...` including `org:integrations`, or use an auth
token that has it.

Installing new integrations from the CLI is not supported yet.
