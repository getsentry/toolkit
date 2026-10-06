/**
 * Unit tests for the bench harness statistics + comparison code.
 *
 * We intentionally don't test `withBenchDb` or the production-code ops
 * here — those go through full DSN detection and run in `script/bench.ts`
 * under realistic conditions. This file only covers the pure-math bits
 * where we actually have deterministic inputs to assert against.
 */

import { describe, expect, test } from "vitest";
import {
  type BenchReport,
  compareReports,
  measure,
  summarize,
} from "../../fixtures/bench/helpers.js";

describe("summarize", () => {
  test("computes p50 and p95 via nearest-rank on sorted samples", () => {
    const stats = summarize([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(stats.runs).toBe(10);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(10);
    expect(stats.mean).toBe(5.5);
    // nearest-rank p50 = ceil(0.5 * 10) = 5 → sorted[4] = 5
    expect(stats.p50).toBe(5);
    // nearest-rank p95 = ceil(0.95 * 10) = 10 → sorted[9] = 10
    expect(stats.p95).toBe(10);
  });

  test("handles single-sample input", () => {
    const stats = summarize([42]);
    expect(stats.runs).toBe(1);
    expect(stats.min).toBe(42);
    expect(stats.max).toBe(42);
    expect(stats.p50).toBe(42);
    expect(stats.p95).toBe(42);
    expect(stats.stddev).toBe(0);
  });

  test("returns zero-valued stats for empty input", () => {
    const stats = summarize([]);
    expect(stats).toEqual({
      runs: 0,
      min: 0,
      max: 0,
      mean: 0,
      stddev: 0,
      p50: 0,
      p95: 0,
    });
  });

  test("stddev is zero for a uniform sample", () => {
    const stats = summarize([5, 5, 5, 5, 5]);
    expect(stats.stddev).toBe(0);
  });

  test("accepts unsorted input", () => {
    const a = summarize([3, 1, 4, 1, 5, 9, 2, 6, 5, 3]);
    const b = summarize([1, 1, 2, 3, 3, 4, 5, 5, 6, 9]);
    expect(a).toEqual(b);
  });
});

describe("measure", () => {
  test("runs the function the requested number of times", async () => {
    let calls = 0;
    const samples = await measure(
      () => {
        calls += 1;
      },
      { runs: 5, warmup: 2 }
    );
    // 2 warmup + 5 measured = 7 total calls; 5 reported samples.
    expect(calls).toBe(7);
    expect(samples.length).toBe(5);
    for (const s of samples) {
      expect(s).toBeGreaterThanOrEqual(0);
    }
  });

  test("runs beforeEach before each iteration (warmup + measured)", async () => {
    const calls: string[] = [];
    await measure(
      () => {
        calls.push("run");
      },
      {
        runs: 3,
        warmup: 1,
        beforeEach: () => {
          calls.push("setup");
        },
      }
    );
    // expected: setup, run, setup, run, setup, run, setup, run
    expect(calls).toEqual([
      "setup",
      "run",
      "setup",
      "run",
      "setup",
      "run",
      "setup",
      "run",
    ]);
  });

  test("awaits async beforeEach and run hooks", async () => {
    const order: string[] = [];
    await measure(
      async () => {
        order.push("run-start");
        await new Promise((r) => setTimeout(r, 1));
        order.push("run-end");
      },
      {
        runs: 1,
        warmup: 0,
        beforeEach: async () => {
          order.push("setup-start");
          await new Promise((r) => setTimeout(r, 1));
          order.push("setup-end");
        },
      }
    );
    expect(order).toEqual(["setup-start", "setup-end", "run-start", "run-end"]);
  });
});

describe("compareReports", () => {
  const baseline: BenchReport = {
    version: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    runtime: { bun: "1.3.13", platform: "linux", arch: "x64", cpus: 8 },
    entries: [
      {
        fixture: "synthetic/small",
        operation: "detectDsn.cold",
        warm: false,
        stats: {
          runs: 10,
          min: 9,
          max: 12,
          mean: 10,
          stddev: 1,
          p50: 10,
          p95: 12,
        },
      },
      {
        fixture: "synthetic/small",
        operation: "detectDsn.warm",
        warm: true,
        stats: {
          runs: 10,
          min: 0.5,
          max: 1.2,
          mean: 1,
          stddev: 0.2,
          p50: 1,
          p95: 1.2,
        },
      },
    ],
  };

  test("flags regressions above threshold", () => {
    const current: BenchReport = {
      ...baseline,
      entries: [
        {
          ...baseline.entries[0]!,
          stats: { ...baseline.entries[0]!.stats, p50: 15 },
        },
        baseline.entries[1]!,
      ],
    };
    const rows = compareReports(baseline, current, 0.2);
    const cold = rows.find((r) => r.operation === "detectDsn.cold");
    expect(cold?.verdict).toBe("regressed");
    expect(cold?.deltaMs).toBe(5);
    expect(cold?.deltaPct).toBeCloseTo(0.5, 5);
  });

  test("flags improvements below negative threshold", () => {
    const current: BenchReport = {
      ...baseline,
      entries: [
        {
          ...baseline.entries[0]!,
          stats: { ...baseline.entries[0]!.stats, p50: 7 },
        },
        baseline.entries[1]!,
      ],
    };
    const rows = compareReports(baseline, current, 0.2);
    const cold = rows.find((r) => r.operation === "detectDsn.cold");
    expect(cold?.verdict).toBe("improved");
  });

  test("reports missing current entry when op disappears", () => {
    const current: BenchReport = {
      ...baseline,
      entries: [baseline.entries[1]!],
    };
    const rows = compareReports(baseline, current, 0.2);
    const cold = rows.find((r) => r.operation === "detectDsn.cold");
    expect(cold?.verdict).toBe("missing-current");
  });

  test("reports missing baseline entry when op is new", () => {
    const current: BenchReport = {
      ...baseline,
      entries: [
        ...baseline.entries,
        {
          fixture: "synthetic/small",
          operation: "scan.grepFiles",
          warm: false,
          stats: {
            runs: 10,
            min: 1,
            max: 2,
            mean: 1.5,
            stddev: 0.2,
            p50: 1.5,
            p95: 2,
          },
        },
      ],
    };
    const rows = compareReports(baseline, current, 0.2);
    const grep = rows.find((r) => r.operation === "scan.grepFiles");
    expect(grep?.verdict).toBe("missing-baseline");
  });
});
