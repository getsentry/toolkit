---
name: sentry-cli-react-native
version: 0.48.0-dev.0
description: Upload React Native sourcemaps from build steps
requires:
  bins: ["sentry"]
  auth: true
---

# React-native Commands

Upload React Native sourcemaps from build steps

### `sentry react-native gradle`

Upload a React Native bundle + sourcemap (Gradle build step)

**Flags:**
- `--sourcemap <value> - Path to the sourcemap to upload`
- `--bundle <value> - Path to the bundle to upload`
- `--release <value> - Release version to publish to`
- `--dist <value>... - Distribution(s) to publish (repeatable; requires --release)`
- `--wait - Wait for the server to fully process the uploaded files`
- `--wait-for <value> - Wait for processing, but at most this many seconds`

### `sentry react-native xcode <script-arg...>`

Upload React Native sourcemaps (Xcode build step)

**Flags:**
- `-f, --force - Run even in a debug configuration`
- `--allow-fetch - Fetch sourcemaps from the packager on simulator builds`
- `--fetch-from <value> - Packager URL to fetch from (default: http://127.0.0.1:8081/)`
- `--build-script <value> - Path to the react-native-xcode.sh build script`
- `--dist <value>... - Distribution(s) to publish (repeatable)`
- `--wait - Wait for the server to fully process the uploaded files`
- `--wait-for <value> - Wait for processing, but at most this many seconds`
- `--no-auto-release - Don't read the release from Xcode project files`
- `--allow-xcode-infoplist-preprocessing - Run the C preprocessor over Info.plist (INFOPLIST_PREPROCESS)`

**Examples:**

```bash
# Upload a bundle + sourcemap by debug ID (called by the Gradle plugin)
sentry react-native gradle \
  --bundle index.android.bundle \
  --sourcemap index.android.bundle.map

# Also associate with a release and distribution(s)
sentry react-native gradle \
  --bundle index.android.bundle \
  --sourcemap index.android.bundle.map \
  --release com.example.app@1.0.0 \
  --dist 1000

# Xcode build phase (usually added automatically to your build script)
sentry react-native xcode
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
