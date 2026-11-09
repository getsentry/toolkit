#!/usr/bin/env tsx
/**
 * Run the CLI's Code Generators in One Process
 *
 * Most generators read the route tree, and loading it through tsx is most of
 * what each of them costs. Run as separate `pnpm tsx` processes, they loaded
 * the tree once each and paid pnpm's startup every time. This runner loads it
 * once and runs every requested step in two phases:
 *
 * 1. Steps the route tree depends on: the API schema, the grammar parsers,
 *    the output-schema field data that commands import, the banner, and
 *    the `sentry init` guide.
 *    They are independent of each other and run concurrently; the grammar
 *    compiles in a child process. Nothing in this phase may load the route
 *    tree. A step that lists its `files` is skipped when their content
 *    matches its last run.
 * 2. Steps that read the route tree. The runner writes stubs for the
 *    generated files the tree imports but these steps produce
 *    (`lib/route-tree-stubs.ts`), loads the tree, then runs each step in
 *    the order below, whatever order they are named in. Step modules import
 *    the tree statically, so they are imported only here.
 *
 * Work a phase-2 step can do without the tree starts with the run, in its
 * `prepare`: `command-api` parses `src/` in a worker thread while phase 1
 * runs and the tree loads.
 *
 * Like `pnpm tsx`, the runner loads `.env.local` when it exists and installs
 * `require-shim.mjs` before any step.
 *
 * Usage:
 *   tsx script/generate.ts docs                    # what generate:docs writes
 *   tsx script/generate.ts docs sdk                # everything, as `build` runs it
 *   tsx script/generate.ts skill                   # one step
 *   tsx script/generate.ts docs-sections --check   # exit 1 if a section is stale
 */

import "./require-shim.mjs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { commandApiAnalysis } from "./lib/command-api-analysis.js";
import { writeRouteTreeStubs } from "./lib/route-tree-stubs.js";
import {
  packageManifest,
  runUnlessUnchanged,
  type StepFiles,
} from "./lib/step-stamp.js";

try {
  process.loadEnvFile(".env.local");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
    throw error;
  }
}

type Options = { check: boolean };

type Step = {
  name: string;
  /** Import the step's module. Route-tree steps import the tree statically. */
  load: () => Promise<{ emit: (options: Options) => Promise<void> }>;
  /**
   * Phase 1 only: what the step reads and writes, so the runner can skip it
   * when neither changed (`lib/step-stamp.ts`). Evaluated before `load`, so
   * a skipped step's dependencies are never imported.
   */
  files?: () => StepFiles;
  /**
   * Phase 2 only: start work that needs no route tree, such as a worker
   * thread, as the run begins, so it overlaps phase 1 and the tree load.
   * `after(name)` settles when that phase-1 step does (at once if it was
   * not requested). `emit` awaits the work.
   */
  prepare?: (after: (name: string) => Promise<void>) => void;
};

const GRAMMAR_SCRIPT = "../../scripts/generate-parsers.mjs";

/** Compile the grammars; a plain Node script shared with other packages. */
async function generateGrammar(): Promise<void> {
  const child = spawn(process.execPath, [GRAMMAR_SCRIPT, "."], {
    stdio: "inherit",
  });
  const [code, signal] = (await once(child, "exit")) as [
    number | null,
    NodeJS.Signals | null,
  ];
  if (code !== 0) {
    throw new Error(`${GRAMMAR_SCRIPT} exited with ${signal ?? code}`);
  }
}

/** The API schema: the SDK's operation catalog, projected. */
function schemaFiles(): StepFiles {
  return {
    inputs: [
      fileURLToPath(import.meta.resolve("@sentry/api/operations")),
      "script/generate-api-schema.ts",
      "script/lib/api-schema.ts",
      "../toolkit-core/src/api-client/idempotent-operations.ts",
      "../toolkit-core/src/api-client/retry.ts",
    ],
    outputs: [
      "src/generated/api-schema.json",
      "src/generated/idempotent-operations.json",
    ],
  };
}

/** Each `grammar/<name>.pegjs` and its `.d.ts` become `<name>-grammar.*`. */
function grammarFiles(): StepFiles {
  const sources = readdirSync("grammar").sort();
  const names = sources
    .filter((file) => file.endsWith(".pegjs"))
    .map((file) => file.slice(0, -".pegjs".length));
  return {
    inputs: [
      ...sources.map((file) => `grammar/${file}`),
      GRAMMAR_SCRIPT,
      packageManifest("peggy", GRAMMAR_SCRIPT),
      packageManifest("typescript", GRAMMAR_SCRIPT),
    ],
    outputs: names.flatMap((name) => [
      `src/generated/${name}-grammar.js`,
      `src/generated/${name}-grammar.d.ts`,
    ]),
  };
}

function bannerFiles(): StepFiles {
  const script = "script/generate-banner-image.ts";
  return {
    inputs: [
      "assets/banner-mask.png",
      script,
      packageManifest("pngjs", script),
    ],
    outputs: ["src/generated/banner-image.ts"],
  };
}

function initGuideFiles(): StepFiles {
  return {
    inputs: ["init.md", "script/generate-init-guide.ts"],
    outputs: ["src/generated/init-guide.ts"],
  };
}

/**
 * Phase 1: steps whose outputs the route tree imports. `output-schemas`
 * has no `files`: it loads `src/output-schemas/` and everything that
 * imports, which is no short list.
 */
const PRE_TREE_STEPS: readonly Step[] = [
  {
    name: "schema",
    load: () => import("./generate-api-schema.js"),
    files: schemaFiles,
  },
  {
    name: "grammar",
    load: async () => ({ emit: generateGrammar }),
    files: grammarFiles,
  },
  {
    name: "output-schemas",
    load: () => import("./generate-output-schemas.js"),
  },
  {
    name: "banner",
    load: () => import("./generate-banner-image.js"),
    files: bannerFiles,
  },
  {
    name: "init-guide",
    load: () => import("./generate-init-guide.js"),
    files: initGuideFiles,
  },
];

/** Phase 2: steps that read the route tree. */
const TREE_STEPS: readonly Step[] = [
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
  // Last: its emit waits for the worker `prepare` starts, and no step reads
  // `command-api.json` back (only `sentry schema` does, at runtime).
  {
    name: "command-api",
    load: () => import("./generate-command-api.js"),
    prepare: (after) => {
      void commandApiAnalysis(after("schema"));
    },
  },
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

async function runPreTreeStep(step: Step): Promise<void> {
  const emit = async () => {
    await (await step.load()).emit(options);
  };
  if (step.files) {
    await runUnlessUnchanged(step.name, step.files(), emit);
  } else {
    await emit();
  }
}

const preTreeRuns = new Map(
  preTreeSteps.map((step) => [step.name, runPreTreeStep(step)] as const),
);
for (const step of treeSteps) {
  step.prepare?.((name) => preTreeRuns.get(name) ?? Promise.resolve());
}
await Promise.all(preTreeRuns.values());

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
