#!/usr/bin/env bash
# Pack @sentry/mcp-server, install the tarball into a clean consumer project,
# and typecheck it against the stdio transport exports and declarations that
# npm users get. Build workspace dependencies first, for example with
# `pnpm --filter '@sentry/mcp-server^...' --if-present run build`.
set -euo pipefail

package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

cd "$package_dir"
pnpm run build
pnpm pack --pack-destination "$work_dir"

cp -R test/package/consumer "$work_dir/consumer"
cd "$work_dir/consumer"
export npm_config_cache="$work_dir/npm-cache"
npm install --ignore-scripts --no-audit --no-fund --no-save \
  "$work_dir"/sentry-mcp-server-*.tgz typescript@^5.8.3 @types/node@^22
npx tsc -p .
echo "Packed @sentry/mcp-server typechecks in a clean consumer."
