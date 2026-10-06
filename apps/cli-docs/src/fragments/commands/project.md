

## Examples

```bash
# List all projects in an org
sentry project list my-org/
```

```
ORG         SLUG           PLATFORM      TEAM
my-org      frontend       javascript    web-team
my-org      backend        python        api-team
my-org      mobile-ios     cocoa         mobile-team
```

```bash
# Filter by platform
sentry project list my-org/ --platform javascript

# View project details
sentry project view my-org/frontend
```

```
Project: frontend
Organization: my-org
Platform: javascript
Team: web-team
DSN: https://abc123@sentry.io/123456
```

```bash
# Open project in browser
sentry project view my-org/frontend -w
```

### Create a project

```bash
# Every project is a name:platform pair; project names cannot contain whitespace
# Create a new project
sentry project create my-new-app:javascript-nextjs

# Create several projects with their own platforms
sentry project create web:javascript api:python-django worker:node

# Create under a specific org and team
sentry project create my-org/my-new-app:python --team backend-team

# Preview without creating
sentry project create my-new-app:node --dry-run
```

### Delete a project

```bash
# Delete a project (will prompt for confirmation)
sentry project delete my-org/old-project

# Delete without confirmation
sentry project delete my-org/old-project --yes
```
