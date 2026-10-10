

## Examples

### Upload mapping files

```bash
# Upload a ProGuard/R8 mapping file
sentry proguard upload ./app/build/outputs/mapping/release/mapping.txt

# Upload multiple mapping files
sentry proguard upload mapping-release.txt mapping-debug.txt

# Validate without uploading (dry-run)
sentry proguard upload mapping.txt --no-upload

# Fail if no mapping files are provided (useful in CI)
sentry proguard upload ./mapping/ --require-one
```

### Compute UUID

```bash
# Compute the UUID for a ProGuard/R8 mapping file
sentry proguard uuid ./app/build/outputs/mapping/release/mapping.txt

# Output as JSON (includes the file path)
sentry proguard uuid mapping.txt --json
```

## Important Notes

- The UUID is **deterministically derived from the mapping file contents** —
  identical files always produce the same UUID. This is the same value
  Sentry uses to associate a mapping with obfuscated Android stack traces.
- This matches the UUID computed by the legacy `sentry-cli proguard uuid`
  command byte-for-byte.
