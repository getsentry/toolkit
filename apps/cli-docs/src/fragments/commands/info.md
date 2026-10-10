## Examples

```bash
# Print the resolved config and verify authentication
sentry info

# Verify only authentication (don't require a default org/project)
sentry info --no-defaults

# Machine-readable status for external tooling (always exits 0)
sentry info --config-status-json
```

## Important Notes

- `info` prints the resolved Sentry server URL and the default organization and
  project, then verifies your credentials against the server.
- The server URL comes from `SENTRY_URL`, the stored default, or the SaaS
  default; org/project come from `SENTRY_ORG`/`SENTRY_PROJECT` or stored
  defaults. `have_dsn` reflects whether `SENTRY_DSN` is set.
- Exits non-zero when authentication fails, or (unless `--no-defaults`) when no
  default organization/project is configured.
- `--config-status-json` emits a JSON status object (`config`, `auth`,
  `have_dsn`) for external tooling and **always exits 0** — it is a status
  report, not a check. For general machine-readable output use `--json`.
