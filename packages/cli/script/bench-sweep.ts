#!/usr/bin/env tsx
/**
 * Concurrency sweep for `src/lib/scan/` hot paths.
 *
 * Goal: measure how the walker + grep scale with `concurrency` on
 * the synthetic bench fixtures, so we can pick a data-driven default
 * for `CONCURRENCY_LIMIT`.
 *
 * The main bench harness (`script/bench.ts`) uses a fixed concurrency
 * inherited from the DSN scanner. This script is a one-shot
 * diagnostic run by contributors when tuning perf — it's not wired
 * into CI.
 *
 * Usage:
 *   pnpm run bench:sweep                          # full sweep on medium+large
 *   pnpm run bench:sweep -- --size small           # one preset
 *   pnpm run bench:sweep -- --values 1,2,4,8,16,32 # custom concurrency grid
 *   pnpm run bench:sweep -- --runs 10 --warmup 3   # override run counts
 *   pnpm run bench:sweep -- --json > sweep.json    # machine-readable
 *
 * Output: a per-(fixture, op) table of p50 times across the
 * concurrency grid, plus a "knee" annotation flagging the value
 * past which additional parallelism yields < 3% improvement.
 */

import { existsSync, mkdirSync } from "node:fs";
import { arch, availableParallelism, cpus, platform, tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FixtureSpec,
  generateFixture,
  hashSpec,
} from "../test/fixtures/bench/generate.js";
import {
  measure,
  summarize,
  withBenchDb,
} from "../test/fixtures/bench/helpers.js";
import {
  PRESET_NAMES,
  PRESETS,
  type PresetName,
} from "../test/fixtures/bench/presets.js";

/** Default concurrency values we sweep across. */
const DEFAULT_VALUES = [1, 2, 4, 8, 16, 32, 50, 100, 200] as const;

/** Default fixture sizes we sweep on. `small` rarely shows signal. */
const DEFAULT_SIZES: readonly PresetName[] = ["medium", "large"];

/**
 * DSN scanner hot regex — reused by the `scan.grepFiles` op. Kept at
 * module scope to satisfy Biome's `useTopLevelRegex` rule.
 */
const DSN_PATTERN =
  /https?:\/\/[a-z0-9]+(?::[a-z0-9]+)?@[a-z0-9.-]+(?:\.[a-z]+|:[0-9]+)\/\d+/i;

type SweepArgs = {
  sizes: readonly PresetName[];
  values: readonly number[];
  runs: number;
  warmup: number;
  json: boolean;
  kneeThresholdPct: number;
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: CLI flag switch is inherently branchy
function parseArgs(argv: readonly string[]): SweepArgs {
  const sizes: PresetName[] = [...DEFAULT_SIZES];
  let values: number[] = [...DEFAULT_VALUES];
  let runs = 5;
  let warmup = 2;
  let json = false;
  const kneeThresholdPct = 0.03; // 3%

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const next = argv[i + 1];
    switch (arg) {
      case "--size": {
        if (!next) {
          throw new Error("--size requires a value");
        }
        if (next === "all") {
          sizes.length = 0;
          sizes.push(...PRESET_NAMES);
        } else if ((PRESET_NAMES as readonly string[]).includes(next)) {
          sizes.length = 0;
          sizes.push(next as PresetName);
        } else {
          throw new Error(
            `Unknown size '${next}'. Valid: ${PRESET_NAMES.join(", ")}, all`
          );
        }
        i += 1;
        break;
      }
      case "--values": {
        if (!next) {
          throw new Error("--values requires a comma-separated list");
        }
        values = next
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n) && n > 0);
        if (values.length === 0) {
          throw new Error("--values must contain at least one positive number");
        }
        i += 1;
        break;
      }
      case "--runs": {
        if (!next) {
          throw new Error("--runs requires a number");
        }
        runs = Number(next);
        i += 1;
        break;
      }
      case "--warmup": {
        if (!next) {
          throw new Error("--warmup requires a number");
        }
        warmup = Number(next);
        i += 1;
        break;
      }
      case "--json": {
        json = true;
        break;
      }
      case "-h":
      case "--help": {
        printHelp();
        process.exit(0);
        break;
      }
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }

  return { sizes, values, runs, warmup, json, kneeThresholdPct };
}

function printHelp(): void {
  console.log("Usage: pnpm run bench:sweep [-- --size small|medium|large|all]");
  console.log("                             [--values 1,2,4,8,...]");
  console.log("                             [--runs N] [--warmup N]");
  console.log("                             [--json]");
}

/** Resolve (or create) a synthetic fixture, same as bench.ts. */
function resolveFixture(name: PresetName): { label: string; rootDir: string } {
  const preset = PRESETS[name];
  // biome-ignore lint/suspicious/noBitwiseOperators: deterministic seed mix
  const seed = (0xde_ad_be_ef ^ hashStr(name)) >>> 0;
  const spec: FixtureSpec = {
    ...preset,
    seed,
    rootDir: "",
  };
  const { rootDir: _unused, ...specNoRoot } = spec;
  const hash = hashSpec(specNoRoot);
  const rootDir = join(tmpdir(), "sentry-cli-bench", `fx-${name}-${hash}`);
  mkdirSync(rootDir, { recursive: true });
  generateFixture({ ...spec, rootDir });
  return { label: `synthetic/${name}`, rootDir };
}

/** Cheap 32-bit FNV-1a over a short string — same as bench.ts. */
// biome-ignore-start lint/suspicious/noBitwiseOperators: FNV-1a is a bitwise hash
function hashStr(s: string): number {
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < s.length; i += 1) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01_00_01_93);
  }
  return h >>> 0;
}
// biome-ignore-end lint/suspicious/noBitwiseOperators: FNV-1a is a bitwise hash

