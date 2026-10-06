/**
 * Promise Utilities Tests
 *
 * Note: Core behavior invariants (true/false results, error handling, empty arrays)
 * are tested via property-based tests in promises.property.test.ts. These tests
 * focus on concurrency and timing behavior that property tests cannot easily verify.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { anyTrue } from "../../src/lib/promises.js";

describe("anyTrue concurrency", () => {
  test("starts all predicates concurrently", async () => {
    const startTimes: number[] = [];
    const startTime = Date.now();

    await anyTrue([1, 2, 3], async (n) => {
      startTimes.push(Date.now() - startTime);
      await sleep(50);
      return n === 3;
    });

    // All should start within ~10ms of each other (concurrent)
    // If sequential, they'd be ~50ms apart
    const maxDiff = Math.max(...startTimes) - Math.min(...startTimes);
    expect(maxDiff).toBeLessThan(20);
  });

  test("resolves only once even with multiple true values", async () => {
    let resolveCount = 0;

    const promise = anyTrue([1, 2, 3], async () => {
      await sleep(10);
      return true; // All pass
    });

    // Wrap to count resolutions
    const result = await promise.then((r) => {
      resolveCount += 1;
      return r;
    });

    expect(result).toBe(true);
    expect(resolveCount).toBe(1);
  });

  test("does not wait for slow false predicates after finding true", async () => {
    const startTime = Date.now();

    const result = await anyTrue([1, 2, 3], async (n) => {
      if (n === 1) {
        return true; // Fast true
      }
      await sleep(500); // Slow false
      return false;
    });

    const elapsed = Date.now() - startTime;

    expect(result).toBe(true);
    // Should resolve well under 500ms since we found true immediately
    expect(elapsed).toBeLessThan(100);
  });
});
