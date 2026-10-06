/**
 * Property-Based Tests for Promise Utilities
 *
 * Uses fast-check to verify invariants of anyTrue() that are difficult
 * to exhaustively test with example-based tests.
 */

import { setTimeout as sleep } from "node:timers/promises";
import {
  array,
  asyncProperty,
  boolean,
  assert as fcAssert,
  integer,
  nat,
} from "fast-check";
import { describe, expect, test } from "vitest";
import { anyTrue } from "../../src/lib/promises.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

describe("anyTrue properties", () => {
  test("returns true if and only if at least one predicate returns true", async () => {
    await fcAssert(
      asyncProperty(
        array(boolean(), { minLength: 0, maxLength: 20 }),
        async (results) => {
          const items = results.map((_, i) => i);
          const expectedResult = results.includes(true);

          const actualResult = await anyTrue(items, async (i) => results[i]);

          expect(actualResult).toBe(expectedResult);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("empty array always returns false regardless of predicate", async () => {
    await fcAssert(
      asyncProperty(boolean(), async (predicateResult) => {
        const result = await anyTrue([], async () => predicateResult);
        expect(result).toBe(false);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("single-element array result equals predicate result", async () => {
    await fcAssert(
      asyncProperty(boolean(), async (predicateResult) => {
        const result = await anyTrue([1], async () => predicateResult);
        expect(result).toBe(predicateResult);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("errors in predicates are treated as false", async () => {
    await fcAssert(
      asyncProperty(
        integer({ min: 0, max: 10 }), // errorIndex
        integer({ min: 0, max: 10 }), // trueIndex
        integer({ min: 3, max: 15 }), // arrayLength
        async (errorIndex, trueIndex, arrayLength) => {
          const items = Array.from({ length: arrayLength }, (_, i) => i);

          const result = await anyTrue(items, async (i) => {
            if (i === errorIndex % arrayLength) {
              throw new Error("Test error");
            }
            return i === trueIndex % arrayLength;
          });

          // Result should be true if trueIndex exists and isn't the error index
          const expectedTrue =
            trueIndex % arrayLength !== errorIndex % arrayLength;
          expect(result).toBe(expectedTrue);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("all predicates throwing returns false", async () => {
    await fcAssert(
      asyncProperty(integer({ min: 1, max: 10 }), async (arrayLength) => {
        const items = Array.from({ length: arrayLength }, (_, i) => i);

        const result = await anyTrue(items, async () => {
          throw new Error("Test error");
        });

        expect(result).toBe(false);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("result does not depend on predicate completion order", async () => {
    await fcAssert(
      asyncProperty(
        array(nat(50), { minLength: 2, maxLength: 10 }), // delays
        integer({ min: 0, max: 9 }), // trueIndex
        async (delays, trueIndex) => {
          const items = delays.map((_, i) => i);
          const actualTrueIndex = trueIndex % items.length;

          // Run with different delays
          const result = await anyTrue(items, async (i) => {
            await sleep(delays[i] ?? 0);
            return i === actualTrueIndex;
          });

          expect(result).toBe(true);
        }
      ),
      { numRuns: Math.min(DEFAULT_NUM_RUNS, 20) } // Fewer runs since we use delays
    );
  });

  test("all false predicates return false regardless of timing", async () => {
    await fcAssert(
      asyncProperty(
        array(nat(20), { minLength: 1, maxLength: 5 }), // delays
        async (delays) => {
          const items = delays.map((_, i) => i);

          const result = await anyTrue(items, async (i) => {
            await sleep(delays[i] ?? 0);
            return false; // All false
          });

          expect(result).toBe(false);
        }
      ),
      { numRuns: Math.min(DEFAULT_NUM_RUNS, 20) }
    );
  });

  test("predicate is called for each item at least once (when no early true)", async () => {
    await fcAssert(
      asyncProperty(integer({ min: 1, max: 10 }), async (arrayLength) => {
        const items = Array.from({ length: arrayLength }, (_, i) => i);
        const called = new Set<number>();

        await anyTrue(items, async (i) => {
          called.add(i);
          return false; // All false, so all must be checked
        });

        // All items should have been checked
        expect(called.size).toBe(arrayLength);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
