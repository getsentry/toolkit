#!/usr/bin/env tsx
/**
 * Local benchmark harness for DSN detection, project-root finding, and
 * (after the `src/lib/scan/` refactor lands) the generic scanner module.
 *
 * Goals:
 *   1. Capture objective baselines *before* the scanner refactor so we can
 *      verify that the new pure-TS implementation lands within ~1.2x.
 *   2. Feed data-driven decisions for the worker-pool + caching follow-ups.
 *   3. Use operation labels that match the Sentry spans already emitted in
 *      production (`findProjectRoot`, `scanCodeForDsns`, etc.) so local
 *      numbers correlate with prod telemetry.
 *
 * The harness is deliberately zero-dependency: it builds synthetic repos
 * from `test/fixtures/bench/` (parameterized + deterministic) or, if you
 * pass `--repo /path` or set `BENCH_REPO=`, benches against a real repo.
 * Baselines go to `.bench/baseline.json` (gitignored) — they're machine-
 * specific and intentionally not version-controlled.
 *
 * Usage:
 *   pnpm run bench                        # all ops, all preset sizes
 *   pnpm run bench -- --size small        # only the 'small' preset
 *   pnpm run bench -- --op detectDsn.cold # filter by operation (substring)
 *   pnpm run bench -- --repo /path/to/repo  # bench a real repo (disables --save-baseline)
 *   pnpm run bench -- --warmup 3 --runs 10  # override default run counts
 *   pnpm run bench -- --json > report.json  # machine-readable stdout
 *   pnpm run bench -- --save-baseline     # write .bench/baseline.json
 *   pnpm run bench -- --compare           # diff current vs .bench/baseline.json
 *                                         # (exit 1 if any p50 regresses >20%)
 *   pnpm run bench -- --regen-fixtures    # force fixture regeneration
 *
 * Environment variables:
 *   BENCH_REPO       Path to a real repo (equivalent to --repo)
 *   BENCH_RUNS       Default measured run count (default: 10)
 *   BENCH_WARMUP     Default warmup run count (default: 3)
 *   BENCH_THRESHOLD  Default regression threshold for --compare (default: 0.2)
 *
 * Exit codes:
 *   0 - Bench completed; no regression on --compare
 *   1 - Invalid args, or --compare detected a p50 regression over threshold
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type FixtureSpec,
  generateFixture,
  hashSpec,
} from "../test/fixtures/bench/generate.js";
import {
  type BenchEntry,
  type BenchReport,
  clearDsnDetectionCache,
  compareReports,
  measure,
  printComparison,
  printReport,
  runtimeInfo,
  summarize,
  withBenchDb,
  writeJsonReport,
} from "../test/fixtures/bench/helpers.js";
import {
  PRESET_NAMES,
  PRESETS,
  type PresetName,
} from "../test/fixtures/bench/presets.js";

/**
 * The DSN scanner's hot regex. Pinned at module scope per Biome's
 * `useTopLevelRegex` rule; reused by the `scan.grepFiles` op.
 */
const DSN_PATTERN =
  /https?:\/\/[a-z0-9]+(?::[a-z0-9]+)?@[a-z0-9.-]+(?:\.[a-z]+|:[0-9]+)\/\d+/i;

// -------- Arg parsing --------

type CliArgs = {
  sizes: readonly PresetName[];
  opFilter: string | undefined;
  repo: string | undefined;
  runs: number;
  warmup: number;
  json: boolean;
  saveBaseline: boolean;
  compare: boolean;
  regenFixtures: boolean;
  thresholdPct: number;
};

type ParseState = {
  sizes: PresetName[];
  opFilter: string | undefined;
  repo: string | undefined;
  runs: number;
  warmup: number;
  json: boolean;
  saveBaseline: boolean;
  compare: boolean;
  regenFixtures: boolean;
};

/** Apply a single flag (and its optional value) to the mutable parse state. */
function applyFlag(
  state: ParseState,
  arg: string,
  next: string | undefined
): boolean {
  switch (arg) {
    case "--size": {
      if (!next) {
        throw new Error("--size requires a value");
      }
      if (next === "all") {
        state.sizes = [...PRESET_NAMES];
      } else if ((PRESET_NAMES as readonly string[]).includes(next)) {
        state.sizes = [next as PresetName];
      } else {
        throw new Error(
          `Unknown size '${next}'. Valid: ${PRESET_NAMES.join(", ")}, all`
        );
      }
      return true;
    }
    case "--op": {
      if (!next) {
        throw new Error("--op requires a value");
      }
      state.opFilter = next;
      return true;
    }
    case "--repo": {
      if (!next) {
        throw new Error("--repo requires a path");
      }
      state.repo = next;
      return true;
    }
    case "--runs": {
      if (!next) {
        throw new Error("--runs requires a number");
      }
      state.runs = Number(next);
      return true;
    }
    case "--warmup": {
      if (!next) {
        throw new Error("--warmup requires a number");
      }
      state.warmup = Number(next);
      return true;
    }
    case "--json":
      state.json = true;
      return false;
    case "--save-baseline":
      state.saveBaseline = true;
      return false;
    case "--compare":
      state.compare = true;
      return false;
    case "--regen-fixtures":
      state.regenFixtures = true;
      return false;
    case "-h": {
      printHelp();
      process.exit(0);
      break;
    }
    case "--help": {
      printHelp();
      process.exit(0);
      break;
    }
    default:
      throw new Error(`Unknown flag: ${arg}`);
  }
}

