

## Examples

```bash
# List organizations
sentry org list
```

```
SLUG           NAME                 ROLE
my-org         My Organization      owner
another-org    Another Org          member
```

```bash
# View organization details
sentry org view my-org
```

```
Organization: My Organization
Slug: my-org
Role: owner
Projects: 5
Teams: 3
Members: 12
```

```bash
# Open in browser
sentry org view my-org -w

# JSON output
sentry org list --json
```
