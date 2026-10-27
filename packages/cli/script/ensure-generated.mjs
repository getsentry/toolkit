#!/usr/bin/env node
/**
 * Generate the gitignored `src/generated/` files when they are missing.
 *
 * A fresh checkout has no API schema, target parser, skill content, or
 * completion targets, so `pnpm run cli`, `typecheck`, and the tests used to
 * fail until contributors ran `generate:schema` and `generate:docs` by hand.
 * Scripts that need those files call this first, so there is no bootstrap
 * step to document or forget.
 *
 * Usage:
 *   node script/ensure-generated.mjs           # everything the CLI imports
 *   node script/ensure-generated.mjs schema    # only the API schema
 *
 * Plain Node (no tsx) so the check adds no noticeable startup time.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

const SCHEMA = "src/generated/api-schema.json";
/** Produced by `generate:grammar`; imported by `src/lib/arg-parsing.ts`. */
const GRAMMAR_OUTPUTS = [
  "src/generated/org-project-target-grammar.js",
  "src/generated/org-project-target-grammar.d.ts",
];
/** Produced by `generate:docs`; imported at runtime by `src/`. */
const DOCS_OUTPUTS = [
  "src/generated/command-api.json",
  "src/generated/skill-content.ts",
  "src/generated/completion-targets.json",
];

function run(script) {
  console.error(`Missing generated files; running \`pnpm run ${script}\`...`);
  execSync(`pnpm run ${script}`, { stdio: "inherit" });
}

if (!existsSync(SCHEMA)) {
  run("generate:schema");
}
if (process.argv[2] !== "schema" && !GRAMMAR_OUTPUTS.every(existsSync)) {
  run("generate:grammar");
}
if (process.argv[2] !== "schema" && !DOCS_OUTPUTS.every(existsSync)) {
  run("generate:docs");
}