function parseArgs(argv: readonly string[]): CliArgs {
  const state: ParseState = {
    sizes: [...PRESET_NAMES],
    opFilter: undefined,
    repo: process.env.BENCH_REPO,
    runs: Number(process.env.BENCH_RUNS ?? 10),
    warmup: Number(process.env.BENCH_WARMUP ?? 3),
    json: false,
    saveBaseline: false,
    compare: false,
    regenFixtures: false,
  };
  const thresholdPct = Number(process.env.BENCH_THRESHOLD ?? 0.2);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const next = argv[i + 1];
    if (applyFlag(state, arg, next)) {
      i += 1;
    }
  }

  if (!Number.isFinite(state.runs) || state.runs < 1) {
    throw new Error("--runs must be >= 1");
  }
  if (!Number.isFinite(state.warmup) || state.warmup < 0) {
    throw new Error("--warmup must be >= 0");
  }
  if (state.saveBaseline && state.repo) {
    throw new Error(
      "--save-baseline is only valid with synthetic fixtures; remove --repo/BENCH_REPO"
    );
  }

  return { ...state, thresholdPct };
}

function printHelp(): void {
  console.log(
    "Usage: pnpm run bench [-- --size small|medium|large|all] [--op NAME] [--repo PATH]"
  );
  console.log("                      [--runs N] [--warmup N]");
  console.log(
    "                      [--json] [--save-baseline] [--compare] [--regen-fixtures]"
  );
}

// -------- Fixture resolution --------

type FixtureHandle = {
  label: string;
  rootDir: string;
  /** True when the fixture is an ephemeral synthetic tree that we may discard. */
  synthetic: boolean;
  /** Reported file count for the header / JSON. */
  fileCount: number;
};

// biome-ignore-start lint/suspicious/noBitwiseOperators: FNV-1a is a bitwise hash
/** 32-bit FNV-1a hash of a string — supplies a stable per-preset seed. */
function hashToSeed(s: string): number {
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < s.length; i += 1) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01_00_01_93);
  }
  // Keep the result in the 32-bit signed range for determinism across engines.
  return h >>> 0;
}
// biome-ignore-end lint/suspicious/noBitwiseOperators: FNV-1a is a bitwise hash

/** Build (or reuse) a synthetic fixture for the given preset. */
function resolveSyntheticFixture(
  name: PresetName,
  forceRegen: boolean
): FixtureHandle {
  const preset = PRESETS[name];
  // Deterministic seed per preset so every contributor lands on the same tree.
  // We XOR an anchor constant with the per-preset name hash so seeds are
  // spread across the 32-bit space even when preset names are similar.
  // biome-ignore lint/suspicious/noBitwiseOperators: deterministic 32-bit seed mix
  const seed = (0xde_ad_be_ef ^ hashToSeed(name)) >>> 0;
  const specNoRoot = { ...preset, seed };
  const hash = hashSpec(specNoRoot);
  const rootDir = join(tmpdir(), "sentry-cli-bench", `fx-${name}-${hash}`);
  mkdirSync(rootDir, { recursive: true });
  if (forceRegen) {
    rmSync(rootDir, { recursive: true, force: true });
    mkdirSync(rootDir, { recursive: true });
  }
  const spec: FixtureSpec = { ...preset, seed, rootDir };
  const meta = generateFixture(spec, { force: forceRegen });
  return {
    label: `synthetic/${name}`,
    rootDir,
    synthetic: true,
    fileCount: meta.fileCount,
  };
}

/** Count files under a path with a lightweight walk (used for real-repo headers). */
async function roughFileCount(root: string): Promise<number> {
  const skip = new Set([
    ".git",
    "node_modules",
    "dist",
    "build",
    ".venv",
    "venv",
  ]);
  let count = 0;
  async function walk(dir: string): Promise<void> {
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) {
          await walk(join(dir, entry.name));
        }
      } else if (entry.isFile()) {
        count += 1;
      }
    }
  }
  await walk(root);
  return count;
}

// -------- Operation registry --------

type OpRunner = (cwd: string) => Promise<unknown>;
type OpEntry = {
  label: string;
  warm: boolean;
  /** Called before every measured iteration — use for cold-cache resets. */
  setup?: (cwd: string) => Promise<void>;
  run: OpRunner;
};

