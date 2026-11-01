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
 *   node script/ensure-generated.mjs                 # everything the CLI imports
 *   node script/ensure-generated.mjs schema          # only the API schema
 *   node script/ensure-generated.mjs schema grammar  # the schema and parsers
 *
 * Plain Node (no tsx) so the check adds no noticeable startup time.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

/** Produced by `generate:schema`; imported at runtime by `src/`. */
const SCHEMA_OUTPUTS = [
  "src/generated/api-schema.json",
  "src/generated/idempotent-operations.json",
];
/** Produced by `generate:grammar`; imported by `src/lib/arg-parsing.ts`. */
const GRAMMAR_OUTPUTS = [
  "src/generated/org-project-target-grammar.js",
  "src/generated/org-project-target-grammar.d.ts",
  "src/generated/field-list-grammar.js",
  "src/generated/field-list-grammar.d.ts",
];
/** Produced by `generate:docs`; imported at runtime by `src/`. */
const DOCS_OUTPUTS = [
  "src/generated/command-api.json",
  "src/generated/skill-content.ts",
  "src/generated/completion-targets.json",
];

function run(script) {
  console.error(`Missing generated files; running \`pnpm run ${script}\`...`);
  // Send generator output to stderr: `pnpm run cli mcp` serves JSON-RPC on
  // stdout, so nothing else may write there.
  execSync(`pnpm run ${script}`, { stdio: ["inherit", 2, "inherit"] });
}

/** The groups named on the command line, or every group when none are. */
const groups = process.argv.slice(2);
function wants(group) {
  return groups.length === 0 || groups.includes(group);
}

if (!SCHEMA_OUTPUTS.every(existsSync)) {
  run("generate:schema");
}
if (wants("grammar") && !GRAMMAR_OUTPUTS.every(existsSync)) {
  run("generate:grammar");
}
if (wants("docs") && !DOCS_OUTPUTS.every(existsSync)) {
  run("generate:docs");
}
