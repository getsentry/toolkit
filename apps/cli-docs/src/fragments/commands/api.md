

## Examples

Endpoints are relative to `/api/0/` — the prefix is added automatically. Absolute HTTP(S) Sentry URLs also work; their origin is validated against your authenticated host.

### GET requests

```bash
# List organizations
sentry api organizations/

# Get a specific issue
sentry api issues/123456789/
```

### POST requests

```bash
# Create a release
sentry api organizations/my-org/releases/ \
  -X POST -F version=1.0.0

# With inline JSON body
sentry api issues/123456789/ \
  -X POST -d '{"status": "resolved"}'
```

### PUT requests

```bash
# Update an issue status
sentry api issues/123456789/ \
  -X PUT -F status=resolved

# Assign an issue
sentry api issues/123456789/ \
  -X PUT --field assignedTo="user@example.com"
```

### DELETE requests

```bash
sentry api projects/my-org/my-project/ -X DELETE
```

### Advanced usage

```bash
# Add custom headers
sentry api organizations/ -H "X-Custom: value"

# Read body from a file
sentry api projects/my-org/my-project/releases/ -X POST --input release.json

# Verbose mode (shows full HTTP request/response)
sentry api organizations/ --verbose

# Preview the request without sending
sentry api organizations/ --dry-run
```

### Dataset Names

When querying the Events API (`/events/` endpoint), valid dataset values are: `spans`, `logs`, `errors`, `tracemetrics`, `profile_functions`, and `uptime_results`.

### Binary responses

Endpoints that return binary data — image attachments, minidumps, debug files — are streamed to stdout as raw bytes, so you can redirect them straight to a file:

```bash
sentry api "https://sentry.io/api/0/projects/my-org/my-project/events/EVENT_ID/attachments/ATTACHMENT_ID/?download=1" > screenshot.png
```

When the response is a PNG or JPEG image **and** you're on a graphics-capable terminal, the image is rendered inline instead of dumping raw bytes into your session. Terminals that speak the newer kitty graphics protocol (kitty, WezTerm, Ghostty, recent Konsole) are used in preference to sixel, which remains the fallback for older terminals. Redirecting or piping stdout always keeps the raw bytes. Set `SENTRY_NO_GRAPHICS=1` (or run `sentry cli defaults graphics off`) to disable inline rendering; `SENTRY_NO_SIXEL` is still honored as a deprecated alias.

For full API documentation, see the [Sentry API Reference](https://docs.sentry.io/api/).
