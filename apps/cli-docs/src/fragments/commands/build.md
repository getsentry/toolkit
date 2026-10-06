

## Examples

```bash
# Upload an Android build (APK or AAB) for size analysis
sentry build upload ./app-release.apk

# Upload an iOS build (XCArchive directory or IPA)
sentry build upload ./MyApp.xcarchive
sentry build upload ./MyApp.ipa

# Upload with a build configuration and release notes
sentry build upload ./app.aab --build-configuration Release --release-notes "Nightly"

# Tag a build with install groups (repeatable)
sentry build upload ./app.aab --install-group qa --install-group beta

# Attach explicit git metadata (otherwise auto-collected in CI)
sentry build upload ./app.aab --head-sha "$GIT_SHA" --pr-number 42 --base-ref main

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
- iOS caveat: `Assets.car` asset catalogs are **not** parsed into per-asset
  images (that required native macOS frameworks), so the server sees the raw
  `.car` rather than a per-image breakdown. XCArchive symlinks and Unix file
  permissions are preserved.
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