/**
 * Single op × concurrency → p50 in ms. Returns NaN when the op
 * throws or the fixture doesn't exist.
 */
type SweepResult = {
  fixture: string;
  operation: string;
  concurrency: number;
  p50: number;
  p95: number;
  runs: number;
};

/**
 * Sweepable ops. Only ops that accept a `concurrency` override are
 * included — the walker itself is sequential, so sweeping
 * `scan.walk` would produce identical numbers across the grid.
 *
 * `scan.grepFiles` is the closest shape to `scanCodeForDsns` (walker
 * + per-file read + regex). The knee we find here should transfer to
 * the DSN scanner once we update `CONCURRENCY_LIMIT`.
 */
async function buildOps(): Promise<
  Array<{
    label: string;
    run: (cwd: string, concurrency: number) => Promise<void>;
    setup?: (cwd: string) => Promise<void>;
  }>
> {
  const { collectGrep } = await import("../src/lib/scan/index.js");
  const { dsnScanOptions } = await import("../src/lib/dsn/scan-options.js");

  return [
    {
      label: "scan.grepFiles",
      run: async (cwd, concurrency) => {
        await collectGrep({
          cwd,
          pattern: DSN_PATTERN,
          ...dsnScanOptions(),
          concurrency,
        });
      },
    },
  ];
}

async function runSweep(args: SweepArgs): Promise<SweepResult[]> {
  const fixtures = args.sizes.map(resolveFixture);
  const ops = await buildOps();
  const results: SweepResult[] = [];

  // Silence CLI telemetry — we don't want Sentry events from bench runs.
  process.env.SENTRY_CLI_NO_TELEMETRY = "1";

  for (const fx of fixtures) {
    if (!existsSync(fx.rootDir)) {
      if (!args.json) {
        console.error(`✗ fixture missing: ${fx.rootDir}`);
      }
      continue;
    }
    if (!args.json) {
      console.log(`\n${fx.label}  (${fx.rootDir})`);
    }
    await withBenchDb(async () => {
      await sweepFixture(fx, ops, args, results);
    });
  }

  return results;
}

/** Inner loop body extracted to keep `runSweep`'s arity + complexity low. */
async function sweepFixture(
  fx: { label: string; rootDir: string },
  ops: Awaited<ReturnType<typeof buildOps>>,
  args: SweepArgs,
  results: SweepResult[]
): Promise<void> {
  for (const op of ops) {
    for (const concurrency of args.values) {
      const samples = await measure(() => op.run(fx.rootDir, concurrency), {
        runs: args.runs,
        warmup: args.warmup,
        beforeEach: op.setup ? () => op.setup?.(fx.rootDir) : undefined,
      });
      const stats = summarize(samples);
      results.push({
        fixture: fx.label,
        operation: op.label,
        concurrency,
        p50: stats.p50,
        p95: stats.p95,
        runs: stats.runs,
      });
      if (!args.json) {
        console.log(
          `  ${op.label.padEnd(24)}  conc=${String(concurrency).padStart(3)}  p50 ${stats.p50.toFixed(1).padStart(6)}ms  p95 ${stats.p95.toFixed(1).padStart(6)}ms`
        );
      }
    }
  }
}

/**
 * Given sorted-by-concurrency results for one (fixture, op), return
 * the smallest concurrency value past which increasing concurrency
 * yields < `thresholdPct` improvement in p50.
 */
function findKnee(
  entries: readonly SweepResult[],
  thresholdPct: number
): number | null {
  const sorted = [...entries].sort((a, b) => a.concurrency - b.concurrency);
  let bestP50 = Number.POSITIVE_INFINITY;
  let kneeAt: number | null = null;
  for (const e of sorted) {
    const improvementRatio = (bestP50 - e.p50) / bestP50;
    if (
      !Number.isFinite(improvementRatio) ||
      improvementRatio >= thresholdPct
    ) {
      bestP50 = Math.min(bestP50, e.p50);
      kneeAt = e.concurrency;
    } else {
      // Stop improving. Previous kneeAt is our answer.
      break;
    }
  }
  return kneeAt;
}

/** Render the per-(fixture, op) knee table. */
function printKnees(
  results: readonly SweepResult[],
  thresholdPct: number
): void {
  const byKey = new Map<string, SweepResult[]>();
  for (const r of results) {
    const key = `${r.fixture}||${r.operation}`;
    const list = byKey.get(key) ?? [];
    list.push(r);
    byKey.set(key, list);
  }
  console.log("");
  console.log(
    `Knee analysis (smallest concurrency past which each additional step gains < ${(thresholdPct * 100).toFixed(0)}%)`
  );
  console.log("─".repeat(72));
  for (const [key, entries] of byKey) {
    const [fixture, operation] = key.split("||");
    const knee = findKnee(entries, thresholdPct);
    const minP50 = Math.min(...entries.map((e) => e.p50));
    console.log(
      `  ${String(fixture).padEnd(20)}  ${String(operation).padEnd(24)}  knee = ${knee ?? "?"} (best p50 ${minP50.toFixed(1)}ms)`
    );
  }
  console.log("");
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const results = await runSweep(args);

  if (args.json) {
    const report = {
      generatedAt: new Date().toISOString(),
      runtime: {
        platform: platform(),
        arch: arch(),
        cpus: cpus().length,
        availableParallelism: availableParallelism(),
      },
      kneeThresholdPct: args.kneeThresholdPct,
      results,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log(
      `\nsystem: ${platform()}/${arch()}, availableParallelism=${availableParallelism()}`
    );
    printKnees(results, args.kneeThresholdPct);
  }

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
