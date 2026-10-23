

## Xcode build step (`react-native xcode`)

`react-native xcode` runs inside an Xcode "Bundle React Native code and images"
build phase. It has three modes:

- **release build** — wraps the RN build script (standing in for
  `NODE_BINARY`/`HERMES_CLI_PATH`) to capture the produced bundle + sourcemap
  (including the Hermes combined sourcemap), then uploads them.
- **simulator build with `--allow-fetch`** — downloads the bundle + sourcemap
  from the running packager, then uploads.
- **debug build** — just runs the build script.

Release/distribution come from `SENTRY_RELEASE`/`SENTRY_DIST` or the app's
`Info.plist` (`<CFBundleIdentifier>@<CFBundleShortVersionString>+<CFBundleVersion>`),
unless `--no-auto-release` is set. When run outside an Xcode build phase the
release is discovered via `xcodebuild`; `--allow-xcode-infoplist-preprocessing`
enables `cc`-based `INFOPLIST_PREPROCESS` handling. Pass extra build-script
arguments after the flags.

## Important Notes

- `react-native gradle` is normally invoked automatically by the
  [sentry-android-gradle-plugin](https://docs.sentry.io/platforms/react-native/sourcemaps/);
  you rarely run it by hand.
- It injects a debug ID into both the bundle and its sourcemap, then uploads
  them under the `~/<filename>` convention. Without `--release` the files are
  matched by debug ID; with `--release` they are also uploaded for each
  `--dist`.
- `--wait`/`--wait-for` block until the server finishes processing the upload.
- Indexed/file RAM bundles (a pre-Hermes format that React Native has since
  deprecated) are not supported — use a plain or Hermes bundle.
