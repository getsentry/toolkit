#!/bin/sh
# Pack @sentry/logger, install the tarball into a clean consumer project, and
# typecheck and run that project as ES modules and as CommonJS. The workspace
# imports the TypeScript source; this checks what npm users get instead.
#
# The consumer type-checks with TypeScript 5 and 7, with strict consumer
# options and library checks on, under Node and bundler module resolution.
set -eu

package_dir=$(cd "$(dirname "$0")/../.." && pwd)
work_dir=$(mktemp -d)
cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$package_dir"
pnpm run build
pnpm pack --pack-destination "$work_dir"

for typescript in typescript@^5.8.3 typescript@^7.0.2; do
  consumer_dir="$work_dir/consumer-${typescript#typescript@^}"
  cp -R "$package_dir/test/package/consumer" "$consumer_dir"
  cd "$consumer_dir"
  npm install --ignore-scripts --no-audit --no-fund --no-save \
    "$work_dir"/sentry-logger-*.tgz "$typescript" @types/node@^22
  npx tsc -p tsconfig.json
  npx tsc -p tsconfig.bundler.json
  node out/esm.js
  node out/cjs.cjs
  printf 'Packed @sentry/logger works with %s.\n' "$typescript"
done
printf '%s\n' "Packed @sentry/logger works from ES modules and CommonJS."
