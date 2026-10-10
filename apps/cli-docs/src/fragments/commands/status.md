

## Examples

```bash
# Show the current status of Sentry's services
sentry status
```

```
✓ All Systems Operational

### Components

● Dashboard — Operational
● US Error Ingestion — Operational

See https://status.sentry.io for full details.
```

```bash
# Get machine-readable status (useful in scripts)
sentry status --json
```

```bash
# Check a self-hosted or regional status page (Statuspage CNAME)
sentry status --url https://status.acme.com
```
