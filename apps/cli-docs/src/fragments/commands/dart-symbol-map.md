

## Important Notes

- The `--debug-id` flag is **required** — it associates the map with a native
  debug file (dSYM/ELF). The sentry-dart-plugin extracts this automatically.
- The mapping file must be a **JSON array of strings** with an even number of
  entries (alternating obfuscated/original name pairs).
- Supported on Sentry SaaS and self-hosted >= 25.8.0.
