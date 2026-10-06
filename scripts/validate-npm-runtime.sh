#!/usr/bin/env bash
# Run the same packed CLI under each supported Node version, without rebuilding.
set -euo pipefail

archive="${RUNTIME_ARCHIVE:-$RUNNER_TEMP/npm-package/package.tgz}"
test -s "$archive"
[[ "$(stat -c %s "$archive")" -le 52428800 ]]
runtime="$RUNNER_TEMP/runtime-$(node -p 'process.versions.node')"
npm install --ignore-scripts --no-audit --no-fund --prefix "$runtime" "$archive"
(
  cd "$runtime"
  node --input-type=module --eval '
    const sdk = await import(process.env.RUNTIME_PACKAGE);
    if (typeof sdk.default !== "function" || typeof sdk.createSentrySDK !== "function") {
      throw new Error("Missing ESM SDK exports");
    }
  '
  node --eval '
    const sdk = require(process.env.RUNTIME_PACKAGE);
    if (typeof sdk.default !== "function" || typeof sdk.createSentrySDK !== "function") {
      throw new Error("Missing CommonJS SDK exports");
    }
  '
)
binary="$runtime/node_modules/.bin/$RUNTIME_BIN"
test -x "$binary"
mkdir -p "$runtime/config"
export SENTRY_CONFIG_DIR="$runtime/config"
"$binary" --version
"$binary" --help > /dev/null
set +e
auth_output="$(
  SENTRY_AUTH_TOKEN='' SENTRY_TOKEN='' SENTRY_FORCE_ENV_TOKEN='' \
    "$binary" auth status 2>&1
)"
auth_status=$?
set -e
[[ "$auth_status" == 10 ]]
[[ "${auth_output,,}" == *"not authenticated"* ]]
