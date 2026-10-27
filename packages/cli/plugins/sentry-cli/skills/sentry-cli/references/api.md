---
name: sentry-cli-api
version: 0.48.0-dev.0
description: Make an authenticated API request
requires:
  bins: ["sentry"]
  auth: true
---

# API Commands

Make an authenticated API request

### `sentry api <endpoint>`

Make an authenticated API request

**Arguments:**

| Argument | Description |
|----------|-------------|
| `<endpoint>` | API endpoint relative to /api/0/, or an absolute HTTP(S) URL |

**Flags:**
- `-X, --method <value> - The HTTP method for the request - (default: "GET")`
- `-c, --cursor <value> - Navigate pages: "next", "prev", "first" (or raw cursor string)`
- `-d, --data <value> - Inline JSON body for the request (like curl -d)`
- `-F, --field <value>... - Add a typed parameter (key=value, key[sub]=value, key[]=value)`
- `-f, --raw-field <value>... - Add a string parameter without JSON parsing`
- `-H, --header <value>... - Add a HTTP request header in key:value format`
- `--input <value> - The file to use as body for the HTTP request (use "-" to read from standard input)`
- `--silent - Do not print the response body`
- `--verbose - Include full HTTP request and response in the output`
- `-n, --dry-run - Show the resolved request without sending it`

**Examples:**

```bash
# List organizations
sentry api organizations/

# Read a page and its pagination metadata
sentry api organizations/ -f per_page=2 --json

# Continue the same query using shared pagination
sentry api organizations/ -f per_page=2 --cursor next --json

# Return to the previously visited page
sentry api organizations/ -f per_page=2 --cursor prev --json

# Get a specific issue
sentry api issues/123456789/

# Create a release
sentry api organizations/my-org/releases/ -X POST -F version=1.0.0

# Update an issue status
sentry api issues/123456789/ -X PUT -F status=resolved

# Send an inline JSON body
sentry api issues/123456789/ -X PUT -d '{"status":"resolved"}'

# Set a nested field
sentry api projects/my-org/my-project/ -X PUT -F options[sampleRate]=0.5

# Assign an issue
sentry api issues/123456789/ -X PUT --field assignedTo="user@example.com"

# Delete a project
sentry api projects/my-org/my-project/ -X DELETE

# Add custom headers
sentry api organizations/ -H "X-Custom: value"

# Read the request body from a file
sentry api projects/my-org/my-project/releases/ -X POST --input release.json

# Show the full HTTP request and response
sentry api organizations/ --verbose

# Preview the request without sending it
sentry api organizations/ --dry-run

# Save a binary response, such as an event attachment, to a file
sentry api "https://sentry.io/api/0/projects/my-org/my-project/events/EVENT_ID/attachments/ATTACHMENT_ID/?download=1" > screenshot.png
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
