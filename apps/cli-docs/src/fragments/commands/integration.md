

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

Removing an integration needs the `org:integrations` permission, which Sentry
grants to org owners and managers. If your CLI login predates that scope,
`sentry integration delete` asks you to re-authorize before removing anything.

Installing new integrations from the CLI is not supported yet.
