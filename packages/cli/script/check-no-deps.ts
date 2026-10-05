#!/usr/bin/env tsx
/**
 * Check for Runtime Dependencies
 *
 * Ensures package.json has no `dependencies` field. All packages must be
 * listed under `devDependencies` and bundled at build time via esbuild
 * (npm bundle) or fossilize (standalone binary). This keeps the published
 * package at zero install-time dependencies.
 *
 * Usage:
 *   tsx script/check-no-deps.ts
 *
 * Exit codes:
 *   0 - No runtime dependencies found
 *   1 - Runtime dependencies detected
 */

import { readFile } from "node:fs/promises";

const pkg: { dependencies?: Record<string, string> } = JSON.parse(
  await readFile("package.json", "utf-8")
);

const deps = Object.keys(pkg.dependencies ?? {});

if (deps.length === 0) {
  console.log("✓ No runtime dependencies in package.json");
  process.exit(0);
}

console.error("✗ Found runtime dependencies in package.json:");
console.error("");
for (const dep of deps) {
  console.error(`  - ${dep}: ${pkg.dependencies?.[dep]}`);
}
console.error("");
console.error(
  "All packages must be in devDependencies and bundled at build time."
);
console.error(
  "Move these to devDependencies: pnpm remove <pkg> && pnpm add -D <pkg>"
);

process.exit(1);
