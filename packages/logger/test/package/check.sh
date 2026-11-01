#!/usr/bin/env bash
# Pack @sentry/logger, install the tarball into a clean consumer project, and
# typecheck and run that project as ES modules and as CommonJS. The workspace
# imports the TypeScript source; this checks what npm users get instead.
set -euo pipefail

package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

cd "$package_dir"
pnpm run build
pnpm pack --pack-destination "$work_dir"

cp -R test/package/consumer "$work_dir/consumer"
cd "$work_dir/consumer"
npm install --ignore-scripts --no-audit --no-fund --no-save \
  "$work_dir"/sentry-logger-*.tgz typescript@^5.8.3 @types/node@^22
npx tsc -p .
node out/esm.js
node out/cjs.cjs
echo "Packed @sentry/logger works from ES modules and CommonJS."
