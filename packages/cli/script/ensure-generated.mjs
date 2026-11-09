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
import { existsSync, readFileSync, statSync } from "node:fs";
import { ROUTE_TREE_STUBS } from "./lib/route-tree-stub-files.mjs";

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
  "src/generated/output-schemas",
  "src/generated/command-api.json",
  "src/generated/skill-content.ts",
  "src/generated/completion-targets.json",
  "src/generated/top-level-routes.json",
  "src/generated/init-guide.ts",
];

const STUBS = new Map(ROUTE_TREE_STUBS);

/**
 * Whether `path` holds generated output. A file that still holds its
 * route-tree stub does not: scripts that load the tree without generating,
 * such as `check-fragments`, write stubs and leave them behind.
 */
function isGenerated(path) {
  if (!existsSync(path)) {
    return false;
  }
  const stub = STUBS.get(path);
  // Compare sizes first so generated files are not read.
  return (
    stub === undefined ||
    statSync(path).size !== Buffer.byteLength(stub) ||
    readFileSync(path, "utf8") !== stub
  );
}

function run(script) {
  // oxlint-disable-next-line no-console -- plain Node: this runs before tsx, so it cannot load the TypeScript logger.
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
if (wants("docs") && !DOCS_OUTPUTS.every(isGenerated)) {
  run("generate:docs");
}
