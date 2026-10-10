

## Examples

```bash
# Upload a dart symbol map with a debug ID
sentry dart-symbol-map upload --debug-id 12345678-1234-1234-1234-123456789abc mapping.json

# Validate without uploading
sentry dart-symbol-map upload --debug-id 12345678-1234-1234-1234-123456789abc mapping.json --no-upload

# Output as JSON
sentry dart-symbol-map upload --debug-id 12345678-1234-1234-1234-123456789abc mapping.json --json
```

## Important Notes

- The `--debug-id` flag is **required** — it associates the map with a native
  debug file (dSYM/ELF). The sentry-dart-plugin extracts this automatically.
- The mapping file must be a **JSON array of strings** with an even number of
  entries (alternating obfuscated/original name pairs).
- Supported on Sentry SaaS and self-hosted >= 25.8.0.
