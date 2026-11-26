/**
 * Pack `@sentry/cli` from the `sentry` tarball.
 *
 * Usage (from packages/cli, after `npm pack`):
 *   pnpm run ts script/pack-npm-alias.ts
 *
 * Reads sentry-<version>.tgz and writes sentry-cli-<version>.tgz.
 */

import pkg from "../package.json" with { type: "json" };
import { NPM_ALIAS_NAME, packNpmAlias } from "./lib/npm-alias.js";
import { logger } from "../src/lib/logger.js";

await packNpmAlias(
  `sentry-${pkg.version}.tgz`,
  "packaging/npm-sentry-cli-README.md",
  ".",
);
logger.success(`Packed ${NPM_ALIAS_NAME}@${pkg.version}`);
