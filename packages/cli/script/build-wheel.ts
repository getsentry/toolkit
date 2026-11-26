/**
 * Build the PyPI wheel of one standalone binary.
 *
 * Usage (from packages/cli, after `pnpm run build -- --target <target>`):
 *   pnpm run ts script/build-wheel.ts linux-x64
 *
 * Reads dist-bin/sentry-<target>[.exe] and writes dist-wheel/<wheel>.whl.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { buildWheel, WHEEL_TARGETS } from "./lib/python-wheel.js";
import { logger } from "../src/lib/logger.js";

const OUT_DIR = "dist-wheel";

const target = process.argv[2] ?? "";
const exe = WHEEL_TARGETS[target]?.exe;
if (!exe) {
  logger.error(
    `Usage: build-wheel.ts <target>, one of: ${Object.keys(WHEEL_TARGETS).join(", ")}`,
  );
  process.exit(1);
}

const [binary, readme, license] = await Promise.all([
  readFile(join("dist-bin", `sentry-${target}${extname(exe)}`)),
  readFile("packaging/pypi-README.md", "utf-8"),
  readFile("LICENSE.md", "utf-8"),
]);
const wheel = buildWheel({
  target,
  version: pkg.version,
  binary,
  summary: pkg.description,
  readme,
  license,
});
await mkdir(OUT_DIR, { recursive: true });
await writeFile(join(OUT_DIR, wheel.filename), wheel.contents);
logger.success(`Built ${OUT_DIR}/${wheel.filename}`);
