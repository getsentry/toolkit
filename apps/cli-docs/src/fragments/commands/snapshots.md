

## Examples

```bash
# Upload a folder of screenshots as a snapshot for an app
sentry snapshots upload ./screenshots --app-id com.example.app

# Upload only a subset of images (removals/renames not inferred on PRs)
sentry snapshots upload ./screenshots --app-id my-app --selective

# Only flag images that differ by more than 1%
sentry snapshots upload ./screenshots --app-id my-app --diff-threshold 0.01

# Compare two directories of snapshot images locally
sentry snapshots diff ./baseline ./head

# Fail (non-zero exit) if any images changed, with a custom threshold
sentry snapshots diff ./baseline ./head --fail-on-diff --threshold 0.02

# Download a specific baseline snapshot by ID
sentry snapshots download --snapshot-id 1234567890

# Download the latest baseline for an app, filtered by branch
sentry snapshots download --app-id my-app --branch main

# Extract images to a specific directory
sentry snapshots download --app-id my-app --output ./baseline/
```

## Important Notes

- `snapshots upload` scans a folder for PNG/JPEG images (skipping hidden files),
  uploads each to Sentry's object store — images already present are skipped by
  content hash — and creates a snapshot. **Sentry SaaS only.** A companion
  `<image>.json` sidecar adds per-image metadata; `--all-image-file-names`
  (or `--all-image-file-names-file`) lists the full suite for selective uploads.
  Each image must be at most 40,000,000 pixels. Git metadata is auto-collected
  in CI (see `build upload`); a `--pr-number` requires a resolvable base SHA.
- `snapshots diff` compares two local image directories (PNG/JPEG) perceptually
  — anti-aliasing aware, with a per-pixel `--threshold` (0.0–1.0) — and writes a
  PNG diff mask per changed image. It makes **no network requests**. Use
  `--fail-on-diff` to exit non-zero when any images changed/added/removed, and
  `--selective` to treat images missing from head as skipped rather than removed.
- `snapshots download` fetches baseline snapshot images from Sentry's preprod
  system and extracts them to a local directory. **Sentry SaaS only.**
- Provide exactly one of `--snapshot-id` (a direct artifact ID) or `--app-id`
  (resolves the latest baseline). `--branch` only applies with `--app-id`.
- With org auth tokens, resolving by `--app-id` requires `--project` (a project
  ID or slug).
- If the downloadable archive has not been built yet, the command triggers a
  build and waits for it (up to 5 minutes).
- Images are extracted to `./snapshots-base/` by default; override with
  `--output`.
- The organization is resolved from `--org`, `SENTRY_ORG`, config defaults, or a
  detected DSN.