async function buildOps(): Promise<OpEntry[]> {
  // Lazy-import production code so unit tests can import the helpers/fixtures
  // without loading all of @sentry/node-core.
  const { detectDsn, detectAllDsns } = await import(
    "../src/lib/dsn/detector.js"
  );
  const { findProjectRoot } = await import("../src/lib/dsn/project-root.js");
  const { scanCodeForDsns, scanCodeForFirstDsn } = await import(
    "../src/lib/dsn/code-scanner.js"
  );
  // Scan module — not yet wired into DSN detection (PR 3 will do that).
  // These ops give us standalone baselines so PR 2/PR 3 can compare.
  const { walkFiles, IgnoreStack, TEXT_EXTENSIONS, collectGrep } = await import(
    "../src/lib/scan/index.js"
  );
  // DSN-parity preset — used by the `scan.walk.dsnParity` op below.
  const { dsnScanOptions } = await import("../src/lib/dsn/scan-options.js");

  const coldSetup = (cwd: string) => clearDsnDetectionCache(cwd);

  return [
    {
      label: "findProjectRoot",
      warm: false,
      setup: coldSetup,
      run: async (cwd) => {
        await findProjectRoot(cwd);
      },
    },
    {
      label: "detectDsn.cold",
      warm: false,
      setup: coldSetup,
      run: async (cwd) => {
        await detectDsn(cwd);
      },
    },
    {
      label: "detectDsn.warm",
      warm: true,
      // No setup hook — leverage whatever the previous run cached.
      run: async (cwd) => {
        await detectDsn(cwd);
      },
    },
    {
      label: "detectAllDsns.cold",
      warm: false,
      setup: coldSetup,
      run: async (cwd) => {
        await detectAllDsns(cwd);
      },
    },
    {
      label: "detectAllDsns.warm",
      warm: true,
      run: async (cwd) => {
        await detectAllDsns(cwd);
      },
    },
    {
      label: "scanCodeForDsns",
      warm: false,
      // scanCodeForDsns bypasses the cache entirely — no setup needed, but we
      // still clear so any sibling-test leftover doesn't skew timings.
      setup: coldSetup,
      run: async (cwd) => {
        await scanCodeForDsns(cwd);
      },
    },
    {
      label: "scanCodeForFirstDsn",
      warm: false,
      setup: coldSetup,
      run: async (cwd) => {
        await scanCodeForFirstDsn(cwd);
      },
    },
    {
      // scan.walk — iterate the walker with the DSN scanner's extension
      // allowlist. This is the closest standalone comparison point with
      // `scanCodeForDsns` (same file set, just no regex work).
      label: "scan.walk",
      warm: false,
      run: async (cwd) => {
        // We intentionally discard the entries — the bench measures
        // the cost of iterating the generator, not anything downstream.
        for await (const _ of walkFiles({
          cwd,
          extensions: TEXT_EXTENSIONS,
        })) {
          // body intentionally empty
        }
      },
    },
    {
      // scan.walk.noExt — no extension filter, so every unknown-extension
      // file is opened and sniffed for NUL. Tells us how expensive lazy
      // binary detection is on mixed trees.
      label: "scan.walk.noExt",
      warm: false,
      run: async (cwd) => {
        for await (const _ of walkFiles({ cwd })) {
          // body intentionally empty
        }
      },
    },
    {
      // scan.walk.dsnParity — walker configured with the DSN scanner's
      // exact options (TEXT_EXTENSIONS + full skip list + depth 3 with
      // monorepo reset). This is the apples-to-apples comparison with
      // `scanCodeForDsns`; the success bar for PR 1.5 is p50 ≤ 1.2x.
      label: "scan.walk.dsnParity",
      warm: false,
      run: async (cwd) => {
        for await (const _ of walkFiles({ cwd, ...dsnScanOptions() })) {
          // body intentionally empty
        }
      },
    },
    {
      // scan.grepFiles — walker + regex pass using the same DSN
      // preset. Adds the per-file `readFile` + line-by-line
      // `regex.test` cost on top of `scan.walk.dsnParity` so PR 3
      // has a direct apples-to-apples comparison with
      // `scanCodeForDsns` (which does the same work).
      label: "scan.grepFiles",
      warm: false,
      run: async (cwd) => {
        await collectGrep({
          cwd,
          pattern: DSN_PATTERN,
          ...dsnScanOptions(),
        });
      },
    },
    {
      // scan.ignore — micro-benchmark for IgnoreStack.isIgnored(). We
      // build a stack once then hit it 10k times with synthetic paths
      // so the reported timing is dominated by the query itself, not
      // tree walking.
      label: "scan.ignore",
      warm: false,
      run: async (cwd) => {
        const stack = await IgnoreStack.create({
          cwd,
          alwaysSkipDirs: ["node_modules", ".git", "dist", "build"],
          respectGitignore: true,
          includeGitInfoExclude: true,
        });
        const queries = [
          "src/index.ts",
          "node_modules/foo/bar.js",
          "packages/pkg/src/deep/file.tsx",
          "dist/bundle.js",
          "build/out.css",
          "test/fixtures/secret.env",
          "README.md",
          ".git/HEAD",
        ];
        for (let i = 0; i < 10_000; i += 1) {
          const q = queries[i % queries.length] as string;
          stack.isIgnored(q, false);
        }
      },
    },
  ];
}

