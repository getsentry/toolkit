/**
 * Unit tests for the byte-driven upgrade progress reporter.
 *
 * The reporter is cosmetic-only and must never abort the operation it
 * decorates. It feeds a `setMessage` callback (the surrounding withProgress
 * spinner) rather than drawing its own bar, so there's no second in-place
 * redraw competing with the spinner.
 *
 * Coverage: determinate vs indeterminate formatting, byte accumulation,
 * full-bar clamping, update throttling, a final un-throttled done() emit, the
 * no-op path when no setMessage is provided, the never-throws contract, and
 * the `format: "pct"` mode that suppresses the inflated byte counter for
 * multi-hop patch chains.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { makeByteProgress } from "../../src/lib/progress.js";

describe("makeByteProgress", () => {
  test("formats a determinate bar with size and percent", () => {
    const msgs: string[] = [];
    let now = 0;
    const p = makeByteProgress(
      "Applying 3 patch(es)",
      1000,
      (m) => msgs.push(m),
      {
        nowMs: () => now,
      }
    );
    p.onProgress(500); // first call: now=0, lastEmit=0 → throttled (0-0 < 100)
    now = 200;
    p.onProgress(500); // now past throttle → emits at 1000/1000
    const last = msgs.at(-1) ?? "";
    expect(last).toContain("Applying 3 patch(es)");
    expect(last).toContain("1000 B / 1000 B");
    expect(last).toContain("100%");
    expect(last).toContain("█".repeat(16));
  });

  test("formats an indeterminate byte counter when total is null", () => {
    const msgs: string[] = [];
    let now = 0;
    const p = makeByteProgress("Downloading", null, (m) => msgs.push(m), {
      nowMs: () => now,
    });
    now = 200;
    p.onProgress(2048);
    const last = msgs.at(-1) ?? "";
    expect(last).toContain("Downloading");
    expect(last).toContain("2.0 KB");
    expect(last).not.toContain("░"); // no bar in indeterminate mode
  });

  test("accumulates bytes across calls and clamps the bar at full", () => {
    const msgs: string[] = [];
    let now = 0;
    const p = makeByteProgress("Applying", 100, (m) => msgs.push(m), {
      nowMs: () => now,
    });
    p.onProgress(50);
    now = 500;
    p.onProgress(9000); // way over total → clamp to 100%
    const last = msgs.at(-1) ?? "";
    expect(last).toContain("100%");
    expect(last).toContain("█".repeat(16));
    expect(last).not.toContain("░");
  });

  test("throttles updates so a fast byte stream doesn't spam the spinner", () => {
    const set = vi.fn();
    const now = 1000;
    const p = makeByteProgress("Applying", 1000, set, { nowMs: () => now });
    // Many calls within the same throttle window → at most one emit.
    for (let i = 0; i < 50; i += 1) {
      p.onProgress(10);
    }
    expect(set.mock.calls.length).toBeLessThanOrEqual(1);
  });

  test("done() emits a final, un-throttled message reflecting the total", () => {
    const set = vi.fn();
    const now = 0;
    const p = makeByteProgress("Applying", 100, set, { nowMs: () => now });
    p.onProgress(100); // throttled (now-0 < 100), no emit yet
    set.mockClear();
    p.done(); // must emit regardless of throttle
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0]?.[0]).toContain("100%");
  });

  test("is a no-op when no setMessage is provided (JSON/non-TTY)", () => {
    // Nothing to assert beyond: it must not throw and must still track bytes
    // so a later done() with a setMessage-less reporter is harmless.
    const p = makeByteProgress("Applying", 100, undefined);
    expect(() => {
      p.onProgress(50);
      p.done();
    }).not.toThrow();
  });

  test("never throws even if setMessage throws", () => {
    const p = makeByteProgress(
      "Applying",
      100,
      () => {
        throw new Error("boom");
      },
      { nowMs: () => 1000 }
    );
    expect(() => {
      p.onProgress(100);
      p.done();
    }).not.toThrow();
  });

  test("renders percentage only when format='pct' (apply bar suppresses GB scare)", () => {
    // Multi-hop chains sum newSize across hops, so event.total can far
    // exceed the final binary size (e.g. 930 MB for a 3-hop 310 MB chain).
    // The apply bar should show only percentage in that case so users
    // don't see "applied 1.5 GB / 3.1 GB" for what ends up being a
    // 310 MB install.
    const msgs: string[] = [];
    let now = 0;
    const p = makeByteProgress(
      "Applying 3 patch(es)",
      930 * 1024 * 1024,
      (m) => msgs.push(m),
      { format: "pct", nowMs: () => now }
    );
    now = 200;
    p.onProgress(310 * 1024 * 1024); // 33%
    now = 400;
    p.onProgress(310 * 1024 * 1024); // 66%
    now = 600;
    p.onProgress(310 * 1024 * 1024); // 100%
    p.done();

    const last = msgs.at(-1) ?? "";
    expect(last).toContain("Applying 3 patch(es)");
    expect(last).toMatch(/\[█+░*\] 100%/);
    // No byte count in pct mode
    expect(last).not.toMatch(/\d+\s*(B|KB|MB|GB|TB)/);
    expect(last).not.toContain("/");
  });

  test("format='pct' is ignored for indeterminate (null total) byte counters", () => {
    // Indeterminate bars have no meaningful percentage — they always show
    // the live byte total regardless of the format option.
    const msgs: string[] = [];
    let now = 0;
    const p = makeByteProgress("Downloading", null, (m) => msgs.push(m), {
      format: "pct",
      nowMs: () => now,
    });
    now = 200;
    p.onProgress(2048);
    const last = msgs.at(-1) ?? "";
    expect(last).toContain("Downloading");
    expect(last).toContain("2.0 KB");
    expect(last).not.toContain("%");
  });

  test("apply bar call site passes 'pct' format (regression: multi-hop GB scare)", () => {
    // Regression: delta-upgrade.ts apply bar previously called
    // makeByteProgress(label, total, setMessage) without passing format, so
    // the bar fell back to bytes mode and the "pct only" UX never applied.
    // Reads the source to assert the apply-phase call site actually wires
    // "pct", so a future regression to bytes mode is caught even if the
    // helper itself still defaults to "bytes".
    const src = readFileSync(
      join(__dirname, "../../src/lib/delta-upgrade.ts"),
      "utf8"
    );
    // Find the makeByteProgress call inside the apply bar branch by scanning
    // for balanced parentheses, so nested calls like
    // makeByteProgress("label", computeTotal()) still match. Regex-based
    // extraction breaks on nested parens, which a real refactor could
    // easily introduce.
    const matches = extractCalls(src, "makeByteProgress");
    const applyCall = matches.find((m) => m.includes("isApply"));
    expect(applyCall).toBeDefined();
    expect(applyCall).toMatch(/["']pct["']/);
  });
});

/**
 * Walk a source string and return every `name(`...`)` call as a string slice.
 * Uses a balanced-parentheses scan rather than a regex so nested calls like
 * `makeByteProgress("label", computeTotal())` still extract cleanly.
 */
function extractCalls(source: string, name: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    const found = source.indexOf(name, i);
    if (found === -1) {
      break;
    }
    const open = source.indexOf("(", found);
    if (open === -1) {
      break;
    }
    let depth = 1;
    let j = open + 1;
    while (j < source.length && depth > 0) {
      const ch = source[j];
      if (ch === "(") {
        depth += 1;
      } else if (ch === ")") {
        depth -= 1;
      }
      if (depth > 0) {
        j += 1;
      }
    }
    if (depth === 0) {
      out.push(source.slice(found, j + 1));
      i = j + 1;
    } else {
      break; // unbalanced, stop scanning
    }
  }
  return out;
}
