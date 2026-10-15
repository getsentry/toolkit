

## Examples

```bash
# Download a build artifact by ID
sentry build download 1234567890

# Download to a specific path
sentry build download 1234567890 --output ./app.ipa

# Output the result as JSON
sentry build download 1234567890 --json
```

## Important Notes

- `build upload` supports **Android APK/AAB** and **iOS XCArchive/IPA**. An
  XCArchive is a directory; an IPA is converted to an XCArchive layout for
  upload. **Sentry SaaS only.**
- `--dsym` attaches debug symbols to a **single IPA** upload. Repeat the flag
  for multiple inputs: each may be a `.dSYM` bundle, a directory of bundles,
  or a ZIP of either. Symlinks, unsafe ZIP paths, checksum mismatches, empty
  bundles, and duplicate bundle names are rejected. IPA and dSYM contents are
  streamed from disk.
- The **macOS arm64 standalone binary** expands iOS `.car` asset catalogs with
  CoreUI on macOS 13, 14, 15, and 26. It adds the legacy `ParsedAssets/` manifest
  and decoded images for per-asset size analysis and image optimization insights.
  Other runtimes, or failed extractions, upload the original catalogs unchanged.
  XCArchive symlinks and Unix file permissions are preserved.
- Multiple paths may be uploaded at once; the command exits non-zero if any
  build fails to upload.
- Git metadata (commit, branch, PR number, repo) is **auto-collected in CI**
  (GitHub Actions env vars + the local git repo). Use `--no-git-metadata` to
  disable it, `--force-git-metadata` to collect outside CI, or the explicit
  `--head-sha` / `--base-sha` / `--head-ref` / `--base-ref` / `--pr-number` /
  `--vcs-provider` / `--head-repo-name` / `--base-repo-name` flags to override.
- `build download` fetches a mobile build artifact (APK or IPA) previously
  uploaded to Sentry's preprod system for size analysis. **Sentry SaaS only.**
- The build must be installable. Builds that are still processing — or that have
  no downloadable artifact — cannot be downloaded.
- Without `--output`, the artifact is saved as
  `preprod_artifact_<build-id>.<ext>` in the current directory.
- The organization is resolved from `--org`, `SENTRY_ORG`, config defaults, or a
  detected DSN.
