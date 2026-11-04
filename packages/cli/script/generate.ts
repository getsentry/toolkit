#!/usr/bin/env tsx
/**
 * Run the CLI's Code Generators in One Process
 *
 * Most generators read the route tree, and loading it through tsx is most of
 * what each of them costs. Run as separate `pnpm tsx` processes, they loaded
 * the tree once each and paid pnpm's startup every time. This runner loads it
 * once and runs every requested step in order, in two phases:
 *
 * 1. Steps the route tree depends on: the API schema, the grammar parsers,
 *    the output-schema field data that commands import, and the banner.
 *    Nothing in this phase may load the route tree.
 * 2. Steps that read the route tree. The runner writes stubs for the
 *    generated files the tree imports but these steps produce
 *    (`lib/route-tree-stubs.ts`), loads the tree, then runs each step. Step
 *    modules import the tree statically, so they are imported only here.
 *
 * Steps run in the order below, whatever order they are named in. Like
 * `pnpm tsx`, the runner loads `.env.local` when it exists and installs
 * `require-shim.mjs` before any step.
 *
 * Usage:
 *   tsx script/generate.ts docs                    # what generate:docs writes
 *   tsx script/generate.ts docs sdk                # everything, as `build` runs it
 *   tsx script/generate.ts skill                   # one step
 *   tsx script/generate.ts docs-sections --check   # exit 1 if a section is stale
 */

import "./require-shim.mjs";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeRouteTreeStubs } from "./lib/route-tree-stubs.js";

if (existsSync(".env.local")) {
  process.loadEnvFile(".env.local");
}

type Options = { check: boolean };

type Step = {
  name: string;
  /** Import the step's module. Route-tree steps import the tree statically. */
  load: () => Promise<{ emit: (options: Options) => Promise<void> }>;
};

/** Compile the grammars; a plain Node script shared with other packages. */
async function generateGrammar(): Promise<void> {
  execFileSync(process.execPath, ["../../scripts/generate-parsers.mjs", "."], {
    stdio: "inherit",
  });
}

/** Phase 1: steps whose outputs the route tree imports. */
const PRE_TREE_STEPS: readonly Step[] = [
  { name: "schema", load: () => import("./generate-api-schema.js") },
  { name: "grammar", load: async () => ({ emit: generateGrammar }) },
  {
    name: "output-schemas",
    load: () => import("./generate-output-schemas.js"),
  },
  { name: "banner", load: () => import("./generate-banner-image.js") },
];

/** Phase 2: steps that read the route tree. */
const TREE_STEPS: readonly Step[] = [
  { name: "command-api", load: () => import("./generate-command-api.js") },
  {
    name: "completions",
    load: () => import("./generate-completion-targets.js"),
  },
  {
    name: "top-level-routes",
    load: () => import("./generate-top-level-routes.js"),
  },
  { name: "command-docs", load: () => import("./generate-command-docs.js") },
  { name: "docs-sections", load: () => import("./generate-docs-sections.js") },
  { name: "skill", load: () => import("./generate-skill.js") },
  { name: "sdk", load: () => import("./generate-sdk.js") },
];

const STEP_NAMES = [...PRE_TREE_STEPS, ...TREE_STEPS].map((step) => step.name);
/** `docs`: everything but the SDK, which `generate:sdk` writes. */
const DOCS_STEPS = STEP_NAMES.filter((name) => name !== "sdk");

const args = process.argv.slice(2);
const options: Options = { check: args.includes("--check") };
const requested = new Set<string>();
for (const arg of args.filter((a) => a !== "--check")) {
  for (const name of arg === "docs" ? DOCS_STEPS : [arg]) {
    if (!STEP_NAMES.includes(name)) {
      throw new Error(
        `Unknown generator step "${arg}". Steps: docs, ${STEP_NAMES.join(", ")}`,
      );
    }
    requested.add(name);
  }
}

const preTreeSteps = PRE_TREE_STEPS.filter((step) => requested.has(step.name));
const treeSteps = TREE_STEPS.filter((step) => requested.has(step.name));

for (const step of preTreeSteps) {
  await (await step.load()).emit(options);
}

if (treeSteps.length > 0) {
  await writeRouteTreeStubs();
  await import("../src/app.js");
  for (const step of treeSteps) {
    await (await step.load()).emit(options);
    if (process.exitCode) {
      break;
    }
  }
}