// -------- Main --------

/** Resolve the fixture list for this invocation (synthetic or real repo). */
async function resolveFixtures(args: CliArgs): Promise<FixtureHandle[]> {
  if (args.repo) {
    const abs = resolve(args.repo);
    if (!existsSync(abs)) {
      throw new Error(`--repo ${abs} does not exist`);
    }
    return [
      {
        label: `real:${abs}`,
        rootDir: abs,
        synthetic: false,
        fileCount: await roughFileCount(abs),
      },
    ];
  }
  return args.sizes.map((size) =>
    resolveSyntheticFixture(size, args.regenFixtures)
  );
}

/** Filter the available ops by substring. Throws when nothing matches. */
function filterOps(ops: OpEntry[], opFilter: string | undefined): OpEntry[] {
  if (!opFilter) {
    return ops;
  }
  const filtered = ops.filter((op) => op.label.includes(opFilter));
  if (filtered.length === 0) {
    throw new Error(
      `--op ${opFilter} matched no operations.\n  Available: ${ops.map((o) => o.label).join(", ")}`
    );
  }
  return filtered;
}

/** Run every op on every fixture and return the flattened entry list. */
async function runAll(
  fixtures: readonly FixtureHandle[],
  ops: readonly OpEntry[],
  args: CliArgs
): Promise<BenchEntry[]> {
  const entries: BenchEntry[] = [];
  for (const fx of fixtures) {
    if (!args.json) {
      console.log(`${fx.label}  (${fx.fileCount} files @ ${fx.rootDir})`);
    }
    await withBenchDb(async () => {
      for (const op of ops) {
        const samples = await measure(() => op.run(fx.rootDir), {
          runs: args.runs,
          warmup: args.warmup,
          beforeEach: op.setup ? () => op.setup?.(fx.rootDir) : undefined,
        });
        const stats = summarize(samples);
        entries.push({
          fixture: fx.label,
          operation: op.label,
          warm: op.warm,
          stats,
        });
        if (!args.json) {
          console.log(
            `  ${op.label.padEnd(24)}  p50 ${stats.p50.toFixed(2)}ms  p95 ${stats.p95.toFixed(2)}ms  (${stats.runs} runs)`
          );
        }
      }
    });
  }
  return entries;
}

/** Perform the --compare step. Returns false on regression. */
function compareAgainstBaseline(
  report: BenchReport,
  thresholdPct: number
): boolean {
  const baselinePath = ".bench/baseline.json";
  if (!existsSync(baselinePath)) {
    console.error(
      `✗ No baseline found at ${baselinePath}. Run with --save-baseline first.`
    );
    return false;
  }
  const baseline = JSON.parse(
    readFileSync(baselinePath, "utf8")
  ) as BenchReport;
  const rows = compareReports(baseline, report, thresholdPct);
  const ok = printComparison(rows, thresholdPct);
  if (!ok) {
    console.error("✗ One or more operations regressed beyond threshold");
    return false;
  }
  console.log("✓ No regressions beyond threshold");
  return true;
}

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`✗ ${(error as Error).message}`);
    printHelp();
    return 1;
  }

  // Silence CLI telemetry — we don't want bench runs filing Sentry events.
  process.env.SENTRY_CLI_NO_TELEMETRY = "1";

  let fixtures: FixtureHandle[];
  let ops: OpEntry[];
  try {
    fixtures = await resolveFixtures(args);
    const allOps = await buildOps();
    ops = filterOps(allOps, args.opFilter);
  } catch (error) {
    console.error(`✗ ${(error as Error).message}`);
    return 1;
  }

  const entries = await runAll(fixtures, ops, args);

  const report: BenchReport = {
    version: 1,
    generatedAt: new Date().toISOString(),
    runtime: runtimeInfo(),
    entries,
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printReport(report);
  }

  if (args.saveBaseline) {
    mkdirSync(".bench", { recursive: true });
    await writeJsonReport(report, ".bench/baseline.json");
    if (!args.json) {
      console.log("✓ Baseline written to .bench/baseline.json");
    }
  }

  if (args.compare && !compareAgainstBaseline(report, args.thresholdPct)) {
    return 1;
  }

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
