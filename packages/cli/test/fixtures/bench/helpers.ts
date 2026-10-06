/**
 * Bench harness helpers.
 *
 * Provides:
 *   - `measure()`:   timing primitive with warmup + run distribution
 *   - `summarize()`: statistics (p50, p95, min, max, mean, stddev)
 *   - `withBenchDb()`: one-shot SQLite cache isolation (scoped
 *     `SENTRY_CONFIG_DIR`, so bench runs never clobber the real user cache)
 *   - `clearDsnDetectionCache()`: tears down cached DSN + project-root rows
 *     between cold-cache measurements
 *   - `printReport()` / `writeJsonReport()`: structured human/JSON output
 *     mirroring `script/eval-skill.ts`'s reporter shape.
 *
 * All timing uses `performance.now()` — already the codebase convention
 * (see src/lib/complete.ts and src/lib/sentry-client.ts).
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { arch, cpus, platform, tmpdir } from "node:os";
import { join } from "node:path";

/** Statistics derived from an array of measurements. */
export type BenchStats = {
  runs: number;
  min: number;
  max: number;
  mean: number;
  stddev: number;
  p50: number;
  p95: number;
};

/** A single bench result entry, one row in the report. */
export type BenchEntry = {
  /** Fixture label (e.g., "synthetic/medium" or "real:/home/foo/repo"). */
  fixture: string;
  /** Operation label (e.g., "detectDsn.cold"). */
  operation: string;
  /** True for operations that should see a primed cache; false for cold runs. */
  warm: boolean;
  /** Timing statistics in milliseconds. */
  stats: BenchStats;
};

/** Full bench report — the JSON written to `.bench/baseline.json`. */
export type BenchReport = {
  /** Schema version. Bump on breaking change. */
  version: 1;
  /** When the run completed (ISO 8601). */
  generatedAt: string;
  /** Node/Bun runtime info for reproducibility context. */
  runtime: {
    bun: string;
    platform: string;
    arch: string;
    cpus: number;
  };
  /** Every timed operation, flattened. */
  entries: BenchEntry[];
};

/** Options for `measure()`. */
export type MeasureOptions = {
  /** Number of measured runs. Default: 10. */
  runs?: number;
  /** Warmup runs discarded before measurement. Default: 3. */
  warmup?: number;
  /**
   * Optional setup hook run before each measured iteration. Timing excludes
   * setup — use it to clear caches, rebuild state, etc.
   */
  beforeEach?: () => void | Promise<void>;
};

/**
 * Time an async function over `runs` iterations (plus `warmup`).
 *
 * Returns the list of sample times in milliseconds; feed into `summarize()`
 * for stats. The number of samples equals `runs`; warmup samples are
 * discarded entirely.
 */
export async function measure(
  fn: () => Promise<void> | void,
  options: MeasureOptions = {}
): Promise<number[]> {
  const runs = options.runs ?? 10;
  const warmup = options.warmup ?? 3;

  // Warmup: discard timings but still run setup so caches start cold the
  // same way the measured runs will.
  for (let i = 0; i < warmup; i++) {
    if (options.beforeEach) await options.beforeEach();
    await fn();
  }

  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    if (options.beforeEach) await options.beforeEach();
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  return samples;
}

/** Compute summary statistics from a sample array. Samples may be unsorted. */
export function summarize(samples: readonly number[]): BenchStats {
  if (samples.length === 0) {
    return { runs: 0, min: 0, max: 0, mean: 0, stddev: 0, p50: 0, p95: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const min = sorted[0] as number;
  const max = sorted[n - 1] as number;
  const mean = sorted.reduce((acc, x) => acc + x, 0) / n;
  // Population stddev — we're measuring the full sample, not inferring a population.
  const variance = sorted.reduce((acc, x) => acc + (x - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  return {
    runs: n,
    min,
    max,
    mean,
    stddev,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
  };
}

/** Nearest-rank percentile over a pre-sorted array. */
function percentile(sorted: readonly number[], p: number): number {
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1)
  );
  return sorted[idx] as number;
}

/**
 * Run `fn` with a scoped SQLite cache directory.
 *
 * Creates a fresh temp dir, points SENTRY_CONFIG_DIR at it, closes any
 * preexisting DB handle, runs `fn`, then restores the previous env value
 * and deletes the temp dir. Guarantees bench runs never touch the real
 * user cache even if the harness crashes (finally-block cleanup).
 */
export async function withBenchDb<T>(
  fn: (configDir: string) => Promise<T>
): Promise<T> {
  // Import lazily — importing `src/lib/db/index.js` has non-trivial side
  // effects (loads bun:sqlite, @sentry/node-core via createTracedDatabase).
  const { closeDatabase } = await import("../../../src/lib/db/index.js");

  const saved = process.env.SENTRY_CONFIG_DIR;
  mkdirSync(join(tmpdir(), "sentry-cli-bench"), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "sentry-cli-bench", "cfg-"));
  process.env.SENTRY_CONFIG_DIR = dir;
  closeDatabase();

  try {
    return await fn(dir);
  } finally {
    closeDatabase();
    if (saved === undefined) {
      // Follow the test/helpers.ts rule — never `delete process.env.SENTRY_CONFIG_DIR`
      // because other modules may read it. Set to an unreachable sentinel instead;
      // tests that care use `useTestConfigDir`. Bench is a one-shot process, so
      // either reassignment is fine — preserving the convention by setting to the
      // benchless baseline (empty string) would be wrong, so we just leave `dir`
      // in place. The process exits right after.
      process.env.SENTRY_CONFIG_DIR = dir;
    } else {
      process.env.SENTRY_CONFIG_DIR = saved;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
}

/**
 * Clear all cached DSN detection + project-root rows for a given project root.
 *
 * Between cold runs we need the DSN scanner to actually walk the fs, not hit
 * the cache. Clearing by directory avoids interfering with anything else in
 * the bench DB (though in practice the bench DB only contains bench rows).
 */
export async function clearDsnDetectionCache(
  projectRoot: string
): Promise<void> {
  const { clearDsnCache } = await import("../../../src/lib/db/dsn-cache.js");
  const { clearProjectRootCacheFor } = await import(
    "../../../src/lib/db/project-root-cache.js"
  );
  clearDsnCache(projectRoot);
  await clearProjectRootCacheFor(projectRoot);
}

/** Pretty-print a bench report to stdout in a fixed-width column layout. */
export function printReport(report: BenchReport): void {
  // Group entries by fixture so related operations read naturally.
  const byFixture = new Map<string, BenchEntry[]>();
  for (const entry of report.entries) {
    const list = byFixture.get(entry.fixture) ?? [];
    list.push(entry);
    byFixture.set(entry.fixture, list);
  }

  console.log("");
  console.log(
    `Bench report  (${report.runtime.platform}/${report.runtime.arch}, bun ${report.runtime.bun}, ${report.runtime.cpus} cpus)`
  );
  console.log("─".repeat(72));

  for (const [fixture, entries] of byFixture) {
    console.log(`\n${fixture}`);
    const longest = entries.reduce(
      (acc, e) => Math.max(acc, e.operation.length),
      0
    );
    for (const entry of entries) {
      const pad = entry.operation.padEnd(longest);
      const { p50, p95, runs } = entry.stats;
      console.log(
        `  ${pad}  p50 ${fmtMs(p50)}  p95 ${fmtMs(p95)}  (${runs} runs)`
      );
    }
  }
  console.log("");
}

/** Format milliseconds to a width-stable string (e.g., "  4.2ms"). */
function fmtMs(ms: number): string {
  if (ms < 10) return `${ms.toFixed(2)}ms`.padStart(7);
  if (ms < 100) return `${ms.toFixed(1)}ms`.padStart(7);
  return `${ms.toFixed(0)}ms`.padStart(7);
}

/** Write the report to `path` as indented JSON. */
export async function writeJsonReport(
  report: BenchReport,
  path: string
): Promise<void> {
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
}

/**
 * Compare a current report against a saved baseline and produce a diff summary.
 *
 * Diffs are matched by `(fixture, operation, warm)` tuples. Missing pairs on
 * either side are reported but don't fail the comparison. Threshold is the
 * maximum allowed p50 regression, expressed as a fraction (0.2 = 20%).
 */
export type ComparisonRow = {
  fixture: string;
  operation: string;
  baseline?: BenchStats;
  current?: BenchStats;
  deltaMs?: number;
  deltaPct?: number;
  verdict:
    | "ok"
    | "regressed"
    | "improved"
    | "missing-baseline"
    | "missing-current";
};

export function compareReports(
  baseline: BenchReport,
  current: BenchReport,
  thresholdPct: number
): ComparisonRow[] {
  const keys = new Set<string>();
  const index = new Map<string, BenchEntry>();
  for (const e of baseline.entries) {
    const key = benchKey(e);
    index.set(`b:${key}`, e);
    keys.add(key);
  }
  for (const e of current.entries) {
    const key = benchKey(e);
    index.set(`c:${key}`, e);
    keys.add(key);
  }

  const rows: ComparisonRow[] = [];
  for (const key of [...keys].sort()) {
    const b = index.get(`b:${key}`);
    const c = index.get(`c:${key}`);
    const [fixture, operation] = key.split("||");
    if (!b) {
      rows.push({
        fixture: fixture as string,
        operation: operation as string,
        current: c?.stats,
        verdict: "missing-baseline",
      });
      continue;
    }
    if (!c) {
      rows.push({
        fixture: fixture as string,
        operation: operation as string,
        baseline: b.stats,
        verdict: "missing-current",
      });
      continue;
    }
    const deltaMs = c.stats.p50 - b.stats.p50;
    const deltaPct = b.stats.p50 > 0 ? deltaMs / b.stats.p50 : 0;
    let verdict: ComparisonRow["verdict"] = "ok";
    if (deltaPct > thresholdPct) verdict = "regressed";
    else if (deltaPct < -thresholdPct) verdict = "improved";
    rows.push({
      fixture: fixture as string,
      operation: operation as string,
      baseline: b.stats,
      current: c.stats,
      deltaMs,
      deltaPct,
      verdict,
    });
  }
  return rows;
}

function benchKey(e: BenchEntry): string {
  return `${e.fixture}||${e.operation}`;
}

/** Single-character status icon per verdict. */
const VERDICT_ICONS: Record<ComparisonRow["verdict"], string> = {
  regressed: "✗",
  improved: "↓",
  ok: "✓",
  "missing-baseline": "·",
  "missing-current": "·",
};

/** Format one comparison row as a display line. */
function formatComparisonRow(
  r: ComparisonRow,
  widthFixture: number,
  widthOp: number
): string {
  const base = r.baseline ? fmtMs(r.baseline.p50) : "—".padStart(7);
  const cur = r.current ? fmtMs(r.current.p50) : "—".padStart(7);
  const dms = r.deltaMs === undefined ? "—" : r.deltaMs.toFixed(2);
  const dpct =
    r.deltaPct === undefined ? "—" : `${(r.deltaPct * 100).toFixed(1)}%`;
  const icon = VERDICT_ICONS[r.verdict];
  return `${r.fixture.padEnd(widthFixture)}  ${r.operation.padEnd(widthOp)}  ${base.padStart(10)}  ${cur.padStart(10)}  ${dms.padStart(9)}  ${dpct.padStart(7)}  ${icon} ${r.verdict}`;
}

/** Render comparison rows to stdout. Returns true when no regressions. */
export function printComparison(
  rows: readonly ComparisonRow[],
  thresholdPct: number
): boolean {
  const widthFixture = rows.reduce(
    (acc, r) => Math.max(acc, r.fixture.length),
    8
  );
  const widthOp = rows.reduce((acc, r) => Math.max(acc, r.operation.length), 9);
  console.log("");
  console.log(
    `Comparison vs baseline  (threshold ±${(thresholdPct * 100).toFixed(0)}%)`
  );
  console.log("─".repeat(72));
  console.log(
    `${"fixture".padEnd(widthFixture)}  ${"operation".padEnd(widthOp)}  ${"base p50".padStart(10)}  ${"cur p50".padStart(10)}  ${"Δms".padStart(9)}  ${"Δ%".padStart(7)}  verdict`
  );
  let ok = true;
  for (const r of rows) {
    console.log(formatComparisonRow(r, widthFixture, widthOp));
    if (r.verdict === "regressed") {
      ok = false;
    }
  }
  console.log("");
  return ok;
}

/** Runtime version info. */
export function runtimeInfo(): BenchReport["runtime"] {
  return {
    bun: process.version,
    platform: platform(),
    arch: arch(),
    cpus: cpus().length,
  };
}
